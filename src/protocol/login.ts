// Passport signing parameters adapted from yunsur/douyin-mcp (MIT).
import { SafeError } from '../types.js';
import { Http } from './http.js';
import { TicketGuard } from './ticket.js';
import { refreshToken } from './token.js';
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
  diagnostic?: {
    at: number;
    endpoint: string;
    code: number | null;
    captcha: boolean;
    verifyCenter: boolean;
    descriptionUrl: boolean;
  };
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
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': host === 'www.douyin.com' ? 'same-origin' : 'same-site',
      },
      ...(body ? { body: data } : {}),
    });
    const code = j.data?.error_code;
    const present = (value: unknown): boolean => {
      if (typeof value === 'string') return !['', '{}', 'null'].includes(value.trim());
      return !!value && typeof value === 'object' && Object.keys(value).length > 0;
    };
    this.diagnostic = {
      at: Date.now(),
      endpoint: path,
      code: Number.isFinite(Number(code)) ? Number(code) : null,
      captcha: present(j.data?.captcha),
      verifyCenter: present(j.data?.verify_center_decision),
      descriptionUrl: present(j.data?.desc_url),
    };
    if (this.diagnostic.captcha || this.diagnostic.verifyCenter)
      throw new SafeError(
        'PASSPORT_VERIFICATION',
        '抖音返回了额外安全验证信息。请先在抖音 App 中处理验证；当前纯协议客户端无法代为完成。',
      );
    if (Number(code) === 7)
      throw new SafeError('PASSPORT_RATE_LIMIT', '抖音暂时限制登录轮询频率，请等待后重试。');
    if (Number(code) === 2156)
      throw new SafeError(
        'PASSPORT_REJECTED',
        '抖音登录接口返回 2156：系统繁忙，请重启应用或刷新页面后重试。',
      );
    if (code && code !== 0)
      throw new SafeError(
        'PASSPORT_REJECTED',
        `抖音登录接口返回 ${Number(code) || '未知错误'}，请按平台提示完成验证或稍后重试。`,
      );
    return j;
  }
  async bootstrap() {
    this.http.guard = await TicketGuard.create();
    const landing = await this.http.request('https://www.douyin.com/');
    await landing.body?.cancel();
    this.http.jar.set('biz_trace_id', hex(4));
    this.http.jar.set(
      's_v_web_id',
      'verify_' + Date.now().toString(36) + '_' + crypto.randomUUID().replaceAll('-', '_'),
    );
    const registered = await this.http.json('https://ttwid.bytedance.com/ttwid/union/register/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        region: 'cn',
        aid: 1768,
        needFid: false,
        service: 'www.douyin.com',
        migrate_info: { ticket: '', source: 'node' },
        cbUrlProtocol: 'https',
        union: true,
      }),
    });
    const ttwid = this.http.jar.get('ttwid', 'ttwid.bytedance.com');
    if (registered.status_code !== 0 || !ttwid)
      throw new SafeError('LOGIN_DEVICE', '抖音匿名设备注册失败，未生成二维码。');
    // union/register explicitly issues the anonymous ID for the requested Douyin service.
    this.http.jar.set('ttwid', ttwid);
    for (const host of ['www.douyin.com', 'login.douyin.com']) {
      const j = await this.http.json(`https://${host}/ttwid/check/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-secsdk-csrf-token': 'DOWNGRADE' },
        body: JSON.stringify({ aid: 6383, service: 'www.douyin.com' }),
      });
      if (j.status_code !== 0)
        throw new SafeError('LOGIN_DEVICE', '抖音匿名设备校验失败，未生成二维码。');
    }
    await refreshToken(this.http);
    await this.ticketBootstrap();
  }
  async ticketBootstrap() {
    const request = async (path: string, body: string, csrf = 'DOWNGRADE') => {
      const q = new URLSearchParams({ aid: '6383', is_from_ttaccountsdk: '1' });
      const ms = this.http.jar.get('msToken');
      if (ms) q.set('msToken', ms);
      q.set('a_bogus', this.signer.sign(q.toString()));
      return this.http.json('https://www.douyin.com' + path + '?' + q, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-secsdk-csrf-token': csrf,
        },
        body,
      });
    };
    const ts = await request('/passport/user_info/get_sec_ts/', 'aid=6383&is_from_ttaccountsdk=1');
    if (ts.message !== 'success' || !this.http.guard?.state.secTs)
      throw new SafeError('LOGIN_TICKET', '登录安全时间戳获取失败。');
    const r = await this.http.request('https://www.douyin.com/service/2/abtest_config/', {
      method: 'HEAD',
      headers: { 'x-secsdk-csrf-request': '1', 'x-secsdk-csrf-version': '1.2.22' },
    });
    await r.body?.cancel();
    const csrf = r.headers.get('x-ware-csrf-token')?.split(',')[1]?.trim();
    if (!csrf) throw new SafeError('LOGIN_TICKET', '登录证书请求缺少 CSRF 凭证。');
    const cert = await request(
      '/passport/ticket_guard/get_client_cert/',
      'server_data=1,aid=6383',
      csrf,
    );
    if (cert.message !== 'success' || typeof cert.data?.server_cert !== 'string')
      throw new SafeError('LOGIN_CERT', '登录服务端证书获取失败。');
    this.http.guard.state.serverCert = cert.data.server_cert;
    await this.http.guard.sync(this.http.jar);
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
