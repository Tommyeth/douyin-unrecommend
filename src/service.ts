import { type Config } from './config.js';
import { seal, unseal } from './crypto.js';
import { Douyin } from './douyin.js';
import { CookieJar, Http, type Cookie } from './protocol/http.js';
import { Passport } from './protocol/login.js';
import { TicketGuard, type TicketState } from './protocol/ticket.js';
import { refreshToken } from './protocol/token.js';
import type { PassportSession } from './protocol/fingerprint.js';
import { Workflow, type RecommendationClient } from './workflow.js';
import { Store } from './store.js';
import { SafeError, safeError, type MailConnect } from './types.js';

type State = { version: 1; cookies: Cookie[]; counter?: number; ticket?: TicketState };
type Login = {
  expires: number;
  token: string;
  image: string;
  state: State;
  lastPoll: number;
  retryAt?: number;
  throttles?: number;
  portrait: string;
  sdk?: PassportSession;
  confirmed?: boolean;
};
export class Service extends Workflow {
  constructor(
    cfg: Config,
    store: Store,
    mail: MailConnect,
    public transport: typeof fetch = fetch,
  ) {
    super(cfg, store, mail);
  }
  async closeLogin() {
    await this.store.delete('login');
  }
  client(state: State, signal?: AbortSignal) {
    if (state.version !== 1 || !Array.isArray(state.cookies))
      throw new SafeError('LOGIN_REQUIRED', '登录态版本已更新，请重新扫码。');
    const bot = new Douyin(
      new Http(new CookieJar(state.cookies), this.transport, this.cfg.timeout, signal),
      this.cfg,
    );
    bot.signer.counter = state.counter ?? 2;
    if (state.ticket) bot.http.guard = new TicketGuard(state.ticket);
    return bot;
  }
  state(bot: Douyin): State {
    return {
      version: 1,
      cookies: bot.http.jar.cookies,
      counter: bot.signer.counter,
      ticket: bot.http.guard?.state,
    };
  }
  async saveLogin(login: Login) {
    await this.store.set(
      'login',
      JSON.stringify({ expires: login.expires, sealed: await seal(login, this.cfg.authSecret) }),
    );
  }
  async loadLogin(): Promise<Login> {
    const raw = await this.store.get('login');
    const meta = raw ? JSON.parse(raw) : null;
    if (!meta || meta.expires < Date.now() || !meta.sealed) {
      await this.closeLogin();
      throw new SafeError('LOGIN_EXPIRED', '二维码会话已过期，请重新生成。');
    }
    try {
      return await unseal<Login>(meta.sealed, this.cfg.authSecret);
    } catch {
      throw new SafeError('LOGIN_EXPIRED', '二维码会话无法恢复，请重新生成。');
    }
  }
  async startLogin() {
    return this.store.lock(async () => {
      await this.closeLogin();
      const http = new Http(new CookieJar(), this.transport, this.cfg.timeout),
        passport = new Passport(http);
      const j = await passport.start(),
        d = j.data;
      if (!d || typeof d.token !== 'string' || typeof d.qrcode !== 'string')
        throw new SafeError('LOGIN_SCHEMA', '登录接口未返回二维码和会话 token。');
      const image = d.qrcode.replace(/^data:image\/png;base64,/, ''),
        png = Buffer.from(image, 'base64');
      if (png.length > 200000 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
        throw new SafeError('LOGIN_SCHEMA', '登录接口返回的二维码格式无效。');
      const ttl = Number(d.expire_time);
      const expires = Date.now() + Math.min(180, ttl > 0 && ttl <= 180 ? ttl : 120) * 1000;
      await this.saveLogin({
        expires,
        token: d.token,
        image,
        state: {
          version: 1,
          cookies: http.jar.cookies,
          counter: passport.signer.counter,
          ticket: http.guard?.state,
        },
        lastPoll: 0,
        portrait: passport.portrait,
        sdk: passport.session,
      });
      return { expires };
    });
  }
  async loginImage() {
    return this.store.lock(async () => Buffer.from((await this.loadLogin()).image, 'base64'));
  }
  async finishLogin() {
    return this.store.lock(async () => {
      const login = await this.loadLogin(),
        bot = this.client(login.state),
        passport = new Passport(bot.http, login.portrait, login.sdk);
      passport.signer = bot.signer;
      if (!login.confirmed) {
        if (login.retryAt && Date.now() < login.retryAt)
          return {
            ok: false,
            status: 'throttled',
            retryAfterSeconds: Math.ceil((login.retryAt - Date.now()) / 1000),
          };
        if (Date.now() - login.lastPoll < 5500) return { ok: false, status: 'waiting' };
        login.lastPoll = Date.now();
        await this.saveLogin(login);
        let j;
        try {
          j = await passport.poll(login.token);
          login.retryAt = undefined;
          login.throttles = 0;
        } catch (e) {
          if (e instanceof SafeError && e.code === 'PASSPORT_RATE_LIMIT') {
            login.throttles = (login.throttles || 0) + 1;
            const retryAfterSeconds = Math.min(60, 10 * 2 ** Math.min(login.throttles - 1, 3));
            login.retryAt = Date.now() + retryAfterSeconds * 1000;
            return { ok: false, status: 'throttled', retryAfterSeconds };
          }
          throw e;
        } finally {
          login.state = this.state(bot);
          await this.saveLogin(login);
          if (passport.diagnostic)
            await this.store.set('login_diagnostic', JSON.stringify(passport.diagnostic));
        }
        const status = String(j.data?.status);
        if (status === 'expired' || status === '5') {
          await this.closeLogin();
          throw new SafeError('LOGIN_EXPIRED', '二维码已过期，请重新生成。');
        }
        if (!['confirmed', '3'].includes(status)) {
          if (!['new', '1', 'scanned', '2'].includes(status))
            throw new SafeError('LOGIN_SCHEMA', '无法识别扫码状态。');
          return { ok: false, status: ['scanned', '2'].includes(status) ? 'scanned' : 'waiting' };
        }
        if (typeof j.data?.redirect_url !== 'string')
          throw new SafeError('LOGIN_SCHEMA', '扫码确认后缺少登录跳转地址。');
        await bot.http.redirects(j.data.redirect_url);
        login.confirmed = true;
        login.state = this.state(bot);
        await this.saveLogin(login);
      }
      const { account } = await bot.identity(),
        bound = await this.store.get('account');
      if (bound && bound !== account)
        throw new SafeError(
          'ACCOUNT_CHANGED',
          '请使用此前绑定的抖音账号扫码；更换账号请使用独立数据库。',
        );
      await this.store.set('auth', await seal(this.state(bot), this.cfg.authSecret));
      await this.store.set('account', account);
      await this.store.delete('error');
      await this.store.delete('next_poll');
      await this.closeLogin();
      return { ok: true, status: 'confirmed' };
    });
  }
  async withClient<T>(fn: (bot: RecommendationClient) => Promise<T>): Promise<T> {
    const raw = await this.store.get('auth');
    if (!raw) throw new SafeError('LOGIN_REQUIRED', '请先扫码登录。');
    let state: State;
    try {
      state = await unseal<State>(raw, this.cfg.authSecret);
    } catch {
      throw new SafeError('AUTH_DECRYPT', '登录态无法解密，请检查 AUTH_SECRET 或重新扫码登录。');
    }
    const controller = new AbortController(),
      bot = this.client(state, controller.signal),
      timer = setTimeout(() => controller.abort(), 120000);
    try {
      await refreshToken(bot.http);
      return await fn(bot);
    } finally {
      clearTimeout(timer);
      await this.store.set('auth', await seal(this.state(bot), this.cfg.authSecret));
    }
  }
}
