import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { config } from '../config.js';
import { vercelApp, scheduledPoll } from '../vercel/app.js';
import type { StateBackend } from '../vercel/state.js';
import type { LaunchBrowser } from '../browser/launch.js';
import { dockerPolicy } from '../browser/policy.js';
import { safeError } from '../types.js';
import { desktopGateway } from './gateway.js';

export function startDockerServer(
  env: Record<string, string | undefined>,
  backend: StateBackend,
  launch?: LaunchBrowser,
  rfbPort?: number,
) {
  config(env);
  const policy = { ...dockerPolicy, desktop: env.DESKTOP_ENABLED === '1' };
  const desktop = desktopGateway(backend, env.PUBLIC_ORIGIN, rfbPort);
  const app = vercelApp(env, backend, launch, { policy, desktop });
  app.get('/assets/desktop.js', async (c) =>
    c.body(await readFile('dist/desktop.js', 'utf8'), 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
    }),
  );
  const server = serve({
    fetch: app.fetch,
    hostname: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 8787),
  }) as Server;
  desktop.attach(server);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await scheduledPoll(Date.now(), crypto.randomUUID(), env, backend, launch, policy);
    } catch (e) {
      console.error('poll failed:', safeError(e).code);
    } finally {
      running = false;
    }
  };
  const timer =
    env.DISABLE_SCHEDULER === '1'
      ? undefined
      : setInterval(() => void tick(), policy.triggerSeconds * 1000);
  if (timer) {
    timer.unref();
    void tick();
  }
  return {
    server,
    tick,
    async close() {
      clearInterval(timer);
      desktop.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
