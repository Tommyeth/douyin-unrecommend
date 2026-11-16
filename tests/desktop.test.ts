import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as httpServer } from 'node:http';
import { createServer as tcpServer, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { localBackend } from '../src/desktop/state.js';
import { desktopGateway } from '../src/desktop/gateway.js';
import { changeState, readState } from '../src/vercel/state.js';
import { vercelApp } from '../src/vercel/app.js';
import { dockerPolicy, vercelPolicy } from '../src/browser/policy.js';

const secret = 'fixture-encryption-secret-'.repeat(3);
const env = { ADMIN_TOKEN: 'fixture-admin-'.repeat(4), AUTH_SECRET: secret };
test('Docker 加密状态重启恢复、错误密钥拒绝、并发版本不可覆盖', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'douyin-db-'));
  const file = join(dir, 'browser.sqlite');
  let b = localBackend(file, secret);
  try {
    await changeState(b, (s) => s.set('auth', 'fixture-private-cookie'));
    b.close();
    b = localBackend(file, secret);
    assert.equal(await readState(b, (s) => s.get('auth')), 'fixture-private-cookie');
    assert.equal((await readFile(file)).includes(Buffer.from('fixture-private-cookie')), false);
    const other = localBackend(file, 'wrong-key');
    await assert.rejects(other.read(), /无法解密/);
    other.close();
    const one = await b.read(),
      two = await b.read();
    await b.write(one.state, one.etag);
    await assert.rejects(b.write(two.state, two.etag), /另一个任务/);
  } finally {
    b.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('Docker 可保存 300 秒，Vercel 按实际调度限制，API 返回相同能力', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'douyin-policy-'));
  const b = localBackend(join(dir, 'state.sqlite'), secret);
  try {
    for (const policy of [dockerPolicy, vercelPolicy]) {
      const app = vercelApp(env, b, undefined, { policy });
      const headers = {
        Authorization: 'Bearer ' + env.ADMIN_TOKEN,
        'Content-Type': 'application/json',
      };
      const save = (interval: number) =>
        app.request('/api/settings', {
          method: 'POST',
          headers,
          body: JSON.stringify({ mode: 'auto_cancel', interval }),
        });
      assert.equal((await save(300)).status, policy === dockerPolicy ? 200 : 400);
      assert.equal((await save(policy.minimumInterval)).status, 200);
      assert.equal((await save(policy.minimumInterval + 1)).status, 400);
      const status = (await (await app.request('/api/status', { headers })).json()) as any;
      assert.equal(status.capabilities.minimumInterval, policy.minimumInterval);
      assert.equal(status.interval, policy.minimumInterval);
    }
  } finally {
    b.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('noVNC 仅允许同源有效登录会话，结束后撤销现有连接', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'douyin-vnc-'));
  const b = localBackend(join(dir, 'state.sqlite'), secret);
  const rfb = tcpServer((socket) => {
    socket.write('RFB 003.008\n');
    socket.on('data', (data) => socket.write(data));
  });
  rfb.listen(0, '127.0.0.1');
  await once(rfb, 'listening');
  const http = httpServer((_req, res) => res.end());
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const gateway = desktopGateway(b, origin, (rfb.address() as AddressInfo).port);
  gateway.attach(http);
  const session = crypto.randomUUID();
  const current = await b.read();
  current.state.lease = { kind: 'login', owner: session, expires: Date.now() + 60000 };
  await b.write(current.state, current.etag);
  const cookie = await gateway.cookie(session, origin);
  assert.match(cookie, /HttpOnly; SameSite=Strict; Path=\/api\/desktop/);
  const connect = (auth: string, from = origin) =>
    new WebSocket(origin.replace('http:', 'ws:') + '/api/desktop/socket', {
      headers: { Cookie: auth, Origin: from },
    });
  const rejected = (auth: string, from = origin) =>
    new Promise<number>((resolve, reject) => {
      const ws = connect(auth, from);
      ws.on('unexpected-response', (_q, r) => {
        resolve(r.statusCode!);
        r.resume();
        ws.terminate();
      });
      ws.on('error', () => {});
      ws.on('open', () => {
        ws.close();
        reject(Error('unauthorized connection'));
      });
    });
  try {
    assert.equal(await rejected(''), 401);
    assert.equal(await rejected(cookie, 'https://attacker.example'), 403);
    const ws = connect(cookie);
    const greeting = once(ws, 'message');
    await once(ws, 'open');
    assert.equal(String((await greeting)[0]), 'RFB 003.008\n');
    const echo = once(ws, 'message');
    ws.send(Buffer.from('fixture-keyboard'));
    assert.equal(String((await echo)[0]), 'fixture-keyboard');
    const closed = once(ws, 'close');
    gateway.close(session);
    await closed;
    assert.equal(await rejected(cookie), 401);
    const expired = await b.read();
    expired.state.lease!.expires = 0;
    await b.write(expired.state, expired.etag);
    await assert.rejects(gateway.cookie(session, origin), /已结束/);
  } finally {
    gateway.shutdown();
    await new Promise<void>((r) => http.close(() => r()));
    await new Promise<void>((r) => rfb.close(() => r()));
    b.close();
    await rm(dir, { recursive: true, force: true });
  }
});
