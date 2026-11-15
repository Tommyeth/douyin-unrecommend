import { requireChannels, type Config } from './config.js';
import { seal, unseal } from './crypto.js';
import { Douyin } from './douyin.js';
import { CookieJar, Http, type Cookie } from './protocol/http.js';
import { Passport } from './protocol/login.js';
import { TicketGuard, type TicketState } from './protocol/ticket.js';
import { refreshToken } from './protocol/token.js';
import type { PassportSession } from './protocol/fingerprint.js';
import { flush } from './notify.js';
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
type Plan = { token: string; ids: string[]; expires: number };
export class Service {
  constructor(
    public cfg: Config,
    public store: Store,
    public mail: MailConnect,
    public transport: typeof fetch = fetch,
  ) {}
  channels() {
    return this.cfg.channels.map((c) => c.name);
  }
  async settings() {
    return {
      mode: this.cfg.mode,
      interval: this.cfg.interval,
      ...JSON.parse((await this.store.get('settings')) ?? '{}'),
    } as { mode: 'notify' | 'auto_cancel'; interval: number };
  }
  async setSettings(mode: unknown, interval: unknown) {
    if (
      typeof mode !== 'string' ||
      !['notify', 'auto_cancel'].includes(mode) ||
      typeof interval !== 'number' ||
      !Number.isInteger(interval) ||
      interval < 60 ||
      interval > 86400
    )
      throw new SafeError(
        'SETTINGS',
        '模式必须是 notify/auto_cancel，间隔必须是 60–86400 秒的整数。',
        400,
      );
    return this.store.lock(async () => {
      await this.store.set('settings', JSON.stringify({ mode, interval }));
      await this.store.delete('next_poll');
      return { ok: true };
    });
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
  async withClient<T>(fn: (bot: Douyin) => Promise<T>): Promise<T> {
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
  async poll(scheduled = false) {
    return this.store.lock(async () => {
      const login = await this.store.get('login');
      if (login && (JSON.parse(login) as Login).expires < Date.now()) await this.closeLogin();
      if (
        scheduled &&
        (!(await this.store.get('auth')) ||
          Date.now() < Number((await this.store.get('next_poll')) ?? 0))
      )
        return {
          skipped: true,
          notifications: await flush(this.store, this.cfg.channels, this.mail),
        };
      if (login && (JSON.parse(login) as Login).expires >= Date.now())
        return { skipped: true, reason: 'login_active' };
      const settings = await this.settings();
      if (settings.mode === 'notify') requireChannels(this.cfg);
      await this.store.set('next_poll', String(Date.now() + settings.interval * 1000));
      let error: SafeError | undefined;
      let result: Record<string, unknown> = {};
      try {
        result = await this.withClient(async (bot) => {
          let snapshot = await bot.scan();
          const added = await this.store.observe(snapshot, this.channels(), this.cfg.ignoreIds);
          let removed = 0;
          if (settings.mode === 'auto_cancel') {
            for (const video of snapshot.videos
              .filter((v) => !this.cfg.ignoreIds.has(v.id))
              .slice(0, this.cfg.maxActions)) {
              snapshot = await bot.cancel(video);
              await this.store.removed(video, this.channels());
              removed++;
            }
          }
          return { count: snapshot.videos.length, complete: snapshot.complete, added, removed };
        });
        await this.store.delete('error');
        await this.store.set('failures', '0');
        await this.store.set('last_success', String(Date.now()));
      } catch (e) {
        error = safeError(e);
        const failures = Number((await this.store.get('failures')) ?? 0) + 1;
        await this.store.set('failures', String(failures));
        await this.store.set(
          'next_poll',
          String(
            Date.now() +
              Math.max(
                settings.interval,
                Math.min(3600, settings.interval * 2 ** Math.min(failures, 4)),
              ) *
                1000,
          ),
        );
        await this.store.set(
          'error',
          JSON.stringify({ code: error.code, message: error.message, at: Date.now() }),
        );
        await this.store.enqueue(
          {
            id: `error:${error.code}:${Math.floor(Date.now() / 3600000)}`,
            kind: 'error',
            title: '抖音检测任务需要处理',
            body: error.message,
          },
          this.channels(),
        );
      }
      const notifications = await flush(this.store, this.cfg.channels, this.mail);
      if (error) throw error;
      return { ...result, notifications };
    });
  }
  async preview() {
    return this.store.lock(() =>
      this.withClient(async (bot) => {
        const snapshot = await bot.scan();
        const account = await this.store.get('account');
        if (snapshot.account !== account) throw new SafeError('ACCOUNT_CHANGED', '账号不匹配。');
        const videos = snapshot.videos
          .filter((v) => !this.cfg.ignoreIds.has(v.id))
          .slice(0, this.cfg.maxActions);
        const plan: Plan = {
          token: crypto.randomUUID(),
          ids: videos.map((v) => v.id),
          expires: Date.now() + 600000,
        };
        await this.store.set('plan', JSON.stringify(plan));
        return { ...plan, videos, complete: snapshot.complete, totalFound: snapshot.videos.length };
      }),
    );
  }
  async clear(token: string) {
    return this.store.lock(async () => {
      const raw = await this.store.get('plan');
      const plan: Plan | null = raw ? JSON.parse(raw) : null;
      if (!plan || plan.token !== token || plan.expires < Date.now())
        throw new SafeError('PLAN_EXPIRED', '预览已过期，请重新预览。');
      await this.store.delete('plan'); // 一次性令牌，断线后不自动重复执行。
      return this.withClient(async (bot) => {
        const snapshot = await bot.scan();
        await this.store.observe(snapshot, this.channels(), this.cfg.ignoreIds);
        const candidates = snapshot.videos.filter(
          (v) => plan.ids.includes(v.id) && !this.cfg.ignoreIds.has(v.id),
        );
        let removed = 0;
        for (const video of candidates) {
          await bot.cancel(video);
          await this.store.removed(video, this.channels());
          removed++;
        }
        return { removed, notifications: await flush(this.store, this.cfg.channels, this.mail) };
      });
    });
  }
  async testNotify() {
    requireChannels(this.cfg);
    return this.store.lock(async () => {
      await this.store.enqueue(
        {
          id: `test:${crypto.randomUUID()}`,
          kind: 'test',
          title: '抖音推荐防误触 · 测试通知',
          body: '通知渠道连通性测试。',
        },
        this.channels(),
      );
      return flush(this.store, this.cfg.channels, this.mail);
    });
  }
  async status() {
    return {
      loggedIn: !!(await this.store.get('auth')),
      loginDiagnostic: JSON.parse((await this.store.get('login_diagnostic')) ?? 'null'),
      ...(await this.settings()),
      channels: this.channels(),
      lastScan: JSON.parse((await this.store.get('last_scan')) ?? 'null'),
      error: JSON.parse((await this.store.get('error')) ?? 'null'),
      lastSuccess: Number((await this.store.get('last_success')) ?? 0),
      nextPoll: Number((await this.store.get('next_poll')) ?? 0),
      pending: (
        await this.store.db.all<{ count: number }>(
          'SELECT COUNT(*) AS count FROM outbox WHERE sent_at IS NULL',
        )
      )[0].count,
    };
  }
}
