import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import {
  changeState,
  readState,
  emptyState,
  requestLoginCancel,
  type State,
  type StateBackend,
} from '../src/vercel/state.js';
import { renderHtml } from '../src/ui.js';
import { vercelApp, scheduledPoll } from '../src/vercel/app.js';
import { SafeError } from '../src/types.js';
import { BrowserService } from '../src/browser/service.js';
import { config } from '../src/config.js';
import { sqlite } from '../src/node.js';
import { Store } from '../src/store.js';
import { readFileSync } from 'node:fs';
import { schema } from '../src/vercel/schema.js';
import { chromium, type Browser } from 'playwright-core';
import { unseal } from '../src/crypto.js';
import { flush } from '../src/notify.js';

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
test('Vercel API 鉴权、整小时间隔和状态持久化', async () => {
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

async function loginBrowser(loggedIn: boolean) {
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
          body: loggedIn
            ? '<div id="user_detail_element"><div data-e2e="user-info">抖音号：fixture</div></div>'
            : '<p>等待人工扫码的模拟页面</p>',
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
