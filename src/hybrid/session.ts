import { SafeError } from '../types.js';
import type { Cookie } from '../protocol/http.js';

export type BrowserCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  expires: number;
};
export type HybridSession = {
  version: 'hybrid-1';
  account: string;
  cookies: Cookie[];
  userAgent: string;
  platform: string;
  geo: number[];
  query: Record<string, string>;
  counter: number;
};
export function importCookies(cookies: BrowserCookie[]): Cookie[] {
  return cookies
    .filter((c) => {
      const domain = c.domain.replace(/^\./, '');
      return (
        /(^|\.)(douyin\.com|bytedance\.com)$/.test(domain) &&
        (c.expires <= 0 || c.expires * 1000 > Date.now())
      );
    })
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain.replace(/^\./, ''),
      path: c.path,
      hostOnly: !c.domain.startsWith('.'),
      secure: c.secure,
      ...(c.expires > 0 ? { expires: c.expires * 1000 } : {}),
    }));
}
export function assertSession(value: HybridSession) {
  if (
    value?.version !== 'hybrid-1' ||
    !Array.isArray(value.cookies) ||
    typeof value.userAgent !== 'string' ||
    !value.userAgent ||
    typeof value.platform !== 'string' ||
    !Array.isArray(value.geo) ||
    value.geo.length !== 8 ||
    !value.geo.every(Number.isFinite) ||
    !value.query ||
    typeof value.query !== 'object' ||
    typeof value.account !== 'string'
  )
    throw new SafeError('LOGIN_REQUIRED', '混合版登录态无效，请重新扫码。');
}
