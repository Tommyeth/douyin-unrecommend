import { SafeError, type Channel, type Mode } from './types.js';

export type Config = {
  adminToken: string;
  authSecret: string;
  interval: number;
  mode: Mode;
  maxPages: number;
  maxActions: number;
  actionDelay: number;
  timeout: number;
  ignoreIds: Set<string>;
  channels: Channel[];
  cancelSelector: string;
};
export function config(env: Record<string, unknown>): Config {
  const number = (key: string, fallback: number, min: number, max: number) => {
    const n = Number(env[key] ?? fallback);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new Error(`${key} 必须为 ${min}–${max} 的整数`);
    return n;
  };
  const adminToken = String(env.ADMIN_TOKEN ?? '');
  const authSecret = String(env.AUTH_SECRET ?? '');
  if (
    adminToken.length < 32 ||
    authSecret.length < 32 ||
    adminToken === authSecret ||
    adminToken.startsWith('replace-with') ||
    authSecret.startsWith('replace-with')
  )
    throw new Error('ADMIN_TOKEN 与 AUTH_SECRET 必须不同，且分别至少 32 个字符');
  const mode = String(env.MODE ?? 'notify');
  if (!['notify', 'auto_cancel'].includes(mode))
    throw new Error('MODE 必须是 notify 或 auto_cancel');
  const channels = JSON.parse(String(env.NOTIFICATIONS_JSON ?? '[]')) as Channel[];
  if (!Array.isArray(channels) || channels.length > 8)
    throw new Error('通知渠道必须是数组，最多 8 个');
  const names = new Set<string>();
  for (const c of channels) {
    if (!c.name || names.has(c.name)) throw new Error('通知渠道 name 必须唯一且非空');
    names.add(c.name);
    if (!['bark', 'wecom', 'webhook', 'smtp'].includes(c.type)) throw new Error('不支持的通知渠道');
    if (c.type === 'smtp') {
      if (!c.host || !c.username || !c.password || !c.from || !c.to?.length)
        throw new Error('SMTP 缺少 host/username/password/from/to');
      if ((c.port ?? 465) !== 465) throw new Error('SMTP 当前只支持隐式 TLS 465 端口');
      for (const addr of [c.from, ...c.to]) {
        if (!/^[^\s<>@\r\n]+@[^\s<>@\r\n]+\.[^\s<>@\r\n]+$/.test(addr))
          throw new Error('SMTP 邮箱地址无效');
      }
      if (/[\s/\r\n]/.test(c.host)) throw new Error('SMTP 主机名无效');
    } else {
      const u = new URL(c.url ?? '');
      if (u.protocol !== 'https:' || u.username || u.password)
        throw new Error('通知 URL 必须使用 HTTPS');
      if (c.type === 'bark' && !c.key) throw new Error('Bark 缺少 key');
    }
  }
  const ignoreIds = new Set(
    String(env.IGNORE_IDS ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );
  if ([...ignoreIds].some((x) => !/^\d+$/.test(x)))
    throw new Error('IGNORE_IDS 只能包含逗号分隔的作品 ID');
  return {
    adminToken,
    authSecret,
    channels,
    ignoreIds,
    mode: mode as Mode,
    interval: number('POLL_INTERVAL_SECONDS', 300, 60, 86400),
    maxPages: number('MAX_PAGES', 10, 1, 100),
    maxActions: number('MAX_ACTIONS', 5, 1, 50),
    actionDelay: number('ACTION_DELAY_MS', 3000, 1000, 30000),
    timeout: number('PAGE_TIMEOUT_MS', 20000, 5000, 60000),
    cancelSelector: String(env.CANCEL_SELECTOR ?? ''),
  };
}
export function requireChannels(c: Config) {
  if (!c.channels.length) throw new SafeError('NO_CHANNELS', '请先配置至少一个通知渠道。', 400);
}
