import type { Browser, BrowserContext } from 'playwright-core';
import { Workflow, type RecommendationClient } from '../workflow.js';
import { seal, unseal } from '../crypto.js';
import { SafeError, type MailConnect } from '../types.js';
import type { Config } from '../config.js';
import type { Store } from '../store.js';
import { Douyin, identity, prepareLogin, sleep } from './douyin.js';
import { launchBrowser, type LaunchBrowser } from './launch.js';
import { flush } from '../notify.js';
import { applyLoginInput, type LoginControl } from './input.js';

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;
export type LoginEvent = {
  type: 'waiting' | 'image' | 'confirmed' | 'input';
  image?: string;
  expires?: number;
  session?: string;
  frame?: string;
  id?: string;
  message?: string;
};
export class BrowserService extends Workflow {
  private readonly notificationDeadline = Date.now() + 250000;
  constructor(
    cfg: Config,
    store: Store,
    mail: MailConnect,
    private launch: LaunchBrowser = launchBrowser,
  ) {
    super(cfg, store, mail);
    if (cfg.interval < 3600 || cfg.interval % 3600)
      throw new SafeError(
        'SETTINGS',
        'Vercel 版 POLL_INTERVAL_SECONDS 必须为 1–24 个整小时。',
        400,
      );
  }
  protected flushNotifications() {
    return flush(this.store, this.cfg.channels, this.mail, Date.now(), this.notificationDeadline);
  }
  async setSettings(mode: unknown, interval: unknown) {
    if (typeof interval !== 'number' || interval < 3600 || interval % 3600)
      throw new SafeError('SETTINGS', 'Vercel 版检测间隔为 1–24 个整小时。', 400);
    return super.setSettings(mode, interval);
  }
  private async context(browser: Browser, storageState?: StorageState) {
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
  async login(signal: AbortSignal, emit: (event: LoginEvent) => void, control?: LoginControl) {
    let browser: Browser | undefined;
    let phase = 'browser_start';
    let timedOut = false;
    const close = () => {
      void browser?.close().catch(() => {});
    };
    const timer = setTimeout(() => {
      timedOut = true;
      close();
    }, 240000);
    signal.addEventListener('abort', close, { once: true });
    try {
      signal.throwIfAborted();
      browser = await this.launch();
      phase = 'browser_context';
      const context = await this.context(browser);
      phase = 'login_page';
      const page = await prepareLogin(context);
      const expires = Date.now() + 180000;
      emit({ type: 'waiting', expires });
      let previousImage = '';
      let refreshedAfterSession = false;
      let screenshotFailures = 0;
      let frame = '';
      while (Date.now() < expires && !signal.aborted) {
        const command = await control?.poll();
        if (command?.cancelled) throw new SafeError('LOGIN_CANCELLED', '已取消扫码。');
        phase = 'login_identity';
        let account: string | undefined;
        try {
          account = await identity(page, 600);
        } catch (e) {
          if (!(e instanceof SafeError) || e.code !== 'LOGIN_REQUIRED') throw e;
        }
        if (
          !account &&
          !refreshedAfterSession &&
          (await context.cookies('https://www.douyin.com')).some(
            (c) => c.name === 'sessionid' && c.value,
          )
        ) {
          refreshedAfterSession = true;
          await page.goto('https://www.douyin.com/user/self?from_tab_name=main&showTab=recommend', {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          });
          if (command?.input)
            emit({
              type: 'input',
              id: command.input.id,
              message: '登录页面已跳转，请查看新画面后重新操作。',
            });
          previousImage = '';
          frame = '';
          continue;
        }
        if (account) {
          phase = 'save_session';
          const bound = await this.store.get('account');
          if (bound && bound !== account)
            throw new SafeError('ACCOUNT_CHANGED', '请使用此前绑定的抖音账号扫码。');
          const state = await context.storageState({ indexedDB: true });
          await this.store.set(
            'auth',
            await seal({ version: 'chromium-1', state }, this.cfg.authSecret),
          );
          await this.store.set('account', account);
          await this.store.delete('error');
          await this.store.delete('login_diagnostic');
          await this.store.delete('next_poll');
          // The caller emits confirmed only after the remote state is durably committed.
          return;
        }
        if (command?.input) {
          try {
            await applyLoginInput(page, command.input, frame);
            emit({ type: 'input', id: command.input.id, message: '操作已发送，请查看新画面。' });
          } catch (e) {
            emit({
              type: 'input',
              id: command.input.id,
              message: e instanceof SafeError ? e.message : '操作未完成，请查看画面后手动重试。',
            });
          }
          previousImage = '';
        }
        phase = 'login_image';
        let image: string;
        try {
          image = (await page.screenshot({ type: 'png', timeout: 5000 })).toString('base64');
          screenshotFailures = 0;
        } catch (e) {
          // QR confirmation can navigate while captureScreenshot is in flight.
          if (
            e instanceof Error &&
            (e.name === 'TimeoutError' || e.message.includes('Unable to capture screenshot')) &&
            !page.isClosed() &&
            !signal.aborted &&
            !timedOut &&
            ++screenshotFailures <= 3
          ) {
            emit({ type: 'waiting', expires });
            await sleep(1000);
            continue;
          }
          throw e;
        }
        if (image !== previousImage) {
          frame = crypto.randomUUID();
          emit({ type: 'image', image, expires, frame, session: control?.session });
          previousImage = image;
        } else emit({ type: 'waiting', expires });
        await sleep(3000);
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
      throw new SafeError('LOGIN_REQUIRED', '请使用 Vercel 管理页重新扫码。');
    const browser = await this.launch();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let context: BrowserContext | undefined;
    try {
      return await Promise.race([
        (async () => {
          context = await this.context(browser, saved.state);
          const bot = new Douyin(await context.newPage(), this.cfg);
          try {
            return await fn(bot);
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
