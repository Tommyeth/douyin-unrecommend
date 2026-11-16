import { connect } from 'cloudflare:sockets';
import { limits, type BrowserWorker } from '@cloudflare/playwright';
import { config } from '../config.js';
import { Store } from '../store.js';
import { safeError, type Sql, type MailConnect } from '../types.js';
import { HybridService } from './service.js';
import { BrowserRunLogin } from './login.js';
import { hybridApp } from './app.js';

export interface HybridEnv extends Record<string, unknown> {
  DB: D1Database;
  BROWSER: BrowserWorker;
}
function services(env: HybridEnv) {
  const db: Sql = {
    async run(sql, ...args) {
      return (
        await env.DB.prepare(sql)
          .bind(...args)
          .run()
      ).meta.changes;
    },
    async all<T>(sql: string, ...args: (string | number | null)[]) {
      return (
        await env.DB.prepare(sql)
          .bind(...args)
          .all<T>()
      ).results;
    },
  };
  const mail: MailConnect = async (host, port) => {
    const socket = connect(
      { hostname: host, port },
      { secureTransport: 'on', allowHalfOpen: false },
    );
    const timer = setTimeout(() => {
      void socket.close().catch(() => {});
    }, 15000);
    try {
      await socket.opened;
    } finally {
      clearTimeout(timer);
    }
    return socket;
  };
  const cfg = config(env),
    store = new Store(db);
  return {
    service: new HybridService(cfg, store, mail),
    login: new BrowserRunLogin(env.BROWSER, cfg, store),
  };
}
export default {
  fetch(request: Request, env: HybridEnv, ctx: ExecutionContext) {
    try {
      const { service, login } = services(env);
      return hybridApp(service, login, () => limits(env.BROWSER)).fetch(request, env, ctx);
    } catch {
      return Response.json(
        { error: 'CONFIG', message: '请检查 Worker 密钥及 D1/Browser Run 绑定。' },
        { status: 503 },
      );
    }
  },
  scheduled(event: ScheduledController, env: HybridEnv, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        const { service, login } = services(env);
        const startedAt = Date.now();
        let outcome: Record<string, unknown>;
        try {
          await login.expire();
          const result = await service.poll(true, event.scheduledTime);
          outcome = { ok: true, skipped: result.skipped === true };
        } catch (e) {
          outcome = { ok: false, error: safeError(e).code };
          console.error('hybrid poll failed:', safeError(e).code);
        }
        await service.store.set(
          'schedule_diagnostic',
          JSON.stringify({
            ...outcome,
            cron: event.cron,
            scheduledAt: event.scheduledTime,
            startedAt,
            finishedAt: Date.now(),
          }),
        );
      })().catch((e) => console.error('hybrid poll failed:', safeError(e).code)),
    );
  },
};
