import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Signer, sm3 } from '../src/protocol/sign.js';
import { Http, CookieJar } from '../src/protocol/http.js';
import { Douyin, FEED, CANCEL, SELF } from '../src/douyin.js';
import { config } from '../src/config.js';
import { Service } from '../src/service.js';
import { Passport } from '../src/protocol/login.js';
import { Store } from '../src/store.js';
import { sqlite } from '../src/node.js';
const cfg = config({
  ADMIN_TOKEN: 'a'.repeat(40),
  AUTH_SECRET: 'b'.repeat(40),
  ACTION_DELAY_MS: '1000',
  PAGE_TIMEOUT_MS: '5000',
});
function fixture(
  ids = new Set(['101', '102']),
  options: { noEffect?: boolean; rejected?: boolean; badCSRF?: boolean; loop?: boolean } = {},
) {
  const writes: string[] = [];
  let validSession = false;
  let portrait = '';
  const transport: typeof fetch = async (input, init) => {
    const u = new URL(String(input)),
      headers = new Headers(init?.headers),
      method = init?.method || 'GET';
    if (u.pathname === '/')
      return new Response('', {
        headers: {
          'Set-Cookie': 'passport_csrf_token=anonymous; Path=/; Domain=.douyin.com; Secure',
        },
      });
    if (u.pathname === '/ttwid/check/') return new Response('{}');
    if (u.pathname === '/passport/web/get_qrcode/') {
      portrait = headers.get('x-tt-passport-verify-portrait')!;
      assert.ok(portrait.endsWith('.login'));
      assert.ok(u.searchParams.get('sign'));
      assert.ok(u.searchParams.get('a_bogus'));
      return Response.json({
        message: 'success',
        data: { token: 'test-token', qrcode: 'iVBORw0KGgo=', expire_time: 120 },
      });
    }
    if (u.pathname === '/passport/web/check_qrconnect/') {
      assert.equal(headers.get('x-tt-passport-verify-portrait'), portrait);
      assert.equal(new URLSearchParams(String(init?.body)).get('token'), 'test-token');
      assert.ok(headers.get('Cookie')?.includes('passport_csrf_token=anonymous'));
      return Response.json({
        message: 'success',
        data: { status: 'confirmed', redirect_url: 'https://sso.douyin.com/login-success' },
      });
    }
    if (u.pathname === '/login-success')
      return new Response(null, {
        status: 302,
        headers: {
          Location: 'https://www.douyin.com/finish',
          'Set-Cookie': 'sessionid=logged-in; Domain=.douyin.com; Path=/; Secure',
        },
      });
    if (u.pathname === '/finish') {
      validSession = !!headers.get('Cookie')?.includes('sessionid=logged-in');
      return new Response('ok');
    }
    if (u.pathname === SELF)
      return Response.json({
        status_code: 0,
        user: { uid: '1234567890123456789', sec_uid: 'test-sec-uid', unique_id: 'fixture' },
      });
    if (u.pathname === FEED) {
      assert.equal(u.searchParams.get('sec_user_id'), 'test-sec-uid');
      assert.ok(u.searchParams.get('a_bogus'));
      const all = [...ids],
        cursor = Number(u.searchParams.get('max_cursor') || '0');
      return Response.json({
        status_code: 0,
        total: ids.size,
        has_more: options.loop || cursor + 1 < all.length,
        max_cursor: options.loop ? '1' : String(cursor + 1),
        aweme_list: all.slice(cursor, cursor + 1).map((id) => ({ aweme_id: id, desc: '测试' })),
      });
    }
    if (u.pathname === CANCEL && method === 'HEAD')
      return new Response(null, {
        headers: options.badCSRF ? {} : { 'x-ware-csrf-token': '0, csrf-test, 0, 0, 0' },
      });
    if (u.pathname === CANCEL && method === 'POST') {
      assert.equal(headers.get('x-secsdk-csrf-token'), 'csrf-test');
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('source'), '0');
      assert.equal(body.get('type'), '2');
      const id = body.get('item_id')!;
      writes.push(id);
      if (!options.noEffect && !options.rejected) ids.delete(id);
      return Response.json({ status_code: options.rejected ? 8 : 0 });
    }
    throw new Error('Unexpected fixture path ' + u.pathname);
  };
  return { transport, writes, valid: () => validSession };
}
test('纯 JS SM3 标准向量和 a_bogus 上游确定性向量匹配', () => {
  assert.equal(
    Buffer.from(sm3('abc')).toString('hex'),
    '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0',
  );
  assert.equal(
    Buffer.from(sm3('abcd'.repeat(16))).toString('hex'),
    'debe9ff92275b8a138604889c18e5a4d6fdb70e5387e5765293dcba39c0c5732',
  );
  const s = new Signer(
    undefined,
    [2560, 1215, 2560, 1392, 2560, 1392, 2560, 1440],
    () => 1720000000000,
    () => 0.4142135623730951,
  );
  assert.equal(
    s.sign('device_platform=webapp&aid=6383'),
    'df0fgq6idxW5cdMSuOTiH1nlrHnMNsWyGMi/bCol9PL7bwUTXbYeYOcWaxo8bMdfpWpwiFV7ZDTMYnncF07TZCHkLmpDSmwWkUA5V66oZ1wXbMiQLNfBCw8LeJtbWOvEmAojJ1UlWtmO2dC4LpaTUBlytApismipQHabdc4aE9ef6zT9Bqq2uxSdO7zqwj==',
  );
  assert.notEqual(s.sign('aid=6383', 'item_id=1'), s.sign('aid=6383', 'item_id=2'));
});
test('Cookie 按域名、路径、Secure 和有效期隔离；拒绝恶意 Domain', () => {
  const jar = new CookieJar();
  const url = new URL('https://login.douyin.com/a/b');
  jar.absorb(url, [
    'host=one; Secure',
    'shared=two; Domain=.douyin.com; Path=/; Secure',
    'bad=secret; Domain=evil.example',
    'expired=gone; Max-Age=0',
    'x=gone; Max-Age=0; Expires=Thu, 01 Jan 2099 00:00:00 GMT',
  ]);
  assert.equal(jar.header(new URL('https://www.douyin.com/')), 'shared=two');
  assert.equal(jar.header(new URL('https://evil.example/')), '');
  assert.equal(jar.header(new URL('http://login.douyin.com/a/b')), '');
  assert.match(jar.header(url), /host=one/);
  assert.match(jar.header(new URL('https://login.douyin.com/a')), /host=one/);
  assert.doesNotMatch(jar.header(new URL('https://login.douyin.com/abc')), /host=/);
  jar.absorb(url, ['shared=; Domain=.douyin.com; Path=/; Max-Age=0']);
  assert.equal(jar.header(new URL('https://www.douyin.com/')), '');
});
test('Passport 保持会话标识，签名使用上游要求的编码，表单保留原值', async () => {
  let signedQuery = '',
    signedBody = '';
  const http = new Http(new CookieJar(), async (input, init) => {
    const u = new URL(String(input));
    assert.equal(u.searchParams.get('a_bogus'), 'test-signature');
    assert.equal(new URLSearchParams(String(init?.body)).get('token'), 'test+token/=');
    assert.equal(new Headers(init?.headers).get('x-tt-passport-verify-portrait'), 'stable.login');
    return Response.json({ data: { status: 'new', error_code: 0 } });
  });
  const passport = new Passport(http, 'stable.login');
  passport.signer.sign = (query, body) => {
    signedQuery = query;
    signedBody = body || '';
    return 'test-signature';
  };
  await passport.poll('test+token/=');
  assert.match(signedQuery, /request_host=https%253A%252F%252Fwww\.douyin\.com/);
  assert.match(signedBody, /token=test%2Btoken%2F%3D/);
  assert.match(signedBody, /next=https%3A%2F%2Fwww\.douyin\.com/);
});
test('登录跳转逐跳接收 Cookie；禁止向外部地址转发', async () => {
  let count = 0;
  const transport: typeof fetch = async () => {
    count++;
    return new Response(null, { status: 302, headers: { Location: 'https://evil.example/steal' } });
  };
  await assert.rejects(
    new Http(new CookieJar(), transport).redirects('https://sso.douyin.com/x'),
    /非登录协议域名/,
  );
  assert.equal(count, 1);
});
test('纯协议分页读取与取消，复核其他记录保留', async () => {
  const f = fixture();
  const bot = new Douyin(new Http(new CookieJar(), f.transport), cfg);
  const s = await bot.scan();
  assert.equal(s.complete, true);
  assert.equal(s.pages, 2);
  assert.equal(s.videos.length, 2);
  const after = await bot.cancel(s.videos[0]);
  assert.deepEqual(
    after.videos.map((v) => v.id),
    ['102'],
  );
  assert.deepEqual(f.writes, ['101']);
});
test('拒绝未扫描 ID、缺少 CSRF、协议报错和未移除结果', async () => {
  for (const options of [{ badCSRF: true }, { rejected: true }, { noEffect: true }]) {
    const f = fixture(new Set(['101']), options),
      bot = new Douyin(new Http(new CookieJar(), f.transport), cfg);
    const s = await bot.scan();
    await assert.rejects(bot.cancel({ ...s.videos[0], id: '999' }), /本轮推荐接口/);
    assert.equal(f.writes.length, 0);
    await assert.rejects(
      bot.cancel(s.videos[0]),
      options.badCSRF ? /CSRF/ : options.rejected ? /未确认/ : /确认移除/,
    );
  }
});
test('重复游标保留不完整标记，不误认为已读完', async () => {
  const f = fixture(new Set(['101', '102']), { loop: true });
  const s = await new Douyin(new Http(new CookieJar(), f.transport), cfg).scan();
  assert.equal(s.complete, false);
});
test('扫码会话加密保存，新的服务实例恢复后完成登录和读取', async () => {
  const f = fixture(),
    store = new Store(sqlite(':memory:')),
    mail = async () => {
      throw Error('unused');
    };
  const first = new Service(cfg, store, mail, f.transport);
  await first.startLogin();
  const saved = (await store.get('login'))!;
  assert.ok(!saved.includes('test-token'));
  assert.ok(!saved.includes('anonymous'));
  const second = new Service(cfg, store, mail, f.transport);
  assert.equal((await second.loginImage()).length, 8);
  assert.equal((await second.finishLogin()).ok, true);
  assert.equal(f.valid(), true);
  assert.equal(await store.get('login'), null);
  assert.ok(!(await store.get('auth'))!.includes('logged-in'));
  const third = new Service(cfg, store, mail, f.transport);
  const result = await third.preview();
  assert.equal(result.videos.length, 2);
});
