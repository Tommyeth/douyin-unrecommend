import { Hono } from 'hono';
import { config } from '../config.js';
import { validToken } from '../crypto.js';
import { nodeMail } from '../node.js';
import { SafeError, safeError } from '../types.js';
import { VercelHybridService } from './hybrid-service.js';
import { BrowserService } from '../browser/service.js';
import type { LaunchBrowser } from '../browser/launch.js';
import { renderHtml } from '../ui.js';
import { vercelHybridPolicy, type BrowserPolicy } from '../browser/policy.js';
import {
  blobBackend,
  changeState,
  readState,
  requestLoginCancel,
  queueLoginInput,
  type StateBackend,
} from './state.js';

export function vercelApp(
  env: Record<string, unknown> = process.env,
  backend?: StateBackend,
  launch?: LaunchBrowser,
  options: {
    policy?: BrowserPolicy;
    transport?: typeof fetch;
    desktop?: {
      cookie(session: string, origin: string): Promise<string>;
      close(session: string): void;
    };
  } = {},
) {
  const policy = options.policy ?? vercelHybridPolicy;
  const cfg = config(env);
  backend ??= blobBackend(cfg.authSecret);
  const service = (store: import('../store.js').Store) =>
    policy.runtime === 'vercel-hybrid'
      ? new VercelHybridService(cfg, store, nodeMail, launch, policy, options.transport)
      : new BrowserService(cfg, store, nodeMail, launch, policy);
  const change = <T>(fn: (s: BrowserService) => Promise<T>) =>
    changeState(backend!, (store) => fn(service(store)));
  const api = new Hono();
  api.use('*', async (c, next) => {
    const socketOrigin = new URL(String(env.PUBLIC_ORIGIN || c.req.url));
    socketOrigin.protocol = socketOrigin.protocol === 'https:' ? 'wss:' : 'ws:';
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob:${policy.desktop ? ' data:' : ''}; connect-src 'self'${policy.desktop ? ' ' + socketOrigin.origin : ''}; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
    );
    await next();
  });
  api.get('/', (c) => c.html(renderHtml(true, policy)));
  api.get('/healthz', (c) => c.json({ ok: true, runtime: policy.runtime }));
  api.use('/api/*', async (c, next) => {
    const auth = c.req.header('Authorization') ?? '';
    if (!auth.startsWith('Bearer ') || !(await validToken(auth.slice(7), cfg.adminToken)))
      return c.json({ error: 'UNAUTHORIZED', message: '管理员口令无效。' }, 401);
    const origin = c.req.header('Origin');
    const expectedOrigin = new URL(String(env.PUBLIC_ORIGIN || c.req.url));
    // Vercel terminates TLS before the Node adapter, whose internal request URL is HTTP.
    // Keep matching the routed host, without trusting a client-supplied forwarded header.
    if (env.VERCEL === '1') expectedOrigin.protocol = 'https:';
    if (origin && origin !== expectedOrigin.origin) return c.json({ error: 'ORIGIN' }, 403);
    if (Number(c.req.header('Content-Length') ?? 0) > 2048)
      return c.json({ error: 'TOO_LARGE' }, 413);
    await next();
  });
  api.get('/api/status', async (c) =>
    c.json(
      await readState(backend!, async (store, busy) => ({
        ...(await service(store).status()),
        busy,
        runtime: policy.runtime,
        capabilities: policy,
      })),
    ),
  );
  api.post('/api/settings', async (c) => {
    const { mode, interval } = await c.req.json();
    return c.json(await change((s) => s.setSettings(mode, interval)));
  });
  for (const [path, action] of [
    ['session/upgrade', 'upgradeSession'],
    ['session/validate', 'validateCandidate'],
  ] as const) {
    api.post('/api/' + path, async (c) =>
      c.json(
        await change(async (s) => {
          if (!(s instanceof VercelHybridService))
            throw new SafeError('UNSUPPORTED', '此部署不提供协议会话转换。', 404);
          return s[action]();
        }),
      ),
    );
  }
  api.post('/api/account/refresh', async (c) => c.json(await change((s) => s.refreshProfile())));
  api.get('/api/account/avatar', async (c) => {
    const avatar = await readState(backend!, (store) => service(store).avatar());
    return c.body(new Uint8Array(Buffer.from(avatar.data, 'base64')), 200, {
      'Content-Type': avatar.mime,
    });
  });
  api.post('/api/poll', async (c) => c.json(await change((s) => s.poll())));
  api.post('/api/clear/preview', async (c) => c.json(await change((s) => s.preview())));
  api.post('/api/clear', async (c) => {
    const { token } = await c.req.json();
    return c.json(await change((s) => s.clear(token)));
  });
  api.post('/api/notifications/test', async (c) => c.json(await change((s) => s.testNotify())));
  api.post('/api/login/cancel', async (c) => c.json(await requestLoginCancel(backend!)));
  api.post('/api/login/input', async (c) =>
    c.json(await queueLoginInput(backend!, await c.req.json())),
  );
  api.post('/api/desktop/session', async (c) => {
    if (!options.desktop || !policy.desktop)
      throw new SafeError('DESKTOP_DISABLED', '此部署不提供桌面连接。', 404);
    const { session } = await c.req.json();
    const origin = new URL(String(env.PUBLIC_ORIGIN || c.req.url)).origin;
    c.header('Set-Cookie', await options.desktop.cookie(session, origin));
    return c.json({ ok: true });
  });
  api.post('/api/login/stream', (c) => {
    const controller = new AbortController();
    const signal = AbortSignal.any([c.req.raw.signal, controller.signal]);
    const encoder = new TextEncoder();
    let cancelled = false;
    let session = '';
    const stream = new ReadableStream<Uint8Array>({
      async start(output) {
        const emit = (value: unknown) => {
          if (!cancelled) output.enqueue(encoder.encode(JSON.stringify(value) + '\n'));
        };
        emit({ type: 'waiting' });
        try {
          await changeState(
            backend!,
            (store, control) => {
              session = control.session;
              return service(store).login(signal, emit, control);
            },
            'login',
            Math.max(360000, policy.loginTimeout + 60000),
          );
          emit({ type: 'confirmed' });
        } catch (e) {
          const error = safeError(e);
          emit({ type: 'error', code: error.code, message: error.message });
        } finally {
          options.desktop?.close(session);
          if (!cancelled) output.close();
        }
      },
      cancel() {
        cancelled = true;
        controller.abort();
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
  api.onError((e, c) => {
    const err = safeError(e);
    return c.json({ error: err.code, message: err.message }, err.status as 400);
  });
  return api;
}

export async function scheduledPoll(
  scheduledAt: number,
  executionId: string,
  env: Record<string, unknown> = process.env,
  backend?: StateBackend,
  launch?: LaunchBrowser,
  policy: BrowserPolicy = vercelHybridPolicy,
  transport: typeof fetch = fetch,
) {
  const cfg = config(env);
  backend ??= blobBackend(cfg.authSecret);
  const due = await readState(backend, async (store) => {
    if (!(await store.get('auth'))) return false;
    if (
      policy.runtime === 'vercel-hybrid' &&
      !(await new VercelHybridService(cfg, store, nodeMail, launch, policy, transport).status())
        .loggedIn
    )
      return false;
    return (
      scheduledAt >= Number((await store.get('next_poll')) ?? 0) &&
      (await store.get('last_schedule_id')) !== executionId
    );
  });
  if (!due) return { skipped: true };
  try {
    return await changeState(backend, async (store) => {
      if ((await store.get('last_schedule_id')) === executionId) return { skipped: true };
      await store.set('last_schedule_id', executionId);
      const service =
        policy.runtime === 'vercel-hybrid'
          ? new VercelHybridService(cfg, store, nodeMail, launch, policy, transport)
          : new BrowserService(cfg, store, nodeMail, launch, policy);
      try {
        const result = await service.poll(true, scheduledAt);
        await store.set(
          'schedule_diagnostic',
          JSON.stringify({
            ok: true,
            scheduledAt,
            finishedAt: Date.now(),
            executionId,
            skipped: result.skipped === true,
          }),
        );
        return result;
      } catch (e) {
        await store.set(
          'schedule_diagnostic',
          JSON.stringify({
            ok: false,
            scheduledAt,
            finishedAt: Date.now(),
            executionId,
            error: safeError(e).code,
          }),
        );
        throw e;
      }
    });
  } catch (e) {
    if (e instanceof SafeError && e.code === 'BUSY') return { skipped: true, reason: 'busy' };
    throw e;
  }
}
