import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Signer, sm3 } from '../src/protocol/sign.js';
import { Http, CookieJar } from '../src/protocol/http.js';
import { Douyin, FEED, CANCEL, SELF } from '../src/douyin.js';
import { config } from '../src/config.js';
import { tokenReport, refreshToken } from '../src/protocol/token.js';
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
  const transport: typeof fetch = async (input, init) => {
    const u = new URL(String(input)),
      headers = new Headers(init?.headers),
      method = init?.method || 'GET';
    if (u.hostname === 'mssdk.bytedance.com' && u.pathname === '/web/r/token')
      return new Response('{}', { headers: { 'x-ms-token': 'fixture-ms-token' } });
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
  return { transport, writes };
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
test('mssdk 编码匹配 PyCryptodome 独立向量，不把旧 Cookie 当作新令牌', async () => {
  assert.equal(tokenReport('{"k":"中文"}', 42), 'fwOu8k1USpMvszBE6ZlULf==');
  const jar = new CookieJar();
  jar.set('msToken', 'stale-token', 'bytedance.com');
  await assert.rejects(
    refreshToken(new Http(jar, async () => new Response('{}'))),
    /未取得抖音会话令牌/,
  );
  const http = new Http(
    jar,
    async () => new Response('{}', { headers: { 'x-ms-token': 'rotated-token' } }),
  );
  await refreshToken(http);
  assert.equal(jar.get('msToken'), 'rotated-token');
});

test('协议请求拒绝未允许的主机，不发送 Cookie', async () => {
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    return new Response('{}');
  };
  const jar = new CookieJar();
  jar.set('sessionid', 'fixture-session');
  const http = new Http(jar, transport);
  for (const url of [
    'https://evil.example/steal',
    'https://www.douyin.com.evil.example/',
    'http://www.douyin.com/',
    'https://user:password@www.douyin.com/',
    'https://www.douyin.com:8443/',
  ])
    await assert.rejects(http.request(url), /未允许的抖音协议域名/);
  assert.equal(calls, 0);
});
