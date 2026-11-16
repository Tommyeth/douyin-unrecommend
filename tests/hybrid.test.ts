import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { config } from '../src/config.js';
import { digest, seal, unseal } from '../src/crypto.js';
import { sqlite } from '../src/node.js';
import { Store } from '../src/store.js';
import { HybridService } from '../src/hybrid/service.js';
import { hybridApp, hybridPolicy } from '../src/hybrid/app.js';
import { importCookies, type HybridSession } from '../src/hybrid/session.js';
import { CookieJar } from '../src/protocol/http.js';
import { FEED, SELF, CANCEL } from '../src/douyin.js';
import { renderHtml } from '../src/ui.js';
import type { LoginDriver } from '../src/hybrid/login.js';

const env = {
  ADMIN_TOKEN: 'a'.repeat(40),
  AUTH_SECRET: 'b'.repeat(40),
  MODE: 'auto_cancel',
  POLL_INTERVAL_SECONDS: '900',
  ACTION_DELAY_MS: '1000',
};
const mail = async () => {
  throw Error('SMTP must not be called');
};
async function fixture(
  options: { rejected?: boolean; noEffect?: boolean; otherAccount?: boolean } = {},
) {
  const store = new Store(sqlite(':memory:'));
  const account = await digest('fixture-id');
  const state: HybridSession = {
    version: 'hybrid-1',
    account,
    userAgent: 'browser-captured-UA',
    platform: 'Linux x86_64',
    geo: [1100, 800, 1100, 800, 1100, 800, 1100, 800],
    query: {
      browser_platform: 'Linux x86_64',
      browser_version: '150.0.0.0',
      sec_user_id: 'untrusted',
    },
    counter: 2,
    cookies: importCookies([
      {
        name: 'sessionid',
        value: 'private-session',
        domain: '.douyin.com',
        path: '/',
        secure: true,
        expires: -1,
      },
      {
        name: 'msToken',
        value: 'browser-token',
        domain: '.douyin.com',
        path: '/',
        secure: true,
        expires: -1,
      },
    ]),
  };
  await store.set('candidate_auth', await seal(state, env.AUTH_SECRET));
  const ids = new Set(['1001']);
  const requests: { path: string; method: string }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      method = init?.method ?? 'GET';
    requests.push({ path: url.pathname, method });
    const h = new Headers(init?.headers);
    assert.equal(h.get('User-Agent'), state.userAgent);
    assert.match(h.get('Cookie') ?? '', /sessionid=private-session/);
    if (options.rejected) return new Response('', { status: 403 });
    if (url.pathname === SELF)
      return Response.json({
        status_code: 0,
        user: {
          uid: '123',
          sec_uid: 'fixture-sec',
          unique_id: options.otherAccount ? 'other-id' : 'fixture-id',
        },
      });
    if (url.pathname === FEED) {
      assert.equal(url.searchParams.get('sec_user_id'), 'fixture-sec');
      assert.equal(url.searchParams.get('browser_platform'), 'Linux x86_64');
      assert.ok(url.searchParams.get('a_bogus'));
      return Response.json(
        {
          status_code: 0,
          has_more: false,
          total: ids.size,
          aweme_list: [...ids].map((aweme_id) => ({ aweme_id, desc: '测试' })),
        },
        { headers: { 'x-ms-token': 'rotated-token' } },
      );
    }
    if (url.pathname === CANCEL && method === 'HEAD')
      return new Response(null, { headers: { 'x-ware-csrf-token': '0, test-csrf, 0' } });
    if (url.pathname === CANCEL && method === 'POST') {
      assert.equal(h.get('x-secsdk-csrf-token'), 'test-csrf');
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('type'), '2');
      if (!options.noEffect) ids.delete(body.get('item_id')!);
      return Response.json({ status_code: 0 });
    }
    throw Error('Unexpected transport call: ' + url.pathname);
  };
  return {
    store,
    state,
    ids,
    requests,
    transport,
    service: new HybridService(config(env), store, mail, transport),
  };
}

test('混合版 Cookie 保留作用域与过期时间，剔除无关域和过期项', () => {
  const cookies = importCookies([
    {
      name: 'a',
      value: 'v',
      domain: '.douyin.com',
      path: '/',
      secure: true,
      expires: Date.now() / 1000 + 1000,
    },
    { name: 'b', value: 'v', domain: 'www.douyin.com', path: '/api', secure: true, expires: -1 },
    { name: 'expired', value: 'v', domain: '.douyin.com', path: '/', secure: true, expires: 1 },
    { name: 'evil', value: 'v', domain: '.evil-douyin.com', path: '/', secure: true, expires: -1 },
  ]);
  assert.equal(cookies.length, 2);
  assert.ok(cookies[0].expires! > Date.now());
  const jar = new CookieJar(cookies);
  assert.equal(jar.header(new URL('https://login.douyin.com/api')), 'a=v');
  assert.equal(jar.header(new URL('https://www.douyin.com/api')), 'b=v; a=v');
  assert.equal(jar.header(new URL('http://www.douyin.com/api')), '');
});

test('浏览器候选登录态需通过协议验证；新实例纯 fetch 取消后完整复核，不调用浏览器', async () => {
  const f = await fixture();
  assert.equal((await f.service.status()).loggedIn, false);
  assert.equal((await f.service.validateCandidate()).status, 'confirmed');
  assert.equal(await f.store.get('candidate_auth'), null);
  let browserCalls = 0;
  const fail = async () => {
    browserCalls++;
    throw Error('Browser must not be used');
  };
  const login: LoginDriver = { start: fail, view: fail, capture: fail, cancel: fail, expire: fail };
  const restarted = new HybridService(config(env), f.store, mail, f.transport);
  const web = hybridApp(restarted, login);
  const response = await web.request('/api/poll', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.ADMIN_TOKEN },
  });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { removed: number }).removed, 1);
  assert.equal(f.ids.size, 0);
  assert.equal(browserCalls, 0);
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 1);
  const state = await unseal<HybridSession>((await f.store.get('auth'))!, env.AUTH_SECRET);
  assert.equal(new CookieJar(state.cookies).get('msToken'), 'rotated-token');
  assert.ok(!(await f.store.get('auth'))!.includes('private-session'));
  const status = await restarted.status();
  assert.equal(status.execution, 'worker-fetch');
  assert.equal(status.interval, 900);
  assert.deepEqual(status.channels, []);
  assert.equal(status.browserStarts, 0);
  const count = f.requests.length;
  assert.equal((await restarted.poll(true, Date.now())).skipped, true);
  assert.equal(f.requests.length, count);
});

test('协议受限保留扫码会话，不启用任务、不泄露凭证，也不切回浏览器', async () => {
  const f = await fixture({ rejected: true });
  await assert.rejects(f.service.validateCandidate(), /HTTP 403/);
  assert.equal(await f.store.get('auth'), null);
  assert.ok(await f.store.get('candidate_auth'));
  const status = await f.service.status();
  assert.equal(status.sessionPending, true);
  assert.equal(status.protocolDiagnostic.error, 'HTTP_STATUS');
  assert.doesNotMatch(JSON.stringify(status), /private-session|browser-token/);
});

test('协议与浏览器账号不一致不能保存；取消接口成功但列表未变化不能算成功', async () => {
  const wrong = await fixture({ otherAccount: true });
  await assert.rejects(wrong.service.validateCandidate(), /账号不同/);
  assert.equal(await wrong.store.get('auth'), null);
  const f = await fixture({ noEffect: true });
  await f.service.validateCandidate();
  await assert.rejects(f.service.poll(), /确认移除/);
  assert.equal((await f.service.status()).error.code, 'CANCEL_UNVERIFIED');
  assert.equal(f.ids.size, 1);
});

test('提醒模式不取消；无通知配置时给出明确错误；15 分钟间隔与 API 鉴权', async () => {
  const f = await fixture();
  await f.service.validateCandidate();
  await f.service.setSettings('notify', 900);
  await assert.rejects(f.service.poll(), /通知渠道/);
  assert.equal(
    f.requests.some((r) => r.method === 'POST'),
    false,
  );
  await assert.rejects(f.service.setSettings('notify', 300), /900/);
  await assert.rejects(f.service.setSettings('auto_cancel', 950), /900/);
  await f.service.setSettings('auto_cancel', 1800);
  const fail = async () => {
    throw Error('not used');
  };
  const web = hybridApp(f.service, {
    start: fail,
    view: fail,
    capture: fail,
    cancel: fail,
    expire: fail,
  });
  assert.equal((await web.request('/api/login/view', { method: 'POST' })).status, 401);
  assert.equal(
    (
      await web.request('/api/status', {
        headers: { Authorization: 'Bearer ' + env.ADMIN_TOKEN, Origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  assert.equal((await f.service.status()).interval, 1800);
});

test('混合面板脚本可解析，使用原生 Live View 且标明纯协议路径', () => {
  const html = renderHtml(true, hybridPolicy);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  new vm.Script(script);
  assert.match(html, /live\.browser\.run/);
  assert.match(html, /每 15 分钟调度/);
  assert.match(html, /hybridRuntime=true/);
  assert.match(html, /辅助短信验证/);
});
