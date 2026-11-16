import { config } from './config.js';
import { localBackend } from './desktop/state.js';
import { startDockerServer } from './desktop/server.js';

process.umask(0o077);
const cfg = config(process.env);
const backend = localBackend(process.env.DATABASE_PATH ?? 'data/browser.sqlite', cfg.authSecret);
const runtime = startDockerServer(process.env, backend);
console.log('抖音推荐管理已启动。');
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    // Let container supervision terminate active Chromium processes with the server.
    void runtime.close().then(() => {
      backend.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
