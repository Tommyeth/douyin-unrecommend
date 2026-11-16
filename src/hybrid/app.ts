import { Hono } from 'hono';
import { validToken } from '../crypto.js';
import { safeError, SafeError } from '../types.js';
import { renderHtml } from '../ui.js';
import type { HybridService } from './service.js';
import type { LoginDriver } from './login.js';
import type { BrowserPolicy } from '../browser/policy.js';

export const hybridPolicy: BrowserPolicy = {
  runtime: 'cloudflare-hybrid',
  minimumInterval: 900,
  intervalStep: 900,
  triggerSeconds: 900,
  loginTimeout: 600000,
  desktop: false,
};
export function hybridApp(
  service: HybridService,
  login: LoginDriver,
  runtime?: () => Promise<unknown>,
) {
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
  api.get('/', (c) => c.html(renderHtml(true, hybridPolicy)));
  api.get('/healthz', (c) => c.json({ ok: true, runtime: 'cloudflare-hybrid' }));
  api.use('/api/*', async (c, next) => {
    const auth = c.req.header('Authorization') ?? '';
    if (!auth.startsWith('Bearer ') || !(await validToken(auth.slice(7), service.cfg.adminToken)))
      return c.json({ error: 'UNAUTHORIZED', message: '管理员口令无效。' }, 401);
    if (c.req.header('Origin') && c.req.header('Origin') !== new URL(c.req.url).origin)
      return c.json({ error: 'ORIGIN' }, 403);
    if (Number(c.req.header('Content-Length') ?? 0) > 2048)
      return c.json({ error: 'TOO_LARGE' }, 413);
    await next();
  });
  api.get('/api/status', async (c) => c.json(await service.status()));
  api.get('/api/runtime', async (c) => c.json({ browser: await runtime?.() }));
  api.post('/api/settings', async (c) => {
    const b = await c.req.json();
    return c.json(await service.setSettings(b.mode, b.interval));
  });
  api.post('/api/login/start', async (c) => c.json(await login.start()));
  api.post('/api/login/view', async (c) => c.json(await login.view()));
  api.post('/api/login/cancel', async (c) => c.json(await login.cancel()));
  api.post('/api/login/manual', async (c) => {
    if (!login.manual) throw new SafeError('INPUT', '当前部署不支持辅助验证。', 400);
    return c.json(await login.manual(await c.req.json()));
  });
  api.post('/api/login/finish', async (c) => {
    if (!(await login.capture())) return c.json({ ok: false, status: 'waiting' });
    return c.json(await service.validateCandidate());
  });
  api.post('/api/session/validate', async (c) => c.json(await service.validateCandidate()));
  api.post('/api/poll', async (c) => c.json(await service.poll()));
  api.post('/api/clear/preview', async (c) => c.json(await service.preview()));
  api.post('/api/clear', async (c) => c.json(await service.clear((await c.req.json()).token)));
  api.post('/api/notifications/test', async (c) => c.json(await service.testNotify()));
  api.post('/api/account/refresh', async (c) => c.json(await service.refreshProfile()));
  api.get('/api/account/avatar', async (c) => {
    const avatar = (await service.profile())?.avatar;
    if (!avatar) throw new SafeError('AVATAR_MISSING', '头像尚未读取。', 404);
    return c.body(new Uint8Array(Buffer.from(avatar.data, 'base64')), 200, {
      'Content-Type': avatar.mime,
    });
  });
  api.onError((e, c) => {
    const err = safeError(e);
    return c.json({ error: err.code, message: err.message }, err.status as 400);
  });
  return api;
}
