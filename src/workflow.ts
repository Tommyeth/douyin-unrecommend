import { requireChannels, type Config } from './config.js';
import { flush } from './notify.js';
import { Store } from './store.js';
import { SafeError, safeError, type MailConnect, type Snapshot, type Video } from './types.js';
export interface RecommendationClient {
  scan(): Promise<Snapshot>;
  cancel(video: Video): Promise<Snapshot>;
}
type Login = { expires: number };
type Plan = { token: string; ids: string[]; expires: number };
export abstract class Workflow {
  constructor(
    public cfg: Config,
    public store: Store,
    public mail: MailConnect,
  ) {}
  abstract withClient<T>(fn: (bot: RecommendationClient) => Promise<T>): Promise<T>;
  protected flushNotifications() {
    return flush(this.store, this.cfg.channels, this.mail);
  }
  async closeLogin() {
    await this.store.delete('login');
  }
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
  async poll(scheduled = false, scheduledAt = Date.now()) {
    return this.store.lock(async () => {
      const login = await this.store.get('login');
      if (login && (JSON.parse(login) as Login).expires < Date.now()) await this.closeLogin();
      if (
        scheduled &&
        (!(await this.store.get('auth')) ||
          scheduledAt < Number((await this.store.get('next_poll')) ?? 0))
      )
        return {
          skipped: true,
          notifications: await this.flushNotifications(),
        };
      if (login && (JSON.parse(login) as Login).expires >= Date.now())
        return { skipped: true, reason: 'login_active' };
      const settings = await this.settings();
      if (settings.mode === 'notify') requireChannels(this.cfg);
      await this.store.set(
        'next_poll',
        String((scheduled ? scheduledAt : Date.now()) + settings.interval * 1000),
      );
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
      const notifications = await this.flushNotifications();
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
        return { removed, notifications: await this.flushNotifications() };
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
      return this.flushNotifications();
    });
  }
  async status() {
    return {
      loggedIn: !!(await this.store.get('auth')),
      loginDiagnostic: JSON.parse((await this.store.get('login_diagnostic')) ?? 'null'),
      browserDiagnostic: JSON.parse((await this.store.get('browser_diagnostic')) ?? 'null'),
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
