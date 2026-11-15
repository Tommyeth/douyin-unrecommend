import type { Browser, BrowserContext } from 'playwright';
import { requireChannels, type Config } from './config.js';
import { seal, unseal } from './crypto.js';
import { Douyin, HOME, identity, prepareLogin } from './douyin.js';
import { flush } from './notify.js';
import { Store } from './store.js';
import {
  SafeError,
  safeError,
  type Browsers,
  type MailConnect,
  type StorageState,
} from './types.js';

type Login = { id: string; expires: number };
type Plan = { token: string; ids: string[]; expires: number };
export class Service {
  constructor(
    public cfg: Config,
    public store: Store,
    public browsers: Browsers,
    public mail: MailConnect,
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
    const saved = await this.store.get('login');
    if (saved) {
      try {
        await (await this.browsers.connect((JSON.parse(saved) as Login).id)).close();
      } catch {
        /* expired */
      }
      await this.store.delete('login');
    }
  }
  async startLogin() {
    return this.store.lock(async () => {
      await this.closeLogin();
      const { browser, id } = await this.browsers.launch(true);
      try {
        const context = await browser.newContext({
          viewport: { width: 1100, height: 800 },
          locale: 'zh-CN',
        });
        await prepareLogin(context);
        await this.store.set('login', JSON.stringify({ id, expires: Date.now() + 180000 }));
        return { expires: Date.now() + 180000 };
      } catch (error) {
        await browser.close();
        throw error;
      } finally {
        await this.browsers.detach(browser);
      }
    });
  }
  async loginBrowser() {
    const raw = await this.store.get('login');
    if (!raw || (JSON.parse(raw) as Login).expires < Date.now()) {
      await this.closeLogin();
      throw new SafeError('LOGIN_EXPIRED', '二维码会话已过期，请重新生成。');
    }
    try {
      return await this.browsers.connect((JSON.parse(raw) as Login).id);
    } catch {
      await this.store.delete('login');
      throw new SafeError('LOGIN_EXPIRED', '浏览器会话已断开，请重新生成二维码。');
    }
  }
  async loginImage() {
    return this.store.lock(async () => {
      const browser = await this.loginBrowser();
      try {
        const page = browser
          .contexts()
          .flatMap((c) => c.pages())
          .find((p) => p.url().includes('douyin.com'));
        if (!page) throw new SafeError('LOGIN_EXPIRED', '未找到登录页面，请重新生成二维码。');
        return await page.screenshot({ type: 'png' });
      } finally {
        await this.browsers.detach(browser);
      }
    });
  }
  async finishLogin() {
    return this.store.lock(async () => {
      const browser = await this.loginBrowser();
      try {
        const page = browser
          .contexts()
          .flatMap((c) => c.pages())
          .find((p) => p.url().includes('douyin.com'));
        if (!page) throw new SafeError('LOGIN_EXPIRED', '请重新生成二维码。');
        await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: this.cfg.timeout });
        const account = await identity(page);
        const bound = await this.store.get('account');
        if (bound && bound !== account)
          throw new SafeError(
            'ACCOUNT_CHANGED',
            '请使用此前绑定的抖音账号扫码；更换账号请使用独立数据库。',
          );
        await this.store.set(
          'auth',
          await seal(await page.context().storageState({ indexedDB: true }), this.cfg.authSecret),
        );
        await this.store.set('account', account);
        await this.store.delete('error');
        await this.store.delete('next_poll');
        await browser.close();
        await this.store.delete('login');
        return { ok: true };
      } finally {
        await this.browsers.detach(browser);
      }
    });
  }
  async withBrowser<T>(fn: (douyin: Douyin, context: BrowserContext) => Promise<T>): Promise<T> {
    const raw = await this.store.get('auth');
    if (!raw) throw new SafeError('LOGIN_REQUIRED', '请先扫码登录。');
    let state: StorageState;
    try {
      state = await unseal<StorageState>(raw, this.cfg.authSecret);
    } catch {
      throw new SafeError('AUTH_DECRYPT', '登录态无法解密，请检查 AUTH_SECRET 或重新扫码登录。');
    }
    const { browser } = await this.browsers.launch();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const context = await browser.newContext({
            storageState: state,
            viewport: { width: 1100, height: 800 },
            locale: 'zh-CN',
          });
          // 降低后台带宽：保留页面脚本、接口和图片，禁止视频资源自动下载。
          await context.route('**/*', (route) =>
            route.request().resourceType() === 'media' ? route.abort() : route.continue(),
          );
          const result = await fn(new Douyin(await context.newPage(), this.cfg), context);
          await this.store.set(
            'auth',
            await seal(await context.storageState({ indexedDB: true }), this.cfg.authSecret),
          );
          return result;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new SafeError('RUN_TIMEOUT', '本轮达到 120 秒上限，下轮继续处理。')),
            120000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      await browser.close().catch(() => {});
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
        result = await this.withBrowser(async (bot) => {
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
      this.withBrowser(async (bot) => {
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
      return this.withBrowser(async (bot) => {
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
