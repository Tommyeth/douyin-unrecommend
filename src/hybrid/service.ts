import { Workflow, type RecommendationClient } from '../workflow.js';
import { CookieJar, Http } from '../protocol/http.js';
import { Signer } from '../protocol/sign.js';
import { refreshToken } from '../protocol/token.js';
import { Douyin } from '../douyin.js';
import { seal, unseal } from '../crypto.js';
import { SafeError, safeError, type MailConnect } from '../types.js';
import type { Config } from '../config.js';
import type { Store } from '../store.js';
import type { AccountProfile } from '../browser/profile.js';
import { assertSession, type HybridSession } from './session.js';

export class HybridService extends Workflow {
  constructor(
    cfg: Config,
    store: Store,
    mail: MailConnect,
    private transport: typeof fetch = fetch,
    private runtime: 'cloudflare-hybrid' | 'vercel-hybrid' = 'cloudflare-hybrid',
  ) {
    super(cfg, store, mail);
  }
  async profile(): Promise<AccountProfile | null> {
    const raw = await this.store.get('hybrid_profile');
    if (!raw) return null;
    const p = await unseal<AccountProfile>(raw, this.cfg.authSecret);
    return p.account === (await this.store.get('account')) ? p : null;
  }
  async status() {
    const status = await super.status(),
      p = await this.profile();
    const login = JSON.parse((await this.store.get('login')) ?? 'null');
    return {
      ...status,
      runtime: this.runtime,
      sessionPending: !!(await this.store.get('candidate_auth')),
      loginActive: !!login && login.expires > Date.now(),
      browserStarts: Number((await this.store.get('browser_starts')) ?? 0),
      execution: this.runtime === 'cloudflare-hybrid' ? 'worker-fetch' : 'node-fetch',
      scheduleDiagnostic: JSON.parse((await this.store.get('schedule_diagnostic')) ?? 'null'),
      protocolDiagnostic: JSON.parse((await this.store.get('protocol_diagnostic')) ?? 'null'),
      profile: p
        ? {
            nickname: p.nickname,
            douyinId: p.douyinId,
            updatedAt: p.updatedAt,
            hasAvatar: !!p.avatar,
          }
        : null,
    };
  }
  async setSettings(mode: unknown, interval: unknown) {
    if (typeof interval !== 'number' || interval < 900 || interval % 900)
      throw new SafeError('SETTINGS', '此部署每 15 分钟调度，间隔需为 900 秒的整数倍。', 400);
    return super.setSettings(mode, interval);
  }
  private async execute<T>(
    state: HybridSession,
    fn: (bot: Douyin) => Promise<T>,
    timeout = 120000,
  ) {
    assertSession(state);
    const signal = AbortSignal.timeout(timeout);
    const diagnostic = {
      transport: this.runtime === 'cloudflare-hybrid' ? 'worker-fetch' : 'node-fetch',
      requests: 0,
      path: '',
      http: 0,
      error: '',
      at: Date.now(),
    };
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      diagnostic.requests++;
      diagnostic.path = url.pathname;
      const upstream = this.transport;
      const response = await upstream(input, init);
      diagnostic.http = response.status;
      return response;
    };
    const http = new Http(
      new CookieJar(state.cookies),
      transport,
      this.cfg.timeout,
      signal,
      state.userAgent,
    );
    const signer = new Signer(state.userAgent, state.geo, Date.now, Math.random, state.platform);
    signer.counter = state.counter;
    const bot = new Douyin(http, this.cfg, signer, state.query);
    try {
      if (!http.jar.get('msToken')) await refreshToken(http);
      return await fn(bot);
    } catch (e) {
      diagnostic.error = safeError(e).code;
      throw e;
    } finally {
      state.cookies = http.jar.cookies;
      state.counter = signer.counter;
      diagnostic.at = Date.now();
      await this.store.set('protocol_diagnostic', JSON.stringify(diagnostic));
    }
  }
  async withClient<T>(fn: (bot: RecommendationClient) => Promise<T>): Promise<T> {
    const raw = await this.store.get('auth');
    if (!raw) throw new SafeError('LOGIN_REQUIRED', '请先扫码并通过纯协议验证。');
    const state = await unseal<HybridSession>(raw, this.cfg.authSecret);
    assertSession(state);
    if (state.account !== (await this.store.get('account')))
      throw new SafeError('ACCOUNT_CHANGED', '登录态与已绑定账号不同，停止操作。');
    try {
      return await this.execute(state, fn);
    } finally {
      await this.store.set('auth', await seal(state, this.cfg.authSecret));
    }
  }
  async validateCandidate(timeout = 120000) {
    return this.store.lock(async () => {
      const raw = await this.store.get('candidate_auth');
      if (!raw) throw new SafeError('LOGIN_REQUIRED', '没有等待验证的扫码会话。');
      const state = await unseal<HybridSession>(raw, this.cfg.authSecret);
      try {
        const snapshot = await this.execute(state, (bot) => bot.scan(), timeout);
        const bound = await this.store.get('account');
        if (snapshot.account !== state.account || (bound && bound !== state.account))
          throw new SafeError('ACCOUNT_CHANGED', '浏览器与纯协议确认的账号不同，停止保存。');
        if (!snapshot.complete)
          throw new SafeError('FEED_INCOMPLETE', '协议列表未完整读取，尚未启用自动任务。');
        await this.store.set('account', state.account);
        await this.store.set('auth', await seal(state, this.cfg.authSecret));
        const profile = await this.store.get('candidate_profile');
        if (profile) await this.store.set('hybrid_profile', profile);
        await this.store.delete('candidate_auth');
        await this.store.delete('candidate_profile');
        await this.store.delete('error');
        await this.store.delete('next_poll');
        return { ok: true, status: 'confirmed', count: snapshot.videos.length, complete: true };
      } catch (e) {
        await this.store.set('candidate_auth', await seal(state, this.cfg.authSecret));
        const err = safeError(e);
        await this.store.set(
          'error',
          JSON.stringify({
            code: err.code,
            message: '扫码会话已保存，纯协议验证未通过：' + err.message,
            at: Date.now(),
          }),
        );
        throw err;
      }
    });
  }
  async refreshProfile() {
    return this.store.lock(async () => {
      await this.withClient(async (bot) => {
        const identity = await (bot as Douyin).identity();
        if (identity.account !== (await this.store.get('account')))
          throw new SafeError('ACCOUNT_CHANGED', '账号不匹配。');
        const p = await this.profile();
        if (p) {
          p.updatedAt = Date.now();
          await this.store.set('hybrid_profile', await seal(p, this.cfg.authSecret));
        }
      });
      return { profile: (await this.status()).profile };
    });
  }
}
