import { connect as connectSocket } from 'cloudflare:sockets';
import challengeWasm from './generated/quickjs.wasm';
import canvasWasm from './generated/canvaskit.wasm';
import { configureCanvasWasm } from './protocol/canvas-host.js';
import { configureChallengeWasm } from './protocol/challenge-vm.js';
import { app } from './app.js';
import { config } from './config.js';
import { Service } from './service.js';
import { Store } from './store.js';
import { safeError, type MailConnect, type Sql } from './types.js';
configureChallengeWasm(challengeWasm);
configureCanvasWasm(canvasWasm);

export interface Env extends Record<string, unknown> {
  DB: D1Database;
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
  return new Service(config(env), new Store(db), mail);
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
