import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { chromium, type Browser } from 'playwright-core';
import { vercelApp, scheduledPoll } from '../src/vercel/app.js';
import { changeState, readState, emptyState, type StateBackend } from '../src/vercel/state.js';
import { seal, unseal, digest } from '../src/crypto.js';
import { vercelHybridPolicy } from '../src/browser/policy.js';

const env = {
  ADMIN_TOKEN: 'a'.repeat(40),
  AUTH_SECRET: 'b'.repeat(40),
  MODE: 'auto_cancel',
  POLL_INTERVAL_SECONDS: '900',
  ACTION_DELAY_MS: '1000',
};
const headers = { Authorization: 'Bearer ' + env.ADMIN_TOKEN };
function backend(): StateBackend {
  let state = emptyState(),
    revision = 0;
  return {
    async read() {
      return { state: structuredClone(state), etag: String(revision) };
    },
    async write(next, etag) {
      assert.equal(etag, String(revision));
      state = structuredClone(next);
      return String(++revision);
    },
  };
}
async function fixture(options: { reject?: boolean; other?: boolean; expired?: boolean } = {}) {
  const b = backend();
  let browser: Browser | undefined,
    starts = 0,
    removed = false,
    posts = 0;
  const launch = async () => {
    starts++;
    browser = await chromium.launch();
    const original = browser.newContext.bind(browser);
    browser.newContext = async (o) => {
      const context = await original(o);
      await context.addCookies(
        ['sessionid', 'msToken'].map((name) => ({
          name,
          value: 'fixture-secret',
          domain: '.douyin.com',
          path: '/',
        })),
      );
      const newPage = context.newPage.bind(context);
      context.newPage = async () => {
        const page = await newPage();
        await page.route('**/*', (r) =>
          r.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: '<div id="user_detail_element"><h1>测试昵称</h1><div data-e2e="user-info">抖音号：fixture</div></div>',
          }),
        );
        return page;
      };
      return context;
    };
    return browser;
  };
  const transport: typeof fetch = async (input, init) => {
    assert.equal(browser?.isConnected(), false, 'Chromium must close before protocol calls');
    const url = new URL(String(input));
    const h = new Headers(init?.headers);
    assert.match(h.get('cookie') ?? '', /sessionid=fixture-secret/);
    assert.match(h.get('user-agent') ?? '', /Chrome/);
    if (options.reject) return new Response('');
    if (options.expired) return Response.json({ status_code: 0, user: {} });
    if (url.pathname.includes('/profile/self/'))
      return Response.json({
        status_code: 0,
        user: {
          uid: '123',
          sec_uid: 'fixture-sec',
          unique_id: options.other ? 'other' : 'fixture',
        },
      });
    if (url.pathname.endsWith('/feed/'))
      return Response.json({
        status_code: 0,
        has_more: false,
        total: removed ? 0 : 1,
        aweme_list: removed ? null : [{ aweme_id: '1001', desc: '测试推荐' }],
      });
    if (init?.method === 'HEAD')
      return new Response(null, { headers: { 'x-ware-csrf-token': '0, csrf, 0' } });
    assert.equal(url.pathname, '/aweme/v1/web/familiar/recommend/cancel');
    assert.equal(h.get('x-secsdk-csrf-token'), 'csrf');
    posts++;
    removed = true;
    return Response.json({ status_code: 0 });
  };
  const app = () => vercelApp(env, b, launch, { transport });
  const request = async (path: string, body?: object) => {
    const r = await app().request('/api/' + path, {
      method: body ? 'POST' : 'GET',
      headers: { ...headers, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  const legacy = async () =>
    changeState(b, async (store) => {
      await store.set('account', await digest('fixture'));
      await store.set(
        'auth',
        await seal({ version: 'chromium-1', state: { cookies: [], origins: [] } }, env.AUTH_SECRET),
      );
    });
  return { b, launch, transport, app, request, legacy, starts: () => starts, posts: () => posts };
}

test('Vercel 旧登录态显式升级一次，新函数纯协议取消和复核不再启动 Chromium', async () => {
  const f = await fixture();
  await f.legacy();
  const before = await f.request('status');
  assert.equal(before.body.migrationRequired, true);
  assert.equal(before.body.loggedIn, false);
  assert.equal((await f.request('poll', {})).body.error, 'SESSION_UPGRADE');
  assert.equal(f.starts(), 0);
  const upgraded = await f.request('session/upgrade', {});
  assert.equal(upgraded.status, 200, JSON.stringify(upgraded.body));
  assert.equal(f.starts(), 1);
  assert.equal((await f.request('status')).body.runtime, 'vercel-hybrid');
  const result = await f.request('poll', {});
  assert.equal(result.body.removed, 1);
  assert.equal(result.body.count, 0);
  assert.equal(f.posts(), 1);
  assert.equal(f.starts(), 1);
  const after = await f.request('status');
  assert.equal(after.body.execution, 'node-fetch');
  assert.equal(after.body.profile.nickname, '测试昵称');
  assert.equal(after.body.browserStarts, 1);
  const auth = await readState(f.b, (s) => s.get('auth'));
  assert.equal((await unseal<any>(auth!, env.AUTH_SECRET)).version, 'hybrid-1');
  assert.doesNotMatch(JSON.stringify(after.body), /fixture-secret/);
  await scheduledPoll(
    Date.now() + 901000,
    'scheduled-fixture',
    env,
    f.b,
    f.launch,
    vercelHybridPolicy,
    f.transport,
  );
  assert.equal(f.starts(), 1);
  assert.equal((await f.request('status')).body.scheduleDiagnostic.ok, true);
});

test('Vercel 新扫码完成后先关闭 Chromium，协议验证及状态落盘后才报告成功', async () => {
  const f = await fixture();
  const r = await f.app().request('/api/login/stream', { method: 'POST', headers });
  const messages = (await r.text())
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(messages.at(-1).type, 'confirmed');
  assert.equal(f.starts(), 1);
  assert.equal((await f.request('status')).body.loggedIn, true);
  assert.equal((await f.request('poll', {})).body.removed, 1);
  assert.equal(f.starts(), 1);
});

test('Vercel 协议被拒绝时保留候选会话，重试不用浏览器，定时任务不会回退', async () => {
  const f = await fixture({ reject: true });
  await f.legacy();
  assert.equal((await f.request('session/upgrade', {})).body.error, 'HTTP_NON_JSON');
  const status = (await f.request('status')).body;
  assert.equal(status.sessionPending, true);
  assert.equal(status.loggedIn, false);
  assert.equal((await f.request('session/validate', {})).body.error, 'HTTP_NON_JSON');
  assert.equal(f.starts(), 1);
  assert.deepEqual(
    await scheduledPoll(
      Date.now(),
      'pending-fixture',
      env,
      f.b,
      f.launch,
      vercelHybridPolicy,
      f.transport,
    ),
    { skipped: true },
  );
  assert.equal(f.starts(), 1);
  assert.equal(f.posts(), 0);
});

test('Vercel 候选账号不一致不能覆盖旧登录态，升级接口需要鉴权', async () => {
  const f = await fixture({ other: true });
  await f.legacy();
  const raw = await readState(f.b, (s) => s.get('auth'));
  assert.equal((await f.app().request('/api/session/upgrade', { method: 'POST' })).status, 401);
  assert.equal((await f.request('session/upgrade', {})).body.error, 'ACCOUNT_CHANGED');
  assert.equal(await readState(f.b, (s) => s.get('auth')), raw);
  assert.equal(f.posts(), 0);
});

test('Vercel 混合面板脚本可解析并提供旧会话转换与协议重试', async () => {
  const f = await fixture();
  const html = await (await f.app().request('/')).text();
  new Script(html.match(/<script>([\s\S]*?)<\/script>/)![1]);
  assert.match(html, /id="upgradeSession"/);
  assert.match(html, /id="validateProtocol"/);
});

test('Vercel 定时任务遇到失效会话记录失败，停止后续调度且不启动浏览器', async () => {
  const options = { expired: false };
  const f = await fixture(options);
  await f.legacy();
  assert.equal((await f.request('session/upgrade', {})).status, 200);
  options.expired = true;
  await assert.rejects(
    scheduledPoll(Date.now(), 'expired', env, f.b, f.launch, vercelHybridPolicy, f.transport),
    /登录/,
  );
  const s = (await f.request('status')).body;
  assert.equal(s.loggedIn, false);
  assert.equal(s.scheduleDiagnostic.ok, false);
  assert.equal(s.scheduleDiagnostic.error, 'LOGIN_REQUIRED');
  assert.deepEqual(
    await scheduledPoll(
      Date.now() + 3600000,
      'later',
      env,
      f.b,
      f.launch,
      vercelHybridPolicy,
      f.transport,
    ),
    { skipped: true },
  );
  assert.equal(f.starts(), 1);
  assert.equal(f.posts(), 0);
});
