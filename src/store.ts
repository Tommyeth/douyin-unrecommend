import { SafeError, type Notice, type Snapshot, type Sql, type Video } from './types.js';
export class Store {
  constructor(public db: Sql) {}
  async get(key: string): Promise<string | null> {
    return (
      (await this.db.all<{ value: string }>('SELECT value FROM kv WHERE key=?', key))[0]?.value ??
      null
    );
  }
  async set(key: string, value: string) {
    await this.db.run(
      'INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key,
      value,
    );
  }
  async delete(key: string) {
    await this.db.run('DELETE FROM kv WHERE key=?', key);
  }
  async lock<T>(fn: () => Promise<T>): Promise<T> {
    const owner = crypto.randomUUID();
    const now = Date.now();
    const changed = await this.db.run(
      `INSERT INTO leases(name,owner,expires) VALUES('operation',?,?)
      ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE leases.expires<?`,
      owner,
      now + 300000,
      now,
    );
    if (!changed) throw new SafeError('BUSY', '另一个操作正在执行，请稍后再试。', 409);
    try {
      return await fn();
    } finally {
      await this.db.run("DELETE FROM leases WHERE name='operation' AND owner=?", owner);
    }
  }
  async observe(snapshot: Snapshot, channels: string[], ignore: Set<string>, now = Date.now()) {
    const account = await this.get('account');
    if (account && account !== snapshot.account)
      throw new SafeError('ACCOUNT_CHANGED', '登录账号与已绑定账号不同，请使用原账号重新扫码。');
    await this.set('account', snapshot.account);
    const seen = new Set(snapshot.videos.map((v) => v.id));
    const rows = await this.db.all<Video & { active: number; episode: number }>(
      'SELECT * FROM videos',
    );
    const map = new Map(rows.map((v) => [v.id, v]));
    let added = 0;
    for (const video of snapshot.videos) {
      const old = map.get(video.id);
      const episode = old ? old.episode + (old.active ? 0 : 1) : 1;
      // Queue first: if execution is interrupted, INSERT OR IGNORE makes the retry safe.
      if ((!old || !old.active) && !ignore.has(video.id)) {
        await this.enqueue(
          {
            id: `new:${video.id}:${episode}`,
            kind: 'new_recommendation',
            title: '抖音发现新增推荐',
            body: `检测到推荐记录，可能是误触，请核对。\n${video.title}`,
            url: video.url,
          },
          channels,
          now,
        );
        added++;
      }
      await this.db.run(
        `INSERT INTO videos(id,title,url,active,episode,first_seen,last_seen) VALUES(?,?,?,1,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,url=excluded.url,active=1,episode=excluded.episode,last_seen=excluded.last_seen`,
        video.id,
        video.title,
        video.url,
        episode,
        now,
        now,
      );
    }
    if (snapshot.complete) {
      for (const old of rows)
        if (old.active && !seen.has(old.id))
          await this.db.run('UPDATE videos SET active=0 WHERE id=?', old.id);
    }
    await this.set(
      'last_scan',
      JSON.stringify({
        at: now,
        count: seen.size,
        complete: snapshot.complete,
        pages: snapshot.pages,
        added,
      }),
    );
    return added;
  }
  async enqueue(notice: Notice, channels: string[], now = Date.now()) {
    for (const channel of channels)
      await this.db.run(
        'INSERT OR IGNORE INTO outbox(id,channel,payload,created_at) VALUES(?,?,?,?)',
        notice.id,
        channel,
        JSON.stringify(notice),
        now,
      );
  }
  async removed(video: Video, channels: string[]) {
    const row = (
      await this.db.all<{ episode: number }>('SELECT episode FROM videos WHERE id=?', video.id)
    )[0];
    await this.enqueue(
      {
        id: `removed:${video.id}:${row?.episode ?? 1}`,
        kind: 'cancelled',
        title: '抖音推荐已取消',
        body: video.title,
        url: video.url,
      },
      channels,
    );
    await this.db.run('UPDATE videos SET active=0 WHERE id=?', video.id);
  }
}
