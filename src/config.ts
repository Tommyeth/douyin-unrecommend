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
  const channels = validateChannels(JSON.parse(String(env.NOTIFICATIONS_JSON ?? '[]')));
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
    interval: number('POLL_INTERVAL_SECONDS', 3600, 60, 86400),
    maxPages: number('MAX_PAGES', 10, 1, 100),
    maxActions: number('MAX_ACTIONS', 5, 1, 50),
    actionDelay: number('ACTION_DELAY_MS', 3000, 1000, 30000),
    timeout: number('PAGE_TIMEOUT_MS', 20000, 5000, 60000),
  };
}
export function requireChannels(c: Config) {
  if (!c.channels.length) throw new SafeError('NO_CHANNELS', '请先配置至少一个通知渠道。', 400);
}

/** Used for deployment defaults and authenticated panel updates. */
export function validateChannels(raw: unknown): Channel[] {
  if (!Array.isArray(raw) || raw.length > 8)
    throw new SafeError('NOTIFICATIONS', '最多配置 8 个通知渠道。', 400);
  const names = new Set<string>();
  return raw.map((item) => {
    if (!item || typeof item !== 'object')
      throw new SafeError('NOTIFICATIONS', '通知渠道格式无效。', 400);
    const c = item as Record<string, unknown>;
    const fail = (message: string): never => {
      throw new SafeError('NOTIFICATIONS', message, 400);
    };
    const str = (key: string, max = 2048): string => {
      const v = c[key];
      if (v === undefined) return '';
      if (typeof v !== 'string' || v.length > max || /[\r\n\x00]/.test(v))
        return fail('通知字段格式或长度无效。');
      return v;
    };
    const name = str('name', 64).trim();
    if (!name || names.has(name)) fail('渠道名称不能为空或重复。');
    names.add(name);
    const type = c.type as Channel['type'];
    if (!['bark', 'wecom', 'webhook', 'smtp'].includes(type)) fail('不支持的通知渠道。');
    if (type === 'smtp') {
      const host = str('host', 253).trim(),
        username = str('username', 320),
        password = str('password'),
        from = str('from', 320);
      if (!host || !username || !password || !from || /[\s/:]/.test(host))
        fail('SMTP 需要有效主机、用户名、密码和发件人。');
      if (c.port !== undefined && c.port !== 465) fail('SMTP 当前只支持隐式 TLS 465 端口。');
      if (!Array.isArray(c.to) || c.to.length < 1 || c.to.length > 10)
        fail('SMTP 需要 1–10 个收件人。');
      const to = c.to as string[];
      if (
        [from, ...to].some(
          (a) =>
            typeof a !== 'string' ||
            a.length > 320 ||
            !/^[^\s<>@\r\n]+@[^\s<>@\r\n]+\.[^\s<>@\r\n]+$/.test(a),
        )
      )
        fail('SMTP 邮箱地址无效。');
      return { name, type, host, port: 465, username, password, from, to };
    }
    const url = str('url');
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || u.username || u.password || u.hash)
        fail('通知地址必须是没有用户名、密码及片段的 HTTPS URL。');
    } catch {
      fail('通知地址必须是有效 HTTPS URL。');
    }
    if (type === 'bark') {
      const key = str('key');
      if (!key) fail('Bark 需要 Device Key。');
      return { name, type, url, key };
    }
    if (type === 'webhook') {
      const token = str('token');
      return { name, type, url, ...(token ? { token } : {}) };
    }
    return { name, type, url };
  });
}
