import { SafeError } from '../types.js';
import { UA } from './sign.js';
export type Cookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  hostOnly: boolean;
  secure: boolean;
  expires?: number;
};
export class CookieJar {
  constructor(public cookies: Cookie[] = []) {}
  set(name: string, value: string, domain = 'douyin.com', path = '/', hostOnly = false) {
    this.cookies = this.cookies.filter(
      (c) => !(c.name === name && c.domain === domain && c.path === path),
    );
    if (value) this.cookies.push({ name, value, domain, path, hostOnly, secure: true });
  }
  absorb(url: URL, lines: string[]) {
    for (const line of lines) {
      const [pair, ...attrs] = line.split(';');
      const pos = pair.indexOf('=');
      if (pos < 1) continue;
      const c: Cookie = {
        name: pair.slice(0, pos),
        value: pair.slice(pos + 1),
        domain: url.hostname,
        path: url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/',
        hostOnly: true,
        secure: false,
      };
      let maxAge: number | undefined,
        invalid = false;
      for (const a of attrs) {
        const i = a.indexOf('=');
        const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase(),
          v = (i < 0 ? '' : a.slice(i + 1)).trim();
        if (k === 'domain') {
          const d = v.toLowerCase().replace(/^\./, '');
          if (!d.includes('.') || !(url.hostname === d || url.hostname.endsWith('.' + d))) {
            invalid = true;
            break;
          }
          c.domain = d;
          c.hostOnly = false;
        }
        if (k === 'path' && v.startsWith('/')) c.path = v;
        if (k === 'secure') c.secure = true;
        if (k === 'expires' && Number.isFinite(Date.parse(v))) c.expires = Date.parse(v);
        if (k === 'max-age' && /^-?\d+$/.test(v)) maxAge = Number(v);
      }
      if (invalid) continue;
      if (maxAge !== undefined) c.expires = Date.now() + maxAge * 1000;
      this.cookies = this.cookies.filter(
        (x) => !(x.name === c.name && x.domain === c.domain && x.path === c.path),
      );
      if (c.value && (!c.expires || c.expires > Date.now())) this.cookies.push(c);
    }
  }
  forURL(url: URL) {
    return this.cookies
      .filter(
        (c) =>
          (!c.expires || c.expires > Date.now()) &&
          (!c.secure || url.protocol === 'https:') &&
          (c.hostOnly
            ? url.hostname === c.domain
            : url.hostname === c.domain || url.hostname.endsWith('.' + c.domain)) &&
          (url.pathname === c.path ||
            url.pathname.startsWith(c.path.endsWith('/') ? c.path : c.path + '/')),
      )
      .sort((a, b) => b.path.length - a.path.length);
  }
  header(url: URL) {
    return this.forURL(url)
      .map((c) => c.name + '=' + c.value)
      .join('; ');
  }
  get(name: string, host = 'www.douyin.com') {
    return this.forURL(new URL('https://' + host + '/')).find((c) => c.name === name)?.value || '';
  }
}
const HOSTS = new Set([
  'www.douyin.com',
  'login.douyin.com',
  'sso.douyin.com',
  'ttwid.bytedance.com',
  'mssdk.bytedance.com',
]);
export class Http {
  constructor(
    public jar = new CookieJar(),
    public transport: typeof fetch = fetch,
    public timeout = 20000,
    public signal?: AbortSignal,
    public userAgent = UA,
  ) {}
  async request(raw: string, init: RequestInit = {}) {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      !HOSTS.has(url.hostname) ||
      url.username ||
      url.password ||
      url.port
    )
      throw new SafeError('UPSTREAM_HOST', '拒绝向未允许的抖音协议域名发送请求。');
    const headers = new Headers({
      'User-Agent': this.userAgent,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: 'https://www.douyin.com/',
      Origin: 'https://www.douyin.com',
    });
    new Headers(init.headers).forEach((v, k) => headers.set(k, v));
    headers.set('Cookie', this.jar.header(url));
    try {
      const transport = this.transport;
      const r = await transport(url, {
        ...init,
        headers,
        redirect: 'manual',
        signal: this.signal
          ? AbortSignal.any([this.signal, AbortSignal.timeout(this.timeout)])
          : AbortSignal.timeout(this.timeout),
      });
      this.jar.absorb(url, r.headers.getSetCookie());
      const ms = r.headers.get('x-ms-token');
      if (ms && ms.length <= 2048 && !/[;\s]/.test(ms)) this.jar.set('msToken', ms);
      return r;
    } catch (e) {
      if (e instanceof SafeError) throw e;
      throw new SafeError('HTTP_REQUEST', '抖音协议请求失败或超时。', 502);
    }
  }
  async json(raw: string, init: RequestInit = {}) {
    const r = await this.request(raw, init);
    if (r.status !== 200) {
      await r.body?.cancel();
      throw new SafeError('HTTP_STATUS', `抖音接口返回 HTTP ${r.status}。`, 502);
    }
    try {
      return (await r.json()) as Record<string, any>;
    } catch {
      throw new SafeError(
        'HTTP_NON_JSON',
        '抖音返回非 JSON 响应，请检查登录会话或平台验证要求。',
        502,
      );
    }
  }
}
