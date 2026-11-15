import { serve } from '@hono/node-server';
import { app } from './app.js';
import { config } from './config.js';
import { NodeBrowsers, nodeMail, sqlite } from './node.js';
import { Service } from './service.js';
import { Store } from './store.js';
import { safeError } from './types.js';

process.umask(0o077);
const browsers = new NodeBrowsers();
const service = new Service(
  config(process.env),
  new Store(sqlite(process.env.DATABASE_PATH ?? 'data/state.sqlite')),
  browsers,
  nodeMail,
);
const server = serve({
  fetch: app(service).fetch,
  hostname: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 8787),
});
console.log('抖音推荐防误触已启动，请打开管理页面进行扫码登录。');
const tick = () =>
  void service.poll(true).catch((e) => console.error('poll failed:', safeError(e).code));
const timer = setInterval(tick, 60000);
tick();
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    clearInterval(timer);
    server.close();
    void browsers.close().finally(() => process.exit(0));
  });
