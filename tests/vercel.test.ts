import { vercelPolicy } from '../src/browser/policy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import {
  changeState,
  readState,
  emptyState,
  requestLoginCancel,
  queueLoginInput,
  blobBackend,
  type State,
  type StateBackend,
} from '../src/vercel/state.js';
import { renderHtml } from '../src/ui.js';
import { vercelApp as createVercelApp, scheduledPoll } from '../src/vercel/app.js';
import { SafeError } from '../src/types.js';
import { BrowserService } from '../src/browser/service.js';
import { config } from '../src/config.js';
import { sqlite } from '../src/node.js';
import { Store } from '../src/store.js';
import { readFileSync } from 'node:fs';
import { schema } from '../src/vercel/schema.js';
import { chromium, type Browser } from 'playwright-core';
import { unseal, seal } from '../src/crypto.js';
import { BlobPreconditionFailedError, type put } from '@vercel/blob';
import { flush } from '../src/notify.js';
import { parseLoginInput, applyLoginInput } from '../src/browser/input.js';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';

// Legacy Chromium contracts remain covered independently of the hybrid flow.
const vercelApp = (...args: Parameters<typeof createVercelApp>) =>
  createVercelApp(args[0], args[1], args[2], { ...args[3], policy: vercelPolicy });

const env = { ADMIN_TOKEN: 'a'.repeat(40), AUTH_SECRET: 'b'.repeat(40) };
function backend() {
  let saved: State | null = null,
    revision = 0;
  const api: StateBackend = {
    async read() {
      return {
        state: structuredClone(saved ?? emptyState()),
        etag: revision ? String(revision) : null,
      };
    },
    async write(state, etag) {
      if (etag !== (revision ? String(revision) : null)) throw new SafeError('BUSY', '冲突');
      saved = structuredClone(state);
      return String(++revision);
    },
  };
  return api;
}
test('私有状态拒绝并发更新，任务异常仍保存退避和待发记录', async () => {
  const b = backend();
  await changeState(b, async (s) => {
    await s.set('settings', JSON.stringify({ mode: 'notify', interval: 3600 }));
    await assert.rejects(
      changeState(b, async () => {}),
      /正在运行/,
    );
    assert.equal(await readState(b, async (_s, busy) => busy), true);
  });
  await assert.rejects(
    changeState(b, async (s) => {
      await s.set('error', 'expected');
      throw Error('task failed');
    }),
    /task failed/,
  );
  assert.equal(await readState(b, (s) => s.get('error')), 'expected');
  assert.equal(await readState(b, async (_s, busy) => busy), false);
});
test('大状态下载不使用压缩弱 ETag，条件写与后续保存仍成功', async () => {
  const state = emptyState();
  state.rows.kv.push({ key: 'large', value: 'x'.repeat(2000) });
  let wire = await seal(state, env.AUTH_SECRET),
    version = 1,
    writes = 0;
  const io: NonNullable<Parameters<typeof blobBackend>[2]> = {
    async get(_path, options) {
      const identity = new Headers(options.headers).get('Accept-Encoding') === 'identity';
      return {
        statusCode: 200,
        stream: new Blob([wire]).stream(),
        headers: new Headers(),
        blob: {
          url: '',
          downloadUrl: '',
          pathname: 'fixture',
          contentType: 'application/octet-stream',
          contentDisposition: '',
          cacheControl: '',
          size: wire.length,
          uploadedAt: new Date(),
          etag: (identity ? '' : 'W/') + '"v' + version + '"',
        },
      };
    },
    put: (async (_path, body, options) => {
      if (options.ifMatch !== '"v' + version + '"') throw new BlobPreconditionFailedError();
      assert.equal(typeof body, 'string');
      wire = String(body);
      writes++;
      version++;
      return {
        url: '',
        downloadUrl: '',
        pathname: 'fixture',
        contentType: 'application/octet-stream',
        contentDisposition: '',
        etag: '"v' + version + '"',
      };
    }) as typeof put,
  };
  const b = blobBackend(env.AUTH_SECRET, 'fixture', io);
  await changeState(b, (s) => s.set('result', 'saved'));
  assert.equal(writes, 2);
  assert.equal(await readState(b, (s) => s.get('result')), 'saved');
});
test('状态保存使用条件写，过期任务不能覆盖新任务的结果', async () => {
  const b = backend();
  await assert.rejects(
    changeState(b, async (s) => {
      await s.set('x', 'stale');
      const current = await b.read();
      current.state.lease!.expires = 0;
      await b.write(current.state, current.etag);
      await changeState(b, (s) => s.set('x', 'new'));
    }),
    /冲突/,
  );
  assert.equal(await readState(b, (s) => s.get('x')), 'new');
});
test('取消标记与扫码保存竞争时保留原登录态，不能覆盖普通任务', async () => {
  const b = backend();
  await changeState(b, async (s) => {
    await s.set('auth', 'previous');
    assert.deepEqual(await requestLoginCancel(b), { cancelled: false });
  });
  await assert.rejects(
    changeState(
      b,
      async (s) => {
        await s.set('auth', 'cancelled-new-session');
        assert.deepEqual(await requestLoginCancel(b), { cancelled: true });
      },
      'login',
    ),
    /已取消扫码/,
  );
  assert.equal(await readState(b, (s) => s.get('auth')), 'previous');
  assert.equal(await readState(b, async (_s, busy) => busy), false);
});
test('未登录的定时调度只读，不启动 Chromium 或消耗 Blob 写入', async () => {
  const b = backend();
  let writes = 0;
  const write = b.write;
  b.write = (...a) => {
    writes++;
    return write(...a);
  };
  assert.deepEqual(
    await scheduledPoll(Date.now(), 'run-1', env, b, async () => {
      throw Error('must not launch');
    }),
    { skipped: true },
  );
  assert.equal(writes, 0);
});
test('计划时间避免 15 分钟抖动导致每小时任务被跳过', async () => {
  const store = new Store(sqlite(':memory:'));
  const s = new BrowserService(config({ ...env, MODE: 'auto_cancel' }), store, async () => {
    throw Error('unused');
  });
  await store.set('auth', 'fixture');
  let calls = 0;
  s.withClient = async (fn) =>
    fn({
      async scan() {
        calls++;
        return { videos: [], account: 'fixture', pages: 1, complete: true };
      },
      async cancel() {
        throw Error('unused');
      },
    });
  const hour = Math.floor(Date.now() / 3600000) * 3600000;
  await s.poll(true, hour);
  await s.poll(true, hour + 3600000);
  assert.equal(calls, 2);
  await s.poll(true, hour + 3600000);
  assert.equal(calls, 2);
});
test('Vercel API 鉴权、调度间隔限制和状态持久化', async () => {
  const b = backend();
  const api = vercelApp(env, b);
  assert.equal((await api.request('/api/status')).status, 401);
  assert.equal((await api.request('/api/login/stream', { method: 'POST' })).status, 401);
  const headers = {
    Authorization: 'Bearer ' + env.ADMIN_TOKEN,
    'Content-Type': 'application/json',
  };
  assert.equal(
    (
      await api.request('/api/settings', {
        method: 'POST',
        headers,
        body: JSON.stringify({ mode: 'auto_cancel', interval: 300 }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await api.request('/api/settings', {
        method: 'POST',
        headers,
        body: JSON.stringify({ mode: 'auto_cancel', interval: 7200 }),
      })
    ).status,
    200,
  );
  const status = (await (await vercelApp(env, b).request('/api/status', { headers })).json()) as {
    interval: number;
    mode: string;
  };
  assert.equal(status.interval, 7200);
  assert.equal(status.mode, 'auto_cancel');
});
test('函数剩余时间不足时通知留在队列，避免丢失持久化结果', async () => {
  const b = backend();
  await changeState(b, async (s) => {
    await s.enqueue({ id: 'deadline-test', kind: 'test', title: 'test', body: 'test' }, ['mail']);
    const result = await flush(
      s,
      [{ name: 'mail', type: 'smtp' }],
      async () => {
        throw Error('must not connect without enough time');
      },
      Date.now(),
      Date.now() + 1000,
    );
    assert.deepEqual(result, { sent: 0, failed: 0 });
  });
  const rows = await readState(b, (s) =>
    s.db.all<{ attempts: number; sent_at: null }>('SELECT attempts,sent_at FROM outbox'),
  );
  assert.deepEqual(
    rows.map((r) => ({ ...r })),
    [{ attempts: 0, sent_at: null }],
  );
});
test('Vercel TLS 终止后允许生产页同源请求，拒绝其他域名或降级来源', async () => {
  const api = vercelApp({ ...env, VERCEL: '1' }, backend());
  for (const [origin, code] of [
    ['https://project.vercel.app', 200],
    ['http://project.vercel.app', 403],
    ['https://other.vercel.app', 403],
  ] as const) {
    const response = await api.request('http://project.vercel.app/api/status', {
      headers: { Authorization: 'Bearer ' + env.ADMIN_TOKEN, Origin: origin },
    });
    assert.equal(response.status, code);
  }
});
test('两种管理页脚本可解析，Vercel 内存 schema 与迁移一致', () => {
  for (const browser of [false, true])
    new Script(renderHtml(browser).match(/<script>([\s\S]*?)<\/script>/)![1]);
  assert.equal(
    schema,
    readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'),
  );
});

async function loginBrowser(loggedIn: boolean, html?: string) {
  const browser = await chromium.launch();
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (options) => {
    const context = await newContext(options);
    const newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage();
      await page.route('**/*', (route) =>
        route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body:
            html ??
            (loggedIn
              ? '<div id="user_detail_element"><div data-e2e="user-info">抖音号：fixture</div></div>'
              : '<p>等待人工扫码的模拟页面</p>'),
        }),
      );
      return page;
    };
    return context;
  };
  return browser;
}
const loginRequest = {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + env.ADMIN_TOKEN },
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test('扫码只有持久化完成才报告 confirmed，新的调用能恢复登录态', async () => {
  const b = backend();
  const browser = await loginBrowser(true);
  const gate = deferred();
  const saving = deferred();
  const write = b.write;
  b.write = async (state, etag) => {
    if (state.rows.kv.some((r) => r.key === 'auth')) {
      saving.resolve();
      await gate.promise;
    }
    return write(state, etag);
  };
  try {
    const response = await vercelApp(env, b, async () => browser).request(
      '/api/login/stream',
      loginRequest,
    );
    const result = response.text();
    await saving.promise;
    assert.equal(await readState(b, (s) => s.get('auth')), null);
    gate.resolve();
    const events = (await result)
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s));
    assert.equal(events.at(-1).type, 'confirmed');
    const encrypted = await readState(b, (s) => s.get('auth'));
    assert.equal(
      (await unseal<{ version: string }>(encrypted!, env.AUTH_SECRET)).version,
      'chromium-1',
    );
    assert.equal(await readState(b, async (_s, busy) => busy), false);
    assert.equal(browser.isConnected(), false);
  } finally {
    gate.resolve();
    await browser.close();
  }
});

test('人工输入绑定会话、消费后清除正文，重复请求不重复提交且登录结果可保存', async () => {
  const b = backend();
  await changeState(
    b,
    async (s, control) => {
      const input = {
        session: control.session,
        id: crypto.randomUUID(),
        frame: crypto.randomUUID(),
        action: 'text',
        text: 'fixture-code',
      };
      await assert.rejects(
        queueLoginInput(b, { ...input, session: crypto.randomUUID() }),
        /会话已结束/,
      );
      await queueLoginInput(b, input);
      await queueLoginInput(b, input);
      assert.equal((await control.poll()).input?.action, 'text');
      assert.equal(JSON.stringify((await b.read()).state).includes('fixture-code'), false);
      await queueLoginInput(b, input);
      assert.equal((await control.poll()).input, null);
      await s.set('auth', 'saved-after-input');
    },
    'login',
  );
  assert.equal(await readState(b, (s) => s.get('auth')), 'saved-after-input');
  assert.equal((await b.read()).state.lease, null);
});
test('人工操作拒绝无界坐标、脚本操作、超长文本与任意快捷键', () => {
  const base = {
    session: crypto.randomUUID(),
    id: crypto.randomUUID(),
    frame: crypto.randomUUID(),
  };
  for (const action of [
    { action: 'click', x: 2, y: 0 },
    { action: 'click', x: NaN, y: 0 },
    { action: 'eval', text: 'alert(1)' },
    { action: 'text', text: 'a'.repeat(129) },
    { action: 'key', key: 'Control+L' },
  ])
    assert.throws(() => parseLoginInput({ ...base, ...action }), /仅支持/);
});
test('人工输入与取消同时提交时，取消请求仍会生效', async () => {
  const b = backend();
  await assert.rejects(
    changeState(
      b,
      async (_s, control) => {
        const results = await Promise.allSettled([
          queueLoginInput(b, {
            session: control.session,
            id: crypto.randomUUID(),
            frame: crypto.randomUUID(),
            action: 'key',
            key: 'Tab',
          }),
          requestLoginCancel(b),
        ]);
        assert.equal(results[1].status, 'fulfilled');
        assert.equal((await control.poll()).cancelled, true);
      },
      'login',
    ),
    /已取消扫码/,
  );
  assert.equal((await b.read()).state.lease, null);
});
test('旧画面和离开抖音域名时不执行人工点击', async () => {
  const browser = await loginBrowser(false);
  try {
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    const page = await context.newPage();
    await page.goto('https://www.douyin.com/user/self');
    const frame = crypto.randomUUID();
    const input = parseLoginInput({
      session: crypto.randomUUID(),
      id: crypto.randomUUID(),
      frame,
      action: 'click',
      x: 0.5,
      y: 0.5,
    });
    await assert.rejects(applyLoginInput(page, input, crypto.randomUUID()), /画面已更新/);
    await page.goto('https://example.com');
    await assert.rejects(applyLoginInput(page, input, frame), /离开抖音/);
  } finally {
    await browser.close();
  }
});
test('确认嵌套页面输入焦点，未聚焦时不发送文本', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    await page.route('**/*', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body:
          new URL(route.request().url()).hostname === 'verify.douyin.com'
            ? '<input id="code" autocomplete="off">'
            : '<button id="outside">Outside</button><iframe src="https://verify.douyin.com/code"></iframe>',
      }),
    );
    await page.goto('https://www.douyin.com/user/self');
    const base = {
      session: crypto.randomUUID(),
      id: crypto.randomUUID(),
      frame: crypto.randomUUID(),
    };
    const text = parseLoginInput({ ...base, action: 'text', text: 'fixture-code' });
    await assert.rejects(applyLoginInput(page, text, base.frame), /尚未选中远端输入框/);
    const code = page.frameLocator('iframe').locator('#code');
    const box = (await code.boundingBox())!;
    const result = await applyLoginInput(
      page,
      parseLoginInput({
        ...base,
        action: 'click',
        x: (box.x + box.width / 2) / 1100,
        y: (box.y + box.height / 2) / 800,
      }),
      base.frame,
    );
    assert.equal(result.focusedInput, true);
    await applyLoginInput(page, text, base.frame);
    assert.equal(await code.inputValue(), 'fixture-code');
    await page.locator('#outside').click();
    await assert.rejects(applyLoginInput(page, text, base.frame), /尚未选中远端输入框/);
  } finally {
    await browser.close();
  }
});
test('管理页人工点击、输入和确认可贯通独立请求并保存模拟登录态', { timeout: 45000 }, async () => {
  const b = backend();
  const originalWrite = b.write;
  let transientFailure = false;
  b.write = async (state, etag) => {
    if (state.lease?.inputIds?.length === 1 && !transientFailure) {
      transientFailure = true;
      throw new SafeError('STATE_WRITE', 'temporary');
    }
    return originalWrite(state, etag);
  };
  const html = `<meta charset=utf-8><button id=option style="position:absolute;left:100px;top:100px;width:200px;height:50px" onclick="document.querySelector('#code').hidden=false">模拟验证方式</button><input id=code hidden style="position:absolute;left:100px;top:200px;width:200px;height:50px" onkeydown="if(event.key==='Enter'&&this.value==='fixture-code')document.querySelector('#user_detail_element').hidden=false"><div id=user_detail_element hidden><div data-e2e=user-info>抖音号：fixture</div></div>`;
  const remote = await loginBrowser(false, html);
  const api = vercelApp(env, b, async () => remote);
  const server = serve({ fetch: api.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const client = await chromium.launch();
  try {
    const p = await client.newPage({ viewport: { width: 1200, height: 1000 } });
    await p.goto('http://127.0.0.1:' + (server.address() as AddressInfo).port);
    await p.locator('#token').fill(env.ADMIN_TOKEN);
    await p.locator('#enter').click();
    await p.locator('#login').click();
    await p.locator('#qr').waitFor({ state: 'visible' });
    const remotePage = remote.contexts()[0].pages()[0];
    const ready = () =>
      p.waitForFunction(
        () => !(document.querySelector('#sendVerifyText') as HTMLButtonElement).disabled,
      );
    const click = async (selector: string) => {
      await ready();
      const target = (await remotePage.locator(selector).boundingBox())!;
      const picture = (await p.locator('#qr').boundingBox())!;
      await p.locator('#qr').click({
        position: {
          x: ((target.x + target.width / 2) / 1100) * picture.width,
          y: ((target.y + target.height / 2) / 800) * picture.height,
        },
      });
    };
    await remotePage.evaluate(() => {
      document.body.dataset.verification = 'stay';
    });
    await remote
      .contexts()[0]
      .addCookies([{ name: 'sessionid', value: 'fixture', domain: 'www.douyin.com', path: '/' }]);
    await click('#option');
    await remotePage.locator('#code').waitFor({ state: 'visible' });
    assert.equal(await remotePage.locator('body').getAttribute('data-verification'), 'stay');
    assert.equal(transientFailure, true);
    assert.match(await p.locator('#sessionClock').innerText(), /本次登录剩余 03:/);
    await click('#code');
    await remotePage.waitForFunction(() => document.activeElement?.id === 'code');
    await p.waitForFunction(() => document.activeElement?.id === 'verifyText');
    assert.match(await p.locator('#verifyState').innerText(), /已选中远端输入框/);
    await ready();
    await p.locator('#verifyText').fill('fixture-code');
    await p.locator('#sendVerifySubmit').click();
    assert.equal(await p.locator('#verifyText').inputValue(), '');
    await p.waitForFunction(
      () => document.querySelector('#logged')?.textContent === '已保存登录态',
    );
    assert.equal(await p.locator('#verifyControls').isHidden(), true);
    assert.ok(await readState(b, (s) => s.get('auth')));
  } finally {
    await client.close();
    await remote.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('扫码后保存失败不能报告登录成功', async () => {
  const b = backend();
  const browser = await loginBrowser(true);
  const write = b.write;
  b.write = async (state, etag) => {
    if (state.rows.kv.some((r) => r.key === 'auth')) throw new SafeError('STATE_WRITE', '保存失败');
    return write(state, etag);
  };
  try {
    const response = await vercelApp(env, b, async () => browser).request(
      '/api/login/stream',
      loginRequest,
    );
    const events = (await response.text())
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s));
    assert.equal(
      events.some((e) => e.type === 'confirmed'),
      false,
    );
    assert.equal(events.at(-1).code, 'STATE_WRITE');
    assert.equal(await readState(b, (s) => s.get('auth')), null);
    assert.equal(browser.isConnected(), false);
  } finally {
    await browser.close();
  }
});
test('关闭扫码流会关闭 Chromium 并释放持久化租约', async () => {
  const b = backend();
  const browser: Browser = await loginBrowser(false);
  try {
    const response = await vercelApp(env, b, async () => browser).request(
      '/api/login/stream',
      loginRequest,
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let content = '';
    while (!content.includes('"type":"image"')) {
      const { done, value } = await reader.read();
      assert.equal(done, false);
      content += decoder.decode(value);
    }
    await reader.cancel();
    const deadline = Date.now() + 10000;
    while (await readState(b, async (_s, busy) => busy)) {
      assert.ok(Date.now() < deadline, '扫码取消后租约未释放');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(browser.isConnected(), false);
    assert.equal(await readState(b, (s) => s.get('auth')), null);
  } finally {
    await browser.close();
  }
});
test('独立取消请求无需断开原连接即可关闭 Chromium 并释放租约', async () => {
  const b = backend();
  const browser = await loginBrowser(false);
  const api = vercelApp(env, b, async () => browser);
  try {
    const response = await api.request('/api/login/stream', loginRequest);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let content = '';
    while (!content.includes('"type":"image"')) {
      const { done, value } = await reader.read();
      assert.equal(done, false);
      content += decoder.decode(value);
    }
    const cancelled = await api.request('/api/login/cancel', loginRequest);
    assert.deepEqual(await cancelled.json(), { cancelled: true });
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      content += decoder.decode(value);
    }
    const events = content
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x));
    assert.equal(events.at(-1).code, 'LOGIN_CANCELLED');
    assert.equal(
      events.some((e) => e.type === 'confirmed'),
      false,
    );
    assert.equal(await readState(b, async (_s, busy) => busy), false);
    assert.equal(browser.isConnected(), false);
  } finally {
    await browser.close();
  }
});

test('连续截图失败超过三次仍保留登录窗口，恢复后可正常取消', { timeout: 20000 }, async () => {
  const b = backend();
  const browser = await loginBrowser(false);
  const originalContext = browser.newContext.bind(browser);
  let attempts = 0,
    sawImage = false;
  browser.newContext = async (options) => {
    const context = await originalContext(options);
    const newPage = context.newPage.bind(context);
    context.newCDPSession = async () => {
      throw Error('Unable to capture screenshot');
    };
    context.newPage = async () => {
      const page = await newPage();
      const screenshot = page.screenshot.bind(page);
      page.screenshot = async (options) => {
        if (++attempts <= 4) throw Error('Unable to capture screenshot');
        return screenshot(options);
      };
      return page;
    };
    return context;
  };
  const controller = new AbortController();
  try {
    await assert.rejects(
      changeState(b, async (store) => {
        const s = new BrowserService(
          config(env),
          store,
          () => {
            throw Error('Unexpected SMTP');
          },
          async () => browser,
        );
        await s.login(controller.signal, (event) => {
          if (event.type === 'image') {
            sawImage = true;
            controller.abort();
          }
        });
      }),
      /扫码连接已关闭/,
    );
    assert.equal(sawImage, true);
    assert.ok(attempts > 4);
    assert.equal(browser.isConnected(), false);
  } finally {
    await browser.close();
  }
});
