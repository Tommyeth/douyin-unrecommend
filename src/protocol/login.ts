// Passport signing parameters adapted from yunsur/douyin-mcp (MIT).
import { SafeError } from '../types.js';
import { Http } from './http.js';
import { Signer, passportEncode, passportSign, aidSign } from './sign.js';
const hex = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('');
const params = (obj: Record<string, string>) =>
  Object.entries(obj)
    .map(([k, v]) => k + '=' + v)
    .join('&');
const encoded = (obj: Record<string, string>) =>
  Object.entries(obj)
    .map(
      ([k, v]) =>
        k +
        '=' +
        encodeURIComponent(v).replace(
          /[!'()*]/g,
          (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
        ),
    )
    .join('&');
export class Passport {
  signer = new Signer();
  constructor(
    public http: Http,
    public portrait = crypto.randomUUID() + '.login',
  ) {}
  async sdk(extra: Record<string, string>, body: Record<string, string> = {}, fp = false) {
    const date = new Date();
    date.setUTCHours(12, 0, 0, 0);
    const ts = String(Math.floor(date.getTime() / 1000));
    const query: Record<string, string> = {
      passport_jssdk_version: '3.4.4',
      passport_jssdk_type: 'normal',
      is_from_ttaccountsdk: '1',
      aid: '6383',
      language: 'zh',
      account_app_language: 'zh-CN',
      ts,
      ...extra,
      p_ui: '2.4.4',
    };
    if (fp) {
      Object.assign(query, {
        p_ca: '4.0.26',
        p_ca_real: '1.0.0.892',
        fp: this.http.jar.get('s_v_web_id'),
        verifyFp: this.http.jar.get('s_v_web_id'),
      });
    }
    Object.assign(query, {
      account_sdk_source: 'web',
      account_sdk_source_info: passportEncode(
        JSON.stringify({
          hardwareConcurrency: 8,
          innerHeight: 855,
          innerWidth: 1920,
          outerHeight: 1032,
          outerWidth: 1920,
        }),
      ),
      p_js_v: '3.4.4',
      p_js_t: 'pro',
      p_zt: '3.3.17',
      p_ver: '1.1.3',
      p_ver_real: '0',
      request_host: encodeURIComponent('https://www.douyin.com'),
      p_bd: '1.0.1.19-fix.01',
      p_ts: String(Date.now()),
      p_no: hex(32),
      biz_trace_id: this.http.jar.get('biz_trace_id'),
      device_platform: 'web_app',
    });
    Object.assign(query, await passportSign(query, body));
    const ms = this.http.jar.get('msToken');
    if (ms) query.msToken = ms;
    return { query, ts };
  }
  async call(
    path: string,
    extra: Record<string, string> = {},
    body?: Record<string, string>,
    host = 'login.douyin.com',
  ) {
    const { query, ts } = await this.sdk(extra, body, !!body);
    const data = body ? new URLSearchParams(body).toString() : '';
    const q = params(query);
    const url = `https://${host}${path}?${q}&a_bogus=${encodeURIComponent(this.signer.sign(encoded(query), body ? encoded(body) : '', host))}`;
    const j = await this.http.json(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        'web-sdk-version': '1',
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json, text/javascript',
        'x-tt-passport-aid-sign': await aidSign(path, ts),
        'x-tt-passport-csrf-token':
          this.http.jar.get('passport_csrf_token', host) ||
          this.http.jar.get('passport_csrf_token_default', host),
        'x-tt-passport-trace-id': this.http.jar.get('biz_trace_id'),
        'x-tt-passport-verify-portrait': this.portrait,
        'sec-ch-ua-platform': '"Windows"',
        'sec-ch-ua': '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"',
        'sec-ch-ua-mobile': '?0',
      },
      ...(body ? { body: data } : {}),
    });
    const code = j.data?.error_code;
    if (code && code !== 0)
      throw new SafeError(
        'PASSPORT_REJECTED',
        `抖音登录接口返回 ${Number(code) || '未知错误'}，请按平台提示完成验证或稍后重试。`,
      );
    return j;
  }
  async bootstrap() {
    const landing = await this.http.request('https://www.douyin.com/');
    await landing.body?.cancel();
    this.http.jar.set('biz_trace_id', hex(4));
    this.http.jar.set(
      's_v_web_id',
      'verify_' + Date.now().toString(36) + '_' + crypto.randomUUID().replaceAll('-', '_'),
    );
    for (const host of ['www.douyin.com', 'login.douyin.com']) {
      const r = await this.http.request(`https://${host}/ttwid/check/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aid: 6383, service: 'www.douyin.com' }),
      });
      await r.body?.cancel();
    }
  }
  async start() {
    await this.bootstrap();
    return this.call('/passport/web/get_qrcode/', {
      next: 'https://www.douyin.com',
      need_short_url: 'true',
      need_logo: 'false',
      is_new_login: '1',
      is_from_iesaccountsaas: '1',
    });
  }
  async poll(token: string) {
    return this.call(
      '/passport/web/check_qrconnect/',
      { is_from_iesaccountsaas: '1' },
      {
        need_logo: 'false',
        is_frontier: 'true',
        token,
        is_new_login: '1',
        next: 'https://www.douyin.com',
        need_short_url: 'true',
      },
    );
  }
}
