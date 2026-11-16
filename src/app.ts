import { Hono } from 'hono';
import { validToken } from './crypto.js';
import { safeError } from './types.js';
import type { Service } from './service.js';
import { html } from './ui.js';

export function app(service: Service) {
  const api = new Hono();
  api.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    await next();
  });
  api.get('/', (c) => c.html(html));
  api.get('/healthz', (c) => c.json({ ok: true }));
  api.use('/api/*', async (c, next) => {
    const auth = c.req.header('Authorization') ?? '';
    if (!auth.startsWith('Bearer ') || !(await validToken(auth.slice(7), service.cfg.adminToken)))
      return c.json({ error: 'UNAUTHORIZED', message: '管理员口令无效。' }, 401);
    const origin = c.req.header('Origin');
    if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: 'ORIGIN' }, 403);
    await next();
  });
  api.get('/api/status', async (c) => c.json(await service.status()));
  api.post('/api/settings', async (c) => {
    const body = await c.req.json<{ mode: unknown; interval: unknown }>();
    return c.json(await service.setSettings(body.mode, body.interval));
  });
  api.post('/api/login/start', async (c) => c.json(await service.startLogin()));
  api.get(
    '/api/login/image',
    async (c) =>
      new Response(new Uint8Array(await service.loginImage()), {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' },
      }),
  );
  api.post('/api/login/finish', async (c) => c.json(await service.finishLogin()));
  api.post('/api/poll', async (c) => c.json(await service.poll()));
  api.post('/api/clear/preview', async (c) => c.json(await service.preview()));
  api.post('/api/clear', async (c) => {
    if (Number(c.req.header('Content-Length') ?? 0) > 1024)
      return c.json({ error: 'TOO_LARGE' }, 413);
    const body = await c.req.json<{ token: string }>();
    return c.json(await service.clear(body.token));
  });
  api.get('/api/notifications/config', async (c) => c.json(await service.notificationSettings()));
  api.post('/api/notifications/config', async (c) => {
    const body = await c.req.text();
    if (body.length > 16384) return c.json({ error: 'TOO_LARGE', message: '通知设置过大。' }, 413);
    return c.json(await service.saveNotificationSettings(JSON.parse(body)));
  });
  api.post('/api/notifications/test', async (c) => c.json(await service.testNotify()));
  api.onError((e, c) => {
    const err = safeError(e);
    return c.json({ error: err.code, message: err.message }, err.status as 400);
  });
  return api;
}
