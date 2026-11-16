import test from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright-core';
import { vercelApp, scheduledPoll } from '../src/vercel/app.js';
import { emptyState, changeState, readState, type StateBackend } from '../src/vercel/state.js';
import { vercelHybridPolicy } from '../src/browser/policy.js';
import { seal, unseal } from '../src/crypto.js';

const env = {
  ADMIN_TOKEN: 'a'.repeat(40),
  AUTH_SECRET: 'b'.repeat(40),
  MODE: 'auto_cancel',
  POLL_INTERVAL_SECONDS: '900',
};
const headers = { Authorization: 'Bearer ' + env.ADMIN_TOKEN, 'Content-Type': 'application/json' };
function fixture(defaults: object = {}) {
  let state = emptyState(),
    rev = 0;
  const backend: StateBackend = {
    async read() {
      return { state: structuredClone(state), etag: String(rev) };
    },
    async write(next, etag) {
      assert.equal(etag, String(rev));
      state = structuredClone(next);
      return String(++rev);
    },
  };
  const settings = { ...env, ...defaults };
  const app = () =>
    vercelApp(settings, backend, async () => {
      throw Error('Browser must not start');
    });
  const request = async (path: string, body?: object) => {
    const r = await app().request('/api/' + path, {
      method: body ? 'POST' : 'GET',
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  return { backend, app, request, settings };
}
const webhook = {
  name: 'my-hook',
  type: 'webhook',
  url: 'https://notify.example/secret-path?key=secret-query',
  token: 'secret-bearer',
};

test('面板通知配置加密持久化，跨请求脱敏读取，留空保留密钥，空列表覆盖部署默认', async () => {
  const f = fixture({ NOTIFICATIONS_JSON: JSON.stringify([{ ...webhook, name: 'deployment' }]) });
  assert.equal((await f.app().request('/api/notifications/config')).status, 401);
  assert.equal(
    (
      await f
        .app()
        .request('/api/notifications/config', {
          method: 'POST',
          headers: { ...headers, Origin: 'https://evil.example' },
          body: '{}',
        })
    ).status,
    403,
  );
  assert.equal((await f.request('notifications/config')).body.source, 'environment');
  const saved = await f.request('notifications/config', {
    channels: [
      webhook,
      {
        name: 'mail',
        type: 'smtp',
        host: 'smtp.example.com',
        username: 'user',
        password: 'secret-mail',
        from: 'a@example.com',
        to: ['b@example.com'],
        port: 465,
      },
    ],
  });
  assert.equal(saved.status, 200);
  assert.doesNotMatch(JSON.stringify(saved.body), /secret-|secret-query/);
  assert.equal(saved.body.channels[0].saved.token, true);
  const encrypted = await readState(f.backend, (s) => s.get('notification_channels'));
  assert.doesNotMatch(encrypted!, /secret-|secret-query/);
  const decoded = await unseal<any[]>(encrypted!, env.AUTH_SECRET);
  assert.equal(decoded[0].token, webhook.token);
  assert.equal(
    (await f.request('notifications/config', { channels: saved.body.channels })).status,
    200,
  );
  assert.equal(
    (
      await unseal<any[]>(
        (await readState(f.backend, (s) => s.get('notification_channels')))!,
        env.AUTH_SECRET,
      )
    )[0].url,
    webhook.url,
  );
  assert.equal(
    (
      await f.request('notifications/config', {
        channels: [{ name: 'my-hook', type: 'webhook', token: '' }],
      })
    ).status,
    200,
  );
  assert.equal((await f.request('notifications/config')).body.channels[0].saved.token, false);
  assert.equal((await f.request('notifications/config', { channels: [] })).status, 200);
  assert.deepEqual((await f.request('status')).body.channels, []);
  assert.equal(
    (await f.request('notifications/config', { source: 'environment' })).body.channels[0].name,
    'deployment',
  );
});

test('非法通知设置不覆盖已保存配置，删除渠道丢弃其未发送消息', async () => {
  const f = fixture();
  await f.request('notifications/config', { channels: [webhook] });
  for (const channels of [
    [{ ...webhook, url: 'http://unsafe.example' }],
    [webhook, webhook],
    [
      {
        name: 'mail',
        type: 'smtp',
        host: 'smtp.example',
        username: 'u',
        password: 'p',
        from: 'bad\r\nBcc:x',
        to: ['a@example.com'],
      },
    ],
    Array.from({ length: 9 }, (_, i) => ({ ...webhook, name: String(i) })),
  ])
    assert.equal((await f.request('notifications/config', { channels })).status, 400);
  assert.equal((await f.request('notifications/config')).body.channels.length, 1);
  await changeState(f.backend, (s) =>
    s.enqueue({ id: 'pending', kind: 'error', title: 'test', body: 'test' }, ['my-hook']),
  );
  await f.request('notifications/config', { channels: [] });
  assert.equal((await f.request('status')).body.pending, 0);
});

test('失效通知发送失败后由真实调度入口重试，不再读取抖音或启动浏览器', async () => {
  const f = fixture();
  await f.request('notifications/config', { channels: [webhook] });
  await changeState(f.backend, async (s) => {
    await s.set('account', 'owner');
    await s.set(
      'auth',
      await seal(
        {
          version: 'hybrid-1',
          account: 'owner',
          cookies: [
            {
              name: 'msToken',
              value: 'fixture',
              domain: 'douyin.com',
              path: '/',
              hostOnly: false,
              secure: true,
            },
          ],
          userAgent: 'fixture',
          platform: 'Linux',
          geo: [800, 600, 800, 600, 800, 600, 800, 600],
          query: {},
          counter: 0,
        },
        env.AUTH_SECRET,
      ),
    );
  });
  let sends = 0,
    reads = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), webhook.url);
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer ' + webhook.token);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.title, '抖音登录已失效');
    assert.match(body.body, /重新扫码/);
    sends++;
    return new Response('', { status: sends === 1 ? 503 : 200 });
  };
  const transport: typeof fetch = async () => {
    reads++;
    return Response.json({ status_code: 0, user: {} });
  };
  const noBrowser = async () => {
    throw Error('Browser must not start');
  };
  try {
    await assert.rejects(
      scheduledPoll(
        Date.now(),
        'expired',
        env,
        f.backend,
        noBrowser,
        vercelHybridPolicy,
        transport,
      ),
      /登录/,
    );
    assert.equal(sends, 1);
    assert.equal(reads, 1);
    await changeState(f.backend, (s) => s.db.run('UPDATE outbox SET next_at=0'));
    const r = await scheduledPoll(
      Date.now(),
      'retry',
      env,
      f.backend,
      noBrowser,
      vercelHybridPolicy,
      transport,
    );
    assert.equal(r.skipped, true);
    assert.equal(sends, 2);
    assert.equal(reads, 1);
    assert.equal((await f.request('status')).body.pending, 0);
    await scheduledPoll(
      Date.now() + 3600000,
      'later',
      env,
      f.backend,
      noBrowser,
      vercelHybridPolicy,
      transport,
    );
    assert.equal(reads, 1);
    assert.equal(sends, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('未登录时测试消息发送失败仍能重试，面板配置用于实际 HTTP 渠道发送', async () => {
  const f = fixture();
  await f.request('notifications/config', { channels: [webhook] });
  const original = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async () => new Response('', { status: ++sends === 1 ? 503 : 200 });
  try {
    assert.equal((await f.request('notifications/test', {})).body.failed, 1);
    await changeState(f.backend, (s) => s.db.run('UPDATE outbox SET next_at=0'));
    const r = await scheduledPoll(Date.now(), 'retry-no-login', env, f.backend);
    assert.equal(r.skipped, true);
    assert.equal(sends, 2);
    assert.equal((await f.request('status')).body.pending, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test(
  '通知表单新增、保存、脱敏编辑、移除贯通真实面板和独立服务请求',
  { timeout: 30000 },
  async () => {
    const f = fixture();
    const server = serve({ fetch: f.app().fetch, hostname: '127.0.0.1', port: 0 });
    await new Promise<void>((r) => server.once('listening', r));
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto('http://127.0.0.1:' + (server.address() as AddressInfo).port);
      await page.locator('#token').fill(env.ADMIN_TOKEN);
      await page.locator('#enter').click();
      await page.locator('#main').waitFor({ state: 'visible' });
      await page.locator('#noticeAdd').click();
      await page.locator('#noticeName').fill('测试手机');
      await page.locator('#noticeKey').fill('fixture-device-key');
      await page.locator('#noticeApply').click();
      await page.locator('#noticeSave').click();
      await page.getByText('已配置 1 个渠道，登录失效提醒已启用。', { exact: true }).waitFor();
      await page.locator('#noticeList').getByRole('button', { name: '编辑' }).click();
      assert.equal(await page.locator('#noticeKey').inputValue(), '');
      assert.equal(
        await page.locator('#noticeKey').getAttribute('placeholder'),
        '已保存，留空保留',
      );
      await page.locator('#noticeCancel').click();
      await page.locator('#noticeList').getByRole('button', { name: '移除' }).click();
      await page.locator('#noticeSave').click();
      await page.getByText('未配置通知渠道，登录失效也不会发送消息。', { exact: true }).waitFor();
      assert.deepEqual((await f.request('status')).body.channels, []);
    } finally {
      await browser.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);
