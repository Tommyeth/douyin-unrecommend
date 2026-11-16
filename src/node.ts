import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { connect } from 'node:tls';
import { Duplex } from 'node:stream';
import type { MailConnect, Sql } from './types.js';

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
