import type { BrowserContext, Page, Response } from 'playwright-core';
import type { Config } from '../config.js';
import { digest } from '../crypto.js';
import { SafeError, type Snapshot, type Video } from '../types.js';

export const HOME = 'https://www.douyin.com/user/self?from_tab_name=main&showTab=recommend';
import { FEED, isFeed, parseFeed } from '../feed.js';
export { FEED } from '../feed.js';
export const CANCEL = '/aweme/v1/web/familiar/recommend/cancel';
const CANCEL_QUERY = [
  'device_platform',
  'aid',
  'channel',
  'pc_client_type',
  'pc_libra_divert',
  'update_version_code',
  'support_h265',
  'support_dash',
  'version_code',
  'version_name',
  'cookie_enabled',
  'screen_width',
  'screen_height',
  'browser_language',
  'browser_platform',
  'browser_name',
  'browser_version',
  'browser_online',
  'engine_name',
  'engine_version',
  'os_name',
  'os_version',
  'cpu_core_num',
  'device_memory',
  'platform',
  'downlink',
  'effective_type',
  'round_trip_time',
  'webid',
  'uifid',
  'verifyFp',
  'fp',
];
export function cancelURL(feedURL: string) {
  if (!isFeed(feedURL)) throw new SafeError('CANCEL_CONTEXT', '缺少本轮推荐接口上下文。');
  const source = new URL(feedURL);
  const target = new URL(CANCEL, 'https://www.douyin.com');
  for (const key of CANCEL_QUERY) {
    const value = source.searchParams.get(key);
    if (value !== null) target.searchParams.set(key, value);
  }
  target.searchParams.set('app_name', 'douyin_web');
  // 不复制旧 a_bogus / msToken，抖音页面的请求拦截器会为此次 POST 签名。
  return target.toString();
}
export const LIST = '#user_detail_element [data-e2e="user-like-list"] [data-e2e="scroll-list"]';
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export async function identity(page: Page, timeout = 10000): Promise<string> {
  const info = page.locator('#user_detail_element [data-e2e="user-info"]');
  try {
    await info.waitFor({ state: 'visible', timeout });
    const text = await info.innerText();
    const id = text.match(/抖音号[：:]\s*([A-Za-z0-9_.-]+)/)?.[1];
    if (!id) throw new Error();
    return await digest(id);
  } catch {
    throw new SafeError(
      'LOGIN_REQUIRED',
      '无法确认本人登录状态，请扫码登录；如有验证码，请在抖音官方页面人工处理。',
    );
  }
}

export class Douyin {
  private feedURL = '';
  private scanned = new Set<string>();
  constructor(
    public page: Page,
    public cfg: Config,
  ) {
    page.setDefaultTimeout(cfg.timeout);
  }
  async scan(): Promise<Snapshot> {
    this.feedURL = '';
    this.scanned.clear();
    const page = this.page;
    const queue: Response[] = [];
    const onResponse = (response: Response) => {
      if (isFeed(response.url())) queue.push(response);
    };
    page.on('response', onResponse);
    const waitResponse = async (ms: number) => {
      const until = Date.now() + ms;
      while (!queue.length && Date.now() < until) await sleep(150);
      return queue.shift();
    };
    try {
      await page.goto(HOME, { waitUntil: 'domcontentloaded' });
      const account = await identity(page);
      if ((await page.locator('#semiTabrecommend').getAttribute('aria-selected')) !== 'true')
        throw new SafeError('WRONG_TAB', '未进入个人推荐标签，停止读取。');
      let response = await waitResponse(1500);
      if (!response) {
        // 首屏可能由服务端渲染；切换标签使官方页面重新发起推荐接口请求。
        await page.locator('#semiTablike').click();
        await page.locator('#semiTabrecommend').click();
        response = await waitResponse(this.cfg.timeout);
      }
      if (!response)
        throw new SafeError('FEED_TIMEOUT', '推荐接口未返回。页面空白不代表没有推荐。');
      const found = new Map<string, Video>();
      const cursors = new Set<string>();
      for (let i = 0; i < this.cfg.maxPages; i++) {
        if (!response.ok()) throw new SafeError('FEED_HTTP', '推荐接口 HTTP 请求失败。');
        const batch = parseFeed(await response.json());
        this.feedURL = response.url();
        for (const video of batch.videos) {
          found.set(video.id, video);
          this.scanned.add(video.id);
        }
        if (!batch.more)
          return { videos: [...found.values()], complete: true, pages: i + 1, account };
        if (cursors.has(batch.cursor))
          return { videos: [...found.values()], complete: false, pages: i + 1, account };
        cursors.add(batch.cursor);
        // 页面自行发起下一页请求和签名，不重放过期 a_bogus，不调用喜欢接口。
        await page.locator(LIST).waitFor({ state: 'attached' });
        await page.locator(LIST).evaluate((el) => {
          let parent: HTMLElement | null = el as HTMLElement;
          while (parent) {
            const style = getComputedStyle(parent);
            if (
              /(auto|scroll)/.test(style.overflowY) &&
              parent.scrollHeight > parent.clientHeight
            ) {
              parent.scrollTop = parent.scrollHeight;
              return;
            }
            parent = parent.parentElement;
          }
          window.scrollTo(0, document.documentElement.scrollHeight);
        });
        response = await waitResponse(this.cfg.timeout);
        if (!response)
          return { videos: [...found.values()], complete: false, pages: i + 1, account };
      }
      return { videos: [...found.values()], complete: false, pages: this.cfg.maxPages, account };
    } finally {
      page.off('response', onResponse);
    }
  }

  async cancel(video: Video) {
    if (!/^\d+$/.test(video.id) || !this.scanned.has(video.id))
      throw new SafeError('CANCEL_CONTEXT', '只允许取消本轮推荐接口中已确认的作品。');
    if (new URL(this.page.url()).origin !== 'https://www.douyin.com')
      throw new SafeError('CANCEL_CONTEXT', '当前页面不在抖音官方域名，停止取消。');
    const url = cancelURL(this.feedURL);
    let result: { http: number; code?: number };
    try {
      result = await this.page.evaluate(
        async ({ url, id, timeout }) => {
          const response = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ item_id: id, source: '0', type: '2' }).toString(),
            signal: AbortSignal.timeout(timeout),
          });
          const body = (await response.json().catch(() => null)) as { status_code?: number } | null;
          // 不把带签名 URL、Cookie 或响应中的用户数据带出页面。
          return { http: response.status, code: body?.status_code };
        },
        { url, id: video.id, timeout: this.cfg.timeout },
      );
    } catch {
      throw new SafeError('CANCEL_REQUEST', '取消协议请求失败，停止后续操作。');
    }
    if (result.http !== 200 || result.code !== 0)
      throw new SafeError('CANCEL_REJECTED', '抖音未确认取消成功，请检查登录或风控提示。');
    await sleep(this.cfg.actionDelay);
    const check = await this.scan();
    if (!check.complete || check.videos.some((v) => v.id === video.id))
      throw new SafeError(
        'CANCEL_UNVERIFIED',
        '取消后未能从完整推荐列表确认移除，已停止后续操作。',
      );
    return check;
  }
}

export async function prepareLogin(context: BrowserContext) {
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(45000);
  // Slow secondary resources must not prevent the already-visible page from being used.
  await page.goto(HOME, { waitUntil: 'commit', timeout: 25000 });
  await page
    .getByText('登录', { exact: true })
    .first()
    .waitFor({ state: 'visible', timeout: 3000 })
    .catch(() => {});
  // 使用抖音官方二维码，不实现私有二维码登录协议，也不提交密码。
  for (const text of ['登录', '扫码登录']) {
    const button = page.getByText(text, { exact: true });
    if ((await button.count()) === 1 && (await button.isVisible()))
      await button.click({ timeout: 2000 }).catch(() => {});
  }
  return page;
}
