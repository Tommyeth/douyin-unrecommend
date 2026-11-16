import type { BrowserContext, Page } from 'playwright-core';
import { BrowserService, type LoginEvent, type StorageState } from '../browser/service.js';
import { launchBrowser, type LaunchBrowser } from '../browser/launch.js';
import { vercelHybridPolicy, type BrowserPolicy } from '../browser/policy.js';
import { captureProfile, readAccount, type AccountIdentity } from '../browser/profile.js';
import type { LoginControl } from '../browser/input.js';
import type { Config } from '../config.js';
import type { Store } from '../store.js';
import type { RecommendationClient } from '../workflow.js';
import { SafeError, type MailConnect } from '../types.js';
import { seal, unseal } from '../crypto.js';
import { HybridService } from '../hybrid/service.js';
import { captureBrowserClient } from '../hybrid/client.js';
import { importCookies, type HybridSession } from '../hybrid/session.js';
import { HOME } from '../douyin.js';

/** Chromium is used only for interactive login or explicit legacy-session migration. */
export class VercelHybridService extends BrowserService {
  private protocol: HybridService;
  private deadline = Date.now() + 280000;
  constructor(
    cfg: Config,
    store: Store,
    mail: MailConnect,
    launch: LaunchBrowser = launchBrowser,
    policy: BrowserPolicy = vercelHybridPolicy,
    transport: typeof fetch = fetch,
  ) {
    super(
      cfg,
      store,
      mail,
      async (options) => {
        await store.set(
          'browser_starts',
          String(Number((await store.get('browser_starts')) ?? 0) + 1),
        );
        return launch(options);
      },
      policy,
    );
    this.protocol = new HybridService(cfg, store, mail, transport, 'vercel-hybrid');
  }
  private async version() {
    const raw = await this.store.get('auth');
    if (!raw) return '';
    try {
      return (await unseal<{ version: string }>(raw, this.cfg.authSecret)).version;
    } catch {
      throw new SafeError('AUTH_DECRYPT', '登录态无法解密，请检查 AUTH_SECRET。');
    }
  }
  async status() {
    const legacy = await super.status();
    const protocol = await this.protocol.status();
    const version = await this.version();
    return {
      ...protocol,
      profile: protocol.profile ?? legacy.profile,
      loggedIn:
        version === 'hybrid-1' &&
        !protocol.sessionPending &&
        protocol.error?.code !== 'LOGIN_REQUIRED',
      migrationRequired: version === 'chromium-1',
    };
  }
  async avatar() {
    const p = await this.protocol.profile();
    if (p?.avatar) return p.avatar;
    return super.avatar();
  }
  async refreshProfile() {
    return this.protocol.refreshProfile();
  }
  protected async saveLogin(context: BrowserContext, page: Page, owner: AccountIdentity) {
    const bound = await this.store.get('account');
    if (bound && bound !== owner.account)
      throw new SafeError('ACCOUNT_CHANGED', '请使用此前绑定的抖音账号。');
    const profile = await captureProfile(page, owner, null);
    const client = await page.evaluate(captureBrowserClient);
    const state: HybridSession = {
      version: 'hybrid-1',
      account: owner.account,
      ...client,
      cookies: importCookies(await context.cookies()),
      counter: 2,
    };
    await this.store.set('candidate_profile', await seal(profile, this.cfg.authSecret));
    await this.store.set('candidate_auth', await seal(state, this.cfg.authSecret));
  }
  async validateCandidate() {
    const remaining = Math.min(45000, this.deadline - Date.now());
    if (remaining < 1000) throw new SafeError('RUN_TIMEOUT', '会话已保留，请点击重试纯协议验证。');
    return this.protocol.validateCandidate(remaining);
  }
  async login(signal: AbortSignal, emit: (event: LoginEvent) => void, control?: LoginControl) {
    await super.login(signal, emit, control); // finally closes Chromium before validation
    signal.throwIfAborted();
    await this.validateCandidate();
  }
  async upgradeSession() {
    if (await this.store.get('candidate_auth')) return this.validateCandidate();
    const raw = await this.store.get('auth');
    if (!raw) throw new SafeError('LOGIN_REQUIRED', '没有可升级的登录态，请扫码登录。');
    const saved = await unseal<{ version: string; state: StorageState }>(raw, this.cfg.authSecret);
    if (saved.version === 'hybrid-1') return { ok: true, alreadyUpgraded: true };
    if (saved.version !== 'chromium-1' || !saved.state?.cookies)
      throw new SafeError('LOGIN_REQUIRED', '旧登录态不可读取，请扫码登录。');
    const browser = await this.launch();
    try {
      const context = await this.context(browser, saved.state);
      const page = await context.newPage();
      await page.goto(HOME, { waitUntil: 'commit', timeout: 45000 });
      const owner = await readAccount(page, 15000);
      await this.saveLogin(context, page, owner);
    } finally {
      await browser.close().catch(() => {});
    }
    return this.validateCandidate();
  }
  async withClient<T>(fn: (bot: RecommendationClient) => Promise<T>): Promise<T> {
    if (await this.store.get('candidate_auth'))
      throw new SafeError('SESSION_PENDING', '会话待纯协议验证，请先重试验证。');
    if ((await this.version()) === 'chromium-1')
      throw new SafeError(
        'SESSION_UPGRADE',
        '请在面板转换已保存的登录态；日常任务不会自动启动浏览器。',
      );
    return this.protocol.withClient(fn);
  }
}
