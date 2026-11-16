import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { seal, unseal } from '../crypto.js';
import { SafeError } from '../types.js';
import { emptyState, type State, type StateBackend } from '../vercel/state.js';

/** Encrypted snapshots, with SQLite compare-and-swap across processes. */
export function localBackend(path: string, secret: string): StateBackend & { close(): void } {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS browser_state (id INTEGER PRIMARY KEY CHECK(id=1), revision TEXT NOT NULL, sealed TEXT NOT NULL)',
  );
  return {
    async read() {
      const row = db.prepare('SELECT revision, sealed FROM browser_state WHERE id=1').get();
      if (!row) return { state: emptyState(), etag: null };
      try {
        const state = await unseal<State>(String(row.sealed), secret);
        if (
          state.version !== 1 ||
          !['kv', 'videos', 'outbox'].every((t) =>
            Array.isArray(state.rows?.[t as keyof State['rows']]),
          )
        )
          throw Error('schema');
        return { state, etag: String(row.revision) };
      } catch {
        throw new SafeError(
          'STATE_DECRYPT',
          '状态无法解密，请核对 AUTH_SECRET，未覆盖已有数据。',
          503,
        );
      }
    },
    async write(state, etag) {
      const revision = crypto.randomUUID();
      state.revision = revision;
      const encrypted = await seal(state, secret);
      const result =
        etag === null
          ? db
              .prepare('INSERT OR IGNORE INTO browser_state(id, revision, sealed) VALUES(1,?,?)')
              .run(revision, encrypted)
          : db
              .prepare('UPDATE browser_state SET revision=?, sealed=? WHERE id=1 AND revision=?')
              .run(revision, encrypted, etag);
      if (Number(result.changes) !== 1)
        throw new SafeError('BUSY', '状态已由另一个任务更新，请稍后重试。', 409);
      return revision;
    },
    close() {
      db.close();
    },
  };
}
