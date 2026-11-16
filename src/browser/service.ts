import type { Browser, BrowserContext, Page } from 'playwright-core';
import { Workflow, type RecommendationClient } from '../workflow.js';
import { digest, seal, unseal } from '../crypto.js';
import { SafeError, type MailConnect } from '../types.js';
import type { Config } from '../config.js';
import type { Store } from '../store.js';
import { Douyin, prepareLogin, sleep } from './douyin.js';
import {
  readAccount,
  captureProfile,
  type AccountIdentity,
  type AccountProfile,
} from './profile.js';
import { launchBrowser, type LaunchBrowser } from './launch.js';
import { flush } from '../notify.js';
import { applyLoginInput, type LoginControl } from './input.js';
import { vercelPolicy, type BrowserPolicy } from './policy.js';
import { captureLoginImage, transientCaptureError } from './screenshot.js';

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;
export type LoginEvent = {
  type: 'waiting' | 'image' | 'confirmed' | 'input';
  image?: string;
  mime?: 'image/jpeg' | 'image/png';
  expires?: number;
  session?: string;
  frame?: string;
  id?: string;
  message?: string;
  focusedInput?: boolean;
};
export class BrowserService extends Workflow {
  private readonly notificationDeadline = Date.now() + 250000;
  constructor(
    cfg: Config,
    store: Store,
    mail: MailConnect,
    protected launch: LaunchBrowser = launchBrowser,
    private policy: BrowserPolicy = vercelPolicy,
  ) {
    super(cfg, store, mail);
    if (cfg.interval < policy.minimumInterval || cfg.interval % policy.intervalStep)
      throw new SafeError(
        'SETTINGS',
        `当前部署的检测间隔至少 ${policy.minimumInterval} 秒，按 ${policy.intervalStep} 秒递增。`,
        400,
      );
  }
  protected flushNotifications() {
    return flush(this.store, this.cfg.channels, this.mail, Date.now(), this.notificationDeadline);
  }
  private async storedProfile(): Promise<AccountProfile | null> {
    const raw = await this.store.get('account_profile');
    if (!raw) return null;
    const profile = JSON.parse(raw) as AccountProfile;
    const account = await this.store.get('account');
    if (
      !account ||
      profile.account !== account ||
      typeof profile.douyinId !== 'string' ||
      (await digest(profile.douyinId)) !== account
    )
      return null;
    return profile;
  }
  private async updateProfile(page: Page, owner: AccountIdentity) {
    if ((await this.store.get('account')) !== owner.account)
      throw new SafeError('ACCOUNT_CHANGED', '登录账号与已绑定账号不同，请使用原账号重新扫码。');
    const profile = await captureProfile(page, owner, await this.storedProfile());
    await this.store.set('account_profile', JSON.stringify(profile));
  }
  async status() {
    const status = await super.status();
    const profile = await this.storedProfile();
    return {
      ...status,
      profile: profile
        ? {
            douyinId: profile.douyinId,
            nickname: profile.nickname,
            updatedAt: profile.updatedAt,
            hasAvatar: !!profile.avatar,
          }
        : null,
    };
  }
  async avatar() {
    const profile = await this.storedProfile();
    if (!profile?.avatar)
      throw new SafeError('AVATAR_MISSING', '账号头像尚未读取，请更新账号资料。', 404);
    return profile.avatar;
  }
  async refreshProfile() {
    return this.store.lock(async () => {
      await this.withClient(async (client) => {
        if (!client.refreshAccount)
          throw new SafeError('PROFILE_UNAVAILABLE', '当前运行方式不支持读取账号资料。');
        await client.refreshAccount();
      });
      return { profile: (await this.status()).profile };
    });
  }
  async setSettings(mode: unknown, interval: unknown) {
    if (
      typeof interval !== 'number' ||
      interval < this.policy.minimumInterval ||
      interval % this.policy.intervalStep
    )
      throw new SafeError(
        'SETTINGS',
        `当前部署的检测间隔至少 ${this.policy.minimumInterval} 秒，按 ${this.policy.intervalStep} 秒递增。`,
        400,
      );
    return super.setSettings(mode, interval);
  }
  protected async context(browser: Browser, storageState?: StorageState) {
    const context = await browser.newContext({
      storageState,
      locale: 'zh-CN',
      viewport: { width: 1100, height: 800 },
    });
    await context.route('**/*', (route) =>
      route.request().resourceType() === 'media' ? route.abort() : route.continue(),
    );
    return context;
  }
  protected async saveLogin(context: BrowserContext, page: Page, owner: AccountIdentity) {
    const state = await context.storageState({ indexedDB: true });
    await this.store.set('auth', await seal({ version: 'chromium-1', state }, this.cfg.authSecret));
    await this.store.set('account', owner.account);
    await this.updateProfile(page, owner);
  }
  async login(signal: AbortSignal, emit: (event: LoginEvent) => void, control?: LoginControl) {
    const expires = Date.now() + this.policy.loginTimeout;
    emit({ type: 'waiting', expires });
    let browser: Browser | undefined;
    let phase = 'browser_start';
    let timedOut = false;
    const close = () => {
      void browser?.close().catch(() => {});
    };
    const timer = setTimeout(() => {
      timedOut = true;
      close();
    }, this.policy.loginTimeout + 5000);
    signal.addEventListener('abort', close, { once: true });
    try {
      signal.throwIfAborted();
      browser = await this.launch({ headed: this.policy.desktop });
      phase = 'browser_context';
      const context = await this.context(browser);
      phase = 'login_page';
      const page = await prepareLogin(context);
      emit({ type: 'waiting', expires });
      let previousImage = '';
      let frame = '';
      let frames: { id: string; url: string; at: number }[] = [];
      let nextImage = 0;
      let controlFailures = 0;
      while (Date.now() < expires && !signal.aborted) {
        let command: Awaited<ReturnType<LoginControl['poll']>> | undefined;
        try {
          command = await control?.poll();
          controlFailures = 0;
        } catch (e) {
          if (
            (!(e instanceof SafeError) || ['BUSY', 'STATE_READ', 'STATE_WRITE'].includes(e.code)) &&
            ++controlFailures <= 3
          ) {
            emit({
              type: 'waiting',
              expires,
              message: '状态连接暂时不稳定，正在恢复，请勿重复提交验证码。',
            });
            await sleep(700);
            continue;
          }
          throw e;
        }
        if (command?.cancelled) throw new SafeError('LOGIN_CANCELLED', '已取消扫码。');
        phase = 'login_identity';
        let owner: AccountIdentity | undefined;
        try {
          owner = await readAccount(page, 100);
        } catch (e) {
          if (!(e instanceof SafeError) || e.code !== 'LOGIN_REQUIRED') throw e;
        }
        if (owner) {
          const account = owner.account;
          phase = 'save_session';
          const bound = await this.store.get('account');
          if (bound && bound !== account)
            throw new SafeError('ACCOUNT_CHANGED', '请使用此前绑定的抖音账号扫码。');
          await this.saveLogin(context, page, owner);
          await this.store.delete('error');
          await this.store.delete('login_diagnostic');
          await this.store.delete('next_poll');
          // The caller emits confirmed only after the remote state is durably committed.
          return;
        }
        if (command?.input) {
          try {
            const result = await applyLoginInput(
              page,
              command.input,
              new Set(
                frames
                  .filter(
                    (f) => f.url === page.url() && (f.id === frame || Date.now() - f.at < 5000),
                  )
                  .map((f) => f.id),
              ),
            );
            const focusedInput = command.input.action === 'click' && result.focusedInput;
            emit({
              type: 'input',
              id: command.input.id,
              focusedInput,
              message: focusedInput
                ? '已选中远端输入框，请在本地输入栏填写验证码并发送。'
                : '操作已发送，请查看新画面。',
            });
          } catch (e) {
            emit({
              type: 'input',
              id: command.input.id,
              message: e instanceof SafeError ? e.message : '操作未完成，请查看画面后手动重试。',
            });
          }
          previousImage = '';
          frames = [];
          nextImage = 0;
        }
        if (Date.now() < nextImage) {
          await sleep(300);
          continue;
        }
        phase = 'login_image';
        let image: string;
        try {
          image = (await captureLoginImage(page)).toString('base64');
        } catch (e) {
          // QR confirmation can navigate while captureScreenshot is in flight.
          if (
            transientCaptureError(e) &&
            !page.isClosed() &&
            !signal.aborted &&
            !timedOut &&
            browser.isConnected()
          ) {
            frames = [];
            frame = '';
            previousImage = '';
            emit({
              type: 'waiting',
              expires,
              message: '画面暂时不可用，正在恢复；登录窗口仍保持打开，请勿重复提交验证码。',
            });
            await sleep(1000);
            continue;
          }
          throw e;
        }
        if (image !== previousImage) {
          frame = crypto.randomUUID();
          frames = [...frames, { id: frame, url: page.url(), at: Date.now() }].slice(-3);
          emit({
            type: 'image',
            image,
            mime: 'image/jpeg',
            expires,
            frame,
            session: control?.session,
          });
          previousImage = image;
        } else emit({ type: 'waiting', expires });
        nextImage = Date.now() + 1000;
        await sleep(300);
      }
      throw new SafeError(
        'LOGIN_EXPIRED',
        signal.aborted ? '扫码连接已关闭，请重新开始。' : '扫码已超时，请重新生成。',
      );
    } catch (e) {
      await this.store.set(
        'login_diagnostic',
        JSON.stringify({
          phase,
          name: e instanceof Error ? e.name : 'unknown',
          reason:
            e instanceof Error
              ? e.message
                  .split('\n')[0]
                  .replace(/https?:\/\/\S+/g, '[url]')
                  .slice(0, 180)
              : '',
          at: Date.now(),
        }),
      );
      if (signal.aborted) throw new SafeError('LOGIN_CANCELLED', '扫码连接已关闭，请重新开始。');
      if (timedOut) throw new SafeError('LOGIN_EXPIRED', '扫码会话已到时间上限，请重新生成。');
      if (e instanceof SafeError) throw e;
      throw new SafeError('BROWSER_LOGIN', `扫码流程失败（${phase}），请稍后重试。`, 502);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', close);
      await browser?.close().catch(() => {});
    }
  }
  async withClient<T>(fn: (bot: RecommendationClient) => Promise<T>): Promise<T> {
    const raw = await this.store.get('auth');
    if (!raw) throw new SafeError('LOGIN_REQUIRED', '请先扫码登录。');
    let saved: { version: string; state: StorageState };
    try {
      saved = await unseal(raw, this.cfg.authSecret);
    } catch {
      throw new SafeError('AUTH_DECRYPT', '登录态无法解密，请检查 AUTH_SECRET。');
    }
    if (saved.version !== 'chromium-1')
      throw new SafeError('LOGIN_REQUIRED', '请使用管理页重新扫码。');
    const browser = await this.launch();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let context: BrowserContext | undefined;
    try {
      return await Promise.race([
        (async () => {
          context = await this.context(browser, saved.state);
          const bot = new Douyin(await context.newPage(), this.cfg, (page, owner) =>
            this.updateProfile(page, owner),
          );
          try {
            const result = await fn(bot);
            await this.store.delete('browser_diagnostic');
            return result;
          } catch (e) {
            await this.store.set(
              'browser_diagnostic',
              JSON.stringify({
                ...bot.diagnostic,
                name: e instanceof Error ? e.name : 'unknown',
                reason:
                  e instanceof Error
                    ? e.message
                        .split('\n')[0]
                        .replace(/https?:\/\/\S+/g, '[url]')
                        .slice(0, 180)
                    : '',
                at: Date.now(),
              }),
            );
            throw e;
          } finally {
            await this.store.set(
              'auth',
              await seal(
                { version: 'chromium-1', state: await context.storageState({ indexedDB: true }) },
                this.cfg.authSecret,
              ),
            );
          }
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void browser.close().catch(() => {});
            reject(new SafeError('RUN_TIMEOUT', '本轮达到执行上限，稍后继续处理。'));
          }, 180000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      await browser.close().catch(() => {});
    }
  }
}
