import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { connect } from 'node:tls';
import { Duplex } from 'node:stream';
import { chromium, type Browser } from 'playwright';
import type { Browsers, MailConnect, Sql } from './types.js';

export function sqlite(path: string): Sql {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  return {
    async run(sql, ...params) {
      return Number(db.prepare(sql).run(...params).changes);
    },
    async all<T>(sql: string, ...params: (string | number | null)[]) {
      return db.prepare(sql).all(...params) as T[];
    },
  };
}
export class NodeBrowsers implements Browsers {
  sessions = new Map<string, { browser: Browser; expires: number }>();
  async launch(login = false) {
    for (const [id, s] of this.sessions)
      if (s.expires < Date.now()) {
        await s.browser.close().catch(() => {});
        this.sessions.delete(id);
      }
    const browser = await chromium.launch({ headless: process.env.HEADED !== 'true' });
    const id = crypto.randomUUID();
    if (login) {
      this.sessions.set(id, { browser, expires: Date.now() + 180000 });
      browser.on('disconnected', () => this.sessions.delete(id));
    }
    return { browser, id };
  }
  async connect(id: string) {
    const s = this.sessions.get(id);
    if (!s || s.expires < Date.now()) throw new Error('Login expired');
    return s.browser;
  }
  async detach() {}
  async close() {
    await Promise.all([...this.sessions.values()].map((s) => s.browser.close()));
  }
}
export const nodeMail: MailConnect = async (host, port) => {
  const socket = connect({ host, port, servername: host, rejectUnauthorized: true });
  socket.setTimeout(15000, () => socket.destroy(new Error('SMTP timeout')));
  await new Promise<void>((resolve, reject) => {
    socket.once('secureConnect', resolve);
    socket.once('error', reject);
  });
  const streams = Duplex.toWeb(socket);
  return {
    readable: streams.readable as ReadableStream<Uint8Array>,
    writable: streams.writable as WritableStream<Uint8Array>,
    async close() {
      socket.destroy();
    },
  };
};
