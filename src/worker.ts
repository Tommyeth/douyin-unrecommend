import { launch, connect as connectBrowser, type BrowserWorker } from '@cloudflare/playwright';
import { connect as connectSocket } from 'cloudflare:sockets';
import type { Browser } from 'playwright';
import { app } from './app.js';
import { config } from './config.js';
import { Service } from './service.js';
import { Store } from './store.js';
import { safeError, type Browsers, type MailConnect, type Sql } from './types.js';

export interface Env extends Record<string, unknown> {
  DB: D1Database;
  BROWSER: BrowserWorker;
}
export function workerService(env: Env) {
  const db: Sql = {
    async run(sql, ...params) {
      return (
        await env.DB.prepare(sql)
          .bind(...params)
          .run()
      ).meta.changes;
    },
    async all<T>(sql: string, ...params: (string | number | null)[]) {
      return (
        await env.DB.prepare(sql)
          .bind(...params)
          .all<T>()
      ).results;
    },
  };
  const browsers: Browsers = {
    async launch(login) {
      const b = await launch(env.BROWSER, { keep_alive: login ? 60000 : 10000 });
      return { browser: b as unknown as Browser, id: b.sessionId() };
    },
    async connect(id) {
      return (await connectBrowser(env.BROWSER, id)) as unknown as Browser;
    },
    // 官方支持省略 close 后按 sessionId 重连；二维码请求之间保留远端会话。
    async detach() {},
  };
  const mail: MailConnect = async (host, port) => {
    const socket = connectSocket(
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
  return new Service(config(env), new Store(db), browsers, mail);
}
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    try {
      return app(workerService(env)).fetch(request, env, ctx);
    } catch {
      return Response.json(
        { error: 'CONFIG', message: '配置无效，请检查 Worker Secrets 和环境变量。' },
        { status: 503 },
      );
    }
  },
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      workerService(env)
        .poll(true)
        .catch((e) => console.error('poll failed:', safeError(e).code)),
    );
  },
};
