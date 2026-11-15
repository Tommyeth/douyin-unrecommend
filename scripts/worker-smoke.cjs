const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
async function main() {
  let cancelled = false;
  const token = 'a'.repeat(40);
  const upstream = async (request) => {
    const u = new URL(request.url);
    if (u.hostname === 'mssdk.bytedance.com' && u.pathname === '/web/r/token')
      return new Response('{}', { headers: { 'x-ms-token': 'fixture-ms-token' } });
    if (u.pathname === '/')
      return new Response('', {
        headers: {
          'Set-Cookie': 'passport_csrf_token=fixture; Path=/; Domain=.douyin.com; Secure',
        },
      });
    if (u.pathname === '/ttwid/union/register/')
      return Response.json(
        { status_code: 0 },
        { headers: { 'Set-Cookie': 'ttwid=fixture; Domain=.bytedance.com; Path=/; Secure' } },
      );
    if (u.pathname === '/ttwid/check/') return Response.json({ status_code: 0 });
    if (u.pathname === '/passport/user_info/get_sec_ts/')
      return Response.json(
        { message: 'success' },
        { headers: { 'bd-ticket-guard-sec-ts': '12345' } },
      );
    if (u.pathname === '/service/2/abtest_config/')
      return new Response(null, { headers: { 'x-ware-csrf-token': '0, ticket-csrf, 0, 0, 0' } });
    if (u.pathname === '/passport/ticket_guard/get_client_cert/')
      return Response.json({
        message: 'success',
        data: {
          server_cert:
            'pub.' +
            Buffer.from(
              '046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5',
              'hex',
            ).toString('base64'),
        },
      });
    if (u.pathname === '/passport/web/get_qrcode/')
      return Response.json({
        data: { token: 'fixture-token', qrcode: 'iVBORw0KGgo=', expire_time: 120 },
      });
    if (u.pathname === '/passport/web/check_qrconnect/')
      return Response.json({
        data: { status: 'confirmed', redirect_url: 'https://www.douyin.com/finish' },
      });
    if (u.pathname === '/finish')
      return new Response('ok', {
        headers: { 'Set-Cookie': 'sessionid=fixture-session; Domain=.douyin.com; Path=/; Secure' },
      });
    if (u.pathname === '/aweme/v1/web/user/profile/self/')
      return Response.json({
        status_code: 0,
        user: { uid: '1234567890123456789', sec_uid: 'test-sec-uid', unique_id: 'fixture' },
      });
    if (u.pathname === '/aweme/v1/web/familiar/recommend/feed/')
      return Response.json({
        status_code: 0,
        has_more: false,
        max_cursor: 0,
        total: cancelled ? 0 : 1,
        aweme_list: cancelled ? null : [{ aweme_id: '101', desc: 'worker test' }],
      });
    if (u.pathname === '/aweme/v1/web/familiar/recommend/cancel') {
      if (request.method === 'HEAD')
        return new Response(null, { headers: { 'x-ware-csrf-token': '0, csrf, 0, 0, 0' } });
      assert.equal(request.headers.get('x-secsdk-csrf-token'), 'csrf');
      assert.equal(new URLSearchParams(await request.text()).get('item_id'), '101');
      cancelled = true;
      return Response.json({ status_code: 0 });
    }
    throw new Error('Unexpected mock path');
  };
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: 'dist/worker/worker.js',
      compatibilityDate: '2026-11-15',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: 'smoke' },
      bindings: { ADMIN_TOKEN: token, AUTH_SECRET: 'b'.repeat(40), ACTION_DELAY_MS: '1000' },
      outboundService: upstream,
    }),
  );
  try {
    const db = await mf.getD1Database('DB');
    await db.exec((await readFile('migrations/0001_init.sql', 'utf8')).replaceAll('\n', ' '));
    async function api(path, body) {
      const r = await mf.dispatchFetch('http://localhost/api/' + path, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const j = await r.json();
      assert.equal(r.status, 200, JSON.stringify(j));
      return j;
    }
    assert.equal((await mf.dispatchFetch('http://localhost/api/status')).status, 401);
    await api('login/start', {});
    assert.equal((await api('login/finish', {})).ok, true);
    const preview = await api('clear/preview', {});
    assert.equal(preview.videos.length, 1);
    assert.equal((await api('clear', { token: preview.token })).removed, 1);
    assert.equal((await api('clear/preview', {})).videos.length, 0);
    console.log(
      'workerd + D1: protocol login, signed scan, CSRF cancel, and verification passed (mock upstream).',
    );
  } finally {
    await mf.dispose();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
