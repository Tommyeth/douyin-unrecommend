import {
  acquire,
  connect,
  endpointURLString,
  type Browser,
  type BrowserWorker,
} from '@cloudflare/playwright';
import type { Page } from 'playwright-core';
import type { Config } from '../config.js';
import type { Store } from '../store.js';
import { seal, unseal } from '../crypto.js';
import { SafeError } from '../types.js';
import { captureProfile, readAccount } from '../browser/profile.js';
import { parseVerification, applyVerification } from './manual.js';
import { HOME } from '../douyin.js';
import { importCookies, type HybridSession } from './session.js';
import { captureBrowserClient } from './client.js';

type Login = { sessionId: string; expires: number; control?: string };
export interface LoginDriver {
  start(): Promise<{ url: string; expires: number }>;
  view(): Promise<{ url: string; expires: number }>;
  capture(): Promise<boolean>;
  cancel(): Promise<{ ok: true }>;
  expire(): Promise<void>;
  manual?(input: unknown): Promise<{ ok: boolean }>;
}
export class BrowserRunLogin implements LoginDriver {
  constructor(
    private binding: BrowserWorker,
    private cfg: Config,
    private store: Store,
  ) {}
  private connectSession(sessionId: string) {
    // The SDK's CDP URL keeps the default context available across disconnects.
    const endpoint = new URL(endpointURLString(this.binding, { sessionId }));
    endpoint.searchParams.set('persistent', 'true');
    return connect(endpoint);
  }
  private async saved(): Promise<Login | null> {
    const raw = await this.store.get('login');
    if (!raw) return null;
    const meta = JSON.parse(raw);
    return unseal<Login>(meta.sealed, this.cfg.authSecret);
  }
  private async live(login: Login) {
    const browser = await this.connectSession(login.sessionId);
    const context = browser.contexts()[0],
      page = context?.pages()[0];
    if (!page) {
      await browser.close();
      throw new SafeError('LOGIN_EXPIRED', '登录浏览器已经关闭。');
    }
    return { browser, context, page };
  }
  private async terminate(login: Login) {
    let browser: Browser | undefined;
    try {
      browser = await this.connectSession(login.sessionId);
      const cdp = await browser.newBrowserCDPSession();
      await cdp.send('Browser.close');
    } catch {
      /* The remote session may already have timed out. */
    } finally {
      await browser?.close().catch(() => {});
    }
  }
  private async url(browser: Browser, login: Login) {
    if (!login.control) {
      login.control = crypto.randomUUID();
      await this.store.set(
        'login',
        JSON.stringify({ expires: login.expires, sealed: await seal(login, this.cfg.authSecret) }),
      );
    }
    const page = browser.contexts()[0].pages()[0];
    const cdp = await page.context().newCDPSession(page);
    try {
      const result = await cdp.send('Cloudflare.getLiveView', { mode: 'tab', expiresInMs: 300000 });
      const url = new URL(result.devtoolsFrontendUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'live.browser.run')
        throw new SafeError('LOGIN_VIEW', '浏览器未返回有效的操作窗口。');
      return { url: url.toString(), expires: login.expires, control: login.control };
    } finally {
      await cdp.detach().catch(() => {});
    }
  }
  async start() {
    return this.store.lock(async () => {
      const old = await this.saved();
      if (old && old.expires > Date.now()) {
        const { browser } = await this.live(old);
        try {
          return await this.url(browser, old);
        } finally {
          await browser.close();
        }
      }
      if (old) await this.terminate(old);
      await this.store.delete('login');
      const { sessionId } = await acquire(this.binding, { keep_alive: 600000 });
      const login = { sessionId, expires: Date.now() + 600000 };
      await this.store.set(
        'login',
        JSON.stringify({ expires: login.expires, sealed: await seal(login, this.cfg.authSecret) }),
      );
      await this.store.set(
        'browser_starts',
        String(Number((await this.store.get('browser_starts')) ?? 0) + 1),
      );
      let browser: Browser | undefined;
      let stage = 'connect';
      try {
        browser = await this.connectSession(sessionId);
        stage = 'context';
        const context = browser.contexts()[0];
        const page = context.pages()[0] ?? (await context.newPage());
        await page.setViewportSize({ width: 1100, height: 800 });
        stage = 'navigation';
        await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 45000 });
        stage = 'login_dialog';
        for (const text of ['登录', '扫码登录']) {
          const button = page.getByText(text, { exact: true });
          if ((await button.count()) === 1 && (await button.isVisible()))
            await button.click({ timeout: 2000 }).catch(() => {});
        }
        stage = 'live_view';
        await this.store.delete('browser_diagnostic');
        return await this.url(browser, login);
      } catch (e) {
        await this.store.set(
          'browser_diagnostic',
          JSON.stringify({
            stage,
            name: e instanceof Error ? e.name : 'unknown',
            detail:
              e instanceof Error
                ? e.message
                    .split('\n')[0]
                    .replace(/https?:\/\/\S+/g, '[URL]')
                    .replace(/[A-Za-z0-9_=-]{32,}/g, '[redacted]')
                    .slice(0, 180)
                : '',
            at: Date.now(),
          }),
        );
        await this.terminate(login);
        await this.store.delete('login');
        throw new SafeError(
          'BROWSER_START',
          'Cloudflare 登录浏览器未能打开，请检查 Browser Run 配额或网络。',
          502,
        );
      } finally {
        await browser?.close().catch(() => {});
      }
    });
  }
  async view() {
    return this.store.lock(async () => {
      const login = await this.saved();
      if (!login || login.expires <= Date.now())
        throw new SafeError('LOGIN_EXPIRED', '登录窗口已过期。');
      const { browser } = await this.live(login);
      try {
        return await this.url(browser, login);
      } finally {
        await browser.close();
      }
    });
  }
  async capture() {
    return this.store.lock(async () => {
      const login = await this.saved();
      if (!login) return !!(await this.store.get('candidate_auth'));
      if (login.expires <= Date.now()) {
        await this.terminate(login);
        await this.store.delete('login');
        throw new SafeError('LOGIN_EXPIRED', '登录窗口已过期，请重新生成。');
      }
      const { browser, context, page } = await this.live(login);
      let captured = false;
      try {
        let owner;
        try {
          owner = await readAccount(page as unknown as Page, 500);
        } catch (e) {
          if (e instanceof SafeError && e.code === 'LOGIN_REQUIRED') return false;
          throw e;
        }
        const bound = await this.store.get('account');
        if (bound && bound !== owner.account)
          throw new SafeError('ACCOUNT_CHANGED', '请使用原来绑定的账号扫码。');
        const profile = await captureProfile(page as unknown as Page, owner, null);
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
        captured = true;
      } finally {
        if (captured) {
          await this.terminate(login);
          await this.store.delete('login');
        }
        await browser.close().catch(() => {});
      }
      return captured;
    });
  }
  async manual(raw: unknown) {
    const input = parseVerification(raw);
    return this.store.lock(async () => {
      const login = await this.saved();
      if (!login || login.expires <= Date.now() || input.control !== login.control)
        throw new SafeError('INPUT_STALE', '验证会话已变化，请重新连接窗口。', 400);
      const { browser, page } = await this.live(login);
      try {
        return await applyVerification(page as unknown as Page, input);
      } finally {
        await browser.close().catch(() => {});
      }
    });
  }
  async cancel() {
    return this.store.lock(async () => {
      const login = await this.saved();
      if (login) await this.terminate(login);
      await this.store.delete('login');
      return { ok: true as const };
    });
  }
  async expire() {
    const login = await this.saved();
    if (login && login.expires <= Date.now()) await this.cancel();
  }
}
