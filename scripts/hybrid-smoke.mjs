import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { seal, digest } from '../src/crypto.ts';

let cancelled = false,
  browserCalls = 0;
const token = 'a'.repeat(40),
  secret = 'b'.repeat(40);
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: [{ type: 'ESModule', path: 'dist/hybrid/worker.js' }],
    compatibilityDate: '2026-11-16',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'hybrid-smoke' },
    bindings: {
      ADMIN_TOKEN: token,
      AUTH_SECRET: secret,
      MODE: 'auto_cancel',
      POLL_INTERVAL_SECONDS: '900',
      ACTION_DELAY_MS: '1000',
      NOTIFICATIONS_JSON: '[]',
    },
    serviceBindings: {
      BROWSER: async () => {
        browserCalls++;
        throw Error('Daily task must not call Browser Run');
      },
    },
    outboundService: async (request) => {
      const url = new URL(request.url);
      assert.equal(request.headers.get('User-Agent'), 'captured-browser-UA');
      assert.match(request.headers.get('Cookie'), /sessionid=fixture/);
      assert.equal(url.hostname, 'www.douyin.com');
      if (url.pathname === '/aweme/v1/web/user/profile/self/')
        return Response.json({
          status_code: 0,
          user: { uid: '12345', sec_uid: 'test-sec', unique_id: 'fixture' },
        });
      if (url.pathname === '/aweme/v1/web/familiar/recommend/feed/')
        return Response.json({
          status_code: 0,
          has_more: false,
          total: cancelled ? 0 : 1,
          aweme_list: cancelled ? null : [{ aweme_id: '101', desc: '模拟作品' }],
        });
      if (url.pathname === '/aweme/v1/web/familiar/recommend/cancel') {
        if (request.method === 'HEAD')
          return new Response(null, { headers: { 'x-ware-csrf-token': '0, csrf, 0' } });
        assert.equal(request.headers.get('x-secsdk-csrf-token'), 'csrf');
        assert.equal(new URLSearchParams(await request.text()).get('item_id'), '101');
        cancelled = true;
        return Response.json({ status_code: 0 });
      }
      throw Error('Unexpected request path');
    },
  }),
);
try {
  const db = await mf.getD1Database('DB');
  await db.exec((await readFile('migrations/0001_init.sql', 'utf8')).replaceAll('\n', ' '));
  const state = {
    version: 'hybrid-1',
    account: await digest('fixture'),
    userAgent: 'captured-browser-UA',
    platform: 'Linux x86_64',
    geo: [1100, 800, 1100, 800, 1100, 800, 1100, 800],
    query: {},
    counter: 2,
    cookies: ['sessionid', 'msToken'].map((name) => ({
      name,
      value: 'fixture',
      domain: 'douyin.com',
      path: '/',
      hostOnly: false,
      secure: true,
    })),
  };
  await db
    .prepare('INSERT INTO kv(key,value) VALUES (?,?)')
    .bind('candidate_auth', await seal(state, secret))
    .run();
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
  assert.equal((await api('session/validate', {})).status, 'confirmed');
  assert.equal((await api('poll', {})).removed, 1);
  assert.equal((await api('clear/preview', {})).videos.length, 0);
  const worker = await mf.getWorker();
  const scheduledAt = new Date(Date.now() + 901000);
  assert.equal(
    (await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: scheduledAt })).outcome,
    'ok',
  );
  const schedule = (await api('status')).scheduleDiagnostic;
  assert.equal(schedule.ok, true);
  assert.equal(schedule.skipped, false);
  assert.equal(schedule.scheduledAt, scheduledAt.getTime());
  assert.equal((await api('status')).browserStarts, 0);
  assert.equal(browserCalls, 0);
  console.log(
    'hybrid workerd + D1: sealed candidate, pure fetch scan/cancel/recheck, scheduled handler, zero Browser Run calls passed (mock upstream).',
  );
} finally {
  await mf.dispose();
}
