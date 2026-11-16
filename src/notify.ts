import { smtp } from './smtp.js';
import type { Store } from './store.js';
import { SafeError, type Channel, type MailConnect, type Notice } from './types.js';

export async function deliver(
  channel: Channel,
  notice: Notice,
  connect: MailConnect,
  request: typeof fetch = fetch,
) {
  if (channel.type === 'smtp') return smtp(connect, channel, notice);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Idempotency-Key': notice.id,
  };
  let body: unknown = notice;
  if (channel.type === 'bark')
    body = {
      device_key: channel.key,
      title: notice.title,
      body: notice.body,
      url: notice.url,
      group: '抖音推荐防误触',
    };
  if (channel.type === 'wecom')
    body = {
      msgtype: 'text',
      text: { content: `${notice.title}\n${notice.body}\n${notice.url ?? ''}` },
    };
  if (channel.type === 'webhook' && channel.token)
    headers.Authorization = `Bearer ${channel.token}`;
  const response = await request(channel.url!, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new SafeError('NOTIFY_HTTP', '通知渠道返回 HTTP 错误。', 502);
  if (channel.type === 'wecom' || channel.type === 'bark') {
    const data = (await response.json()) as { errcode?: number; code?: number };
    if (
      (channel.type === 'wecom' && data.errcode !== 0) ||
      (channel.type === 'bark' && data.code !== 200)
    )
      throw new SafeError('NOTIFY_REJECTED', '通知渠道未接受消息。', 502);
  }
}

export async function flush(
  store: Store,
  channels: Channel[],
  connect: MailConnect,
  now = Date.now(),
  deadline = Infinity,
) {
  const rows = await store.db.all<{
    id: string;
    channel: string;
    payload: string;
    attempts: number;
  }>(
    'SELECT id,channel,payload,attempts FROM outbox WHERE sent_at IS NULL AND next_at<=? ORDER BY created_at LIMIT 6',
    now,
  );
  let sent = 0,
    failed = 0;
  for (const row of rows) {
    // Reserve up to 30 seconds for SMTP connect + transaction. Leave remaining rows queued.
    if (Date.now() + 32000 > deadline) break;
    const channel = channels.find((c) => c.name === row.channel);
    if (!channel) continue;
    try {
      await deliver(channel, JSON.parse(row.payload), connect);
      await store.db.run(
        'UPDATE outbox SET sent_at=? WHERE id=? AND channel=?',
        now,
        row.id,
        row.channel,
      );
      sent++;
    } catch {
      const delay = Math.min(86400000, 60000 * 2 ** Math.min(row.attempts, 10));
      await store.db.run(
        'UPDATE outbox SET attempts=attempts+1,next_at=? WHERE id=? AND channel=?',
        now + delay,
        row.id,
        row.channel,
      );
      failed++;
    }
  }
  await store.db.run(
    'DELETE FROM outbox WHERE sent_at IS NOT NULL AND sent_at<?',
    now - 30 * 86400000,
  );
  return { sent, failed };
}
