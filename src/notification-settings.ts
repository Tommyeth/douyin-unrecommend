import { validateChannels, type Config } from './config.js';
import { seal, unseal } from './crypto.js';
import type { Store } from './store.js';
import { SafeError, type Channel } from './types.js';

const key = 'notification_channels';
const secrets = ['url', 'key', 'token', 'password'] as const;
export async function notificationChannels(store: Store, cfg: Config): Promise<Channel[]> {
  const raw = await store.get(key);
  return raw === null ? cfg.channels : validateChannels(await unseal(raw, cfg.authSecret));
}
export async function notificationSettings(store: Store, cfg: Config) {
  const channels = await notificationChannels(store, cfg);
  return {
    source: (await store.get(key)) === null ? 'environment' : 'panel',
    channels: channels.map(({ url, key, token, password, ...publicFields }) => ({
      ...publicFields,
      saved: { url: !!url, key: !!key, token: !!token, password: !!password },
    })),
  };
}
export async function saveNotificationSettings(store: Store, cfg: Config, raw: unknown) {
  if (!raw || typeof raw !== 'object')
    throw new SafeError('NOTIFICATIONS', '通知设置格式无效。', 400);
  const input = raw as { source?: string; channels?: unknown };
  return store.lock(async () => {
    let channels: Channel[];
    if (input.source === 'environment') {
      channels = cfg.channels;
      await store.delete(key);
    } else {
      if (!Array.isArray(input.channels) || input.channels.length > 8)
        throw new SafeError('NOTIFICATIONS', '最多配置 8 个通知渠道。', 400);
      const previous = await notificationChannels(store, cfg);
      channels = validateChannels(
        input.channels.map((item: unknown) => {
          if (!item || typeof item !== 'object') return item;
          const next = { ...item } as Record<string, unknown>;
          const old = previous.find((c) => c.name === next.name && c.type === next.type);
          for (const field of secrets)
            if (next[field] === undefined && old?.[field]) next[field] = old[field];
          return next;
        }),
      );
      await store.set(key, await seal(channels, cfg.authSecret));
    }
    // Removing a destination also discards its unsent notices; do not replay them to a reused name.
    const names = channels.map((c) => c.name);
    await store.db.run(
      names.length
        ? `DELETE FROM outbox WHERE sent_at IS NULL AND channel NOT IN (${names.map(() => '?').join(',')})`
        : 'DELETE FROM outbox WHERE sent_at IS NULL',
      ...names,
    );
    return notificationSettings(store, cfg);
  });
}
