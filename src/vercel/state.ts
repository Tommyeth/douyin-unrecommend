import { get, put } from '@vercel/blob';
import { DatabaseSync } from 'node:sqlite';
import { seal, unseal } from '../crypto.js';
import { Store } from '../store.js';
import { SafeError, type Sql } from '../types.js';
import { schema } from './schema.js';
import { parseLoginInput, type LoginInput, type LoginControl } from '../browser/input.js';

const tables = ['kv', 'videos', 'outbox'] as const;
type Rows = Record<(typeof tables)[number], Record<string, string | number | null>[]>;
export type State = {
  version: 1;
  revision: string;
  rows: Rows;
  lease: null | {
    owner: string;
    expires: number;
    kind?: 'operation' | 'login';
    cancelled?: boolean;
    input?: LoginInput;
    inputIds?: string[];
  };
};
export interface StateBackend {
  read(): Promise<{ state: State; etag: string | null }>;
  write(state: State, etag: string | null): Promise<string>;
}
export const emptyState = (): State => ({
  version: 1,
  revision: crypto.randomUUID(),
  rows: { kv: [], videos: [], outbox: [] },
  lease: null,
});
export function blobBackend(secret: string, pathname = 'douyin/state-v1.sealed'): StateBackend {
  const read = async () => {
    const result = await get(pathname, {
      access: 'private',
      useCache: false,
      abortSignal: AbortSignal.timeout(15000),
    });
    if (!result) return { state: emptyState(), etag: null };
    if (result.statusCode !== 200 || !result.stream || (result.blob.size ?? 0) > 4_000_000)
      throw new SafeError('STATE_READ', '状态文件不可读取或已超出容量。', 503);
    let state: State;
    try {
      state = await unseal<State>(await new Response(result.stream).text(), secret);
    } catch {
      throw new SafeError(
        'STATE_DECRYPT',
        '状态无法解密，请核对 AUTH_SECRET，未覆盖已有数据。',
        503,
      );
    }
    if (state.version !== 1 || !tables.every((t) => Array.isArray(state.rows?.[t])))
      throw new SafeError('STATE_SCHEMA', '状态文件格式无效，未覆盖已有数据。', 503);
    return { state, etag: result.blob.etag };
  };
  return {
    read,
    async write(state, etag) {
      state.revision = crypto.randomUUID();
      const body = await seal(state, secret);
      if (body.length > 4_000_000)
        throw new SafeError('STATE_SIZE', '状态文件超出容量，已停止写入。', 503);
      try {
        const result = await put(pathname, body, {
          access: 'private',
          addRandomSuffix: false,
          allowOverwrite: etag !== null,
          ...(etag ? { ifMatch: etag } : {}),
          contentType: 'application/octet-stream',
          abortSignal: AbortSignal.timeout(15000),
        });
        return result.etag;
      } catch {
        // A successful write can lose its response. Verify our revision before reporting failure.
        const current = await read();
        if (current.state.revision === state.revision && current.etag) return current.etag;
        if (current.etag !== etag)
          throw new SafeError('BUSY', '状态已由另一个任务更新，请稍后重试。', 409);
        throw new SafeError('STATE_WRITE', '状态写入失败，请稍后检查运行结果。', 503);
      }
    },
  };
}

function memory(rows: Rows) {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  try {
    for (const table of tables) {
      const columns = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((x) => String(x.name));
      const insert = db.prepare(
        `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
      );
      for (const row of rows[table]) insert.run(...columns.map((c) => row[c] ?? null));
    }
  } catch {
    db.close();
    throw new SafeError('STATE_SCHEMA', '状态表无法恢复。', 503);
  }
  const sql: Sql = {
    async run(query, ...args) {
      return Number(db.prepare(query).run(...args).changes);
    },
    async all<T>(query: string, ...args: (string | number | null)[]) {
      return db.prepare(query).all(...args) as T[];
    },
  };
  return {
    store: new Store(sql),
    rows: () =>
      Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM ${t}`).all()])) as Rows,
    close: () => db.close(),
  };
}

// Only the encrypted snapshot is durable. SQLite is per invocation, never a /tmp database.
export async function readState<T>(
  backend: StateBackend,
  fn: (store: Store, busy: boolean) => Promise<T>,
) {
  const { state } = await backend.read();
  const db = memory(state.rows);
  try {
    return await fn(db.store, Boolean(state.lease && state.lease.expires > Date.now()));
  } finally {
    db.close();
  }
}
export async function requestLoginCancel(backend: StateBackend) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { state, etag } = await backend.read();
    if (!state.lease || state.lease.kind !== 'login' || state.lease.expires <= Date.now())
      return { cancelled: false };
    if (state.lease.cancelled) return { cancelled: true };
    state.lease.cancelled = true;
    try {
      await backend.write(state, etag);
      return { cancelled: true };
    } catch (e) {
      if (!(e instanceof SafeError) || e.code !== 'BUSY' || attempt === 2) throw e;
    }
  }
}
export async function queueLoginInput(backend: StateBackend, raw: unknown) {
  const input = parseLoginInput(raw);
  for (let attempt = 0; attempt < 3; attempt++) {
    const { state, etag } = await backend.read();
    const lease = state.lease;
    if (
      !lease ||
      lease.kind !== 'login' ||
      lease.owner !== input.session ||
      lease.expires <= Date.now() ||
      lease.cancelled
    )
      throw new SafeError('LOGIN_EXPIRED', '扫码会话已结束，请重新生成。');
    if (lease.input?.id === input.id || lease.inputIds?.includes(input.id))
      return { accepted: true };
    if (lease.input) throw new SafeError('INPUT_BUSY', '上一项操作仍在处理，请稍候。');
    if ((lease.inputIds?.length ?? 0) >= 40)
      throw new SafeError('INPUT_LIMIT', '本次操作已达上限，请重新扫码。');
    lease.input = input;
    try {
      await backend.write(state, etag);
      return { accepted: true };
    } catch (e) {
      if (!(e instanceof SafeError) || e.code !== 'BUSY' || attempt === 2) throw e;
    }
  }
}
async function pollLoginControl(backend: StateBackend, owner: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { state, etag } = await backend.read();
    const lease = state.lease;
    if (!lease || lease.owner !== owner || lease.cancelled || lease.expires <= Date.now())
      return { cancelled: true, input: null };
    if (!lease.input) return { cancelled: false, input: null };
    const input = lease.input;
    delete lease.input;
    lease.inputIds = [...(lease.inputIds ?? []), input.id];
    // Consume before execution: lost responses must not repeat a verification submission.
    try {
      await backend.write(state, etag);
      return { cancelled: false, input };
    } catch (e) {
      if (!(e instanceof SafeError) || e.code !== 'BUSY' || attempt === 2) throw e;
    }
  }
  return { cancelled: false, input: null };
}
export async function changeState<T>(
  backend: StateBackend,
  fn: (store: Store, control: LoginControl) => Promise<T>,
  kind: 'operation' | 'login' = 'operation',
) {
  const { state, etag } = await backend.read();
  if (state.lease && state.lease.expires > Date.now())
    throw new SafeError('BUSY', '已有检测或扫码任务正在运行。', 409);
  const db = memory(state.rows);
  const owner = crypto.randomUUID();
  state.lease = { owner, expires: Date.now() + 360000, kind };
  let claimed: string;
  try {
    claimed = await backend.write(state, etag);
  } catch (e) {
    db.close();
    throw e;
  }
  try {
    return await fn(db.store, {
      session: owner,
      poll: () => pollLoginControl(backend, owner),
    });
  } finally {
    try {
      // CAS also prevents an expired task from overwriting the next lease holder.
      if (kind !== 'login') {
        await backend.write({ ...state, rows: db.rows(), lease: null }, claimed);
      } else {
        for (let attempt = 0; attempt < 4; attempt++) {
          const current = await backend.read();
          if (current.state.lease?.owner !== owner || current.state.lease.expires <= Date.now())
            throw new SafeError('BUSY', '扫码租约已失效，未覆盖其他任务的状态。');
          const cancelled = !!current.state.lease.cancelled;
          try {
            await backend.write(
              { ...current.state, rows: cancelled ? current.state.rows : db.rows(), lease: null },
              current.etag,
            );
          } catch (e) {
            if (e instanceof SafeError && e.code === 'BUSY' && attempt < 3) continue;
            throw e;
          }
          if (cancelled) throw new SafeError('LOGIN_CANCELLED', '已取消扫码。');
          break;
        }
      }
    } finally {
      db.close();
    }
  }
}
