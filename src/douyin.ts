import type { BrowserContext, Page, Response } from 'playwright';
import type { Config } from './config.js';
import { digest } from './crypto.js';
import { SafeError, type Snapshot, type Video } from './types.js';

export const HOME = 'https://www.douyin.com/user/self?from_tab_name=main&showTab=recommend';
export const FEED = '/aweme/v1/web/familiar/recommend/feed/';
export const LIST = '#user_detail_element [data-e2e="user-like-list"] [data-e2e="scroll-list"]';
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export function isFeed(url: string) {
  const u = new URL(url);
  return (
    u.protocol === 'https:' &&
    (u.hostname === 'douyin.com' || u.hostname.endsWith('.douyin.com')) &&
    u.pathname === FEED
  );
}
export function parseFeed(body: unknown): { videos: Video[]; more: boolean; cursor: string } {
  const b = body as Record<string, unknown> | null;
  if (!b || b.status_code !== 0)
    throw new SafeError('FEED_REJECTED', '抖音接口未返回成功状态，请检查登录或风控提示。');
  if (![true, false, 0, 1].includes(b.has_more as boolean))
    throw new SafeError('FEED_SCHEMA', '推荐接口分页字段发生变化。');
  const more = Boolean(b.has_more);
  const list = b.aweme_list === null && b.total === 0 && !more ? [] : b.aweme_list;
  if (!Array.isArray(list))
    throw new SafeError('FEED_SCHEMA', '推荐接口列表字段发生变化，未将其视为空列表。');
  const videos = list.map((item): Video => {
    if (!item || typeof item.aweme_id !== 'string' || !/^\d+$/.test(item.aweme_id))
      throw new SafeError('FEED_SCHEMA', '推荐接口作品 ID 无效。');
    return {
      id: item.aweme_id,
      title: String(item.desc || item.item_title || '无标题').slice(0, 300),
      url: `https://www.douyin.com/${Array.isArray(item.images) && item.images.length ? 'note' : 'video'}/${item.aweme_id}`,
    };
  });
  return { videos, more, cursor: String(b.max_cursor ?? '') };
}

export async function identity(page: Page): Promise<string> {
  const info = page.locator('#user_detail_element [data-e2e="user-info"]');
  try {
    await info.waitFor({ state: 'visible', timeout: 10000 });
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
  constructor(
    public page: Page,
    public cfg: Config,
  ) {
    page.setDefaultTimeout(cfg.timeout);
  }
  async scan(): Promise<Snapshot> {
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
      let response = await waitResponse(this.cfg.timeout);
      if (!response)
        throw new SafeError('FEED_TIMEOUT', '推荐接口未返回。页面空白不代表没有推荐。');
      const found = new Map<string, Video>();
      const cursors = new Set<string>();
      for (let i = 0; i < this.cfg.maxPages; i++) {
        if (!response.ok()) throw new SafeError('FEED_HTTP', '推荐接口 HTTP 请求失败。');
        const batch = parseFeed(await response.json());
        for (const video of batch.videos) found.set(video.id, video);
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
    await this.page.goto(video.url, { waitUntil: 'domcontentloaded' });
    // 只接受明确的取消/已推荐状态，不点击“推荐”或“喜欢”。选择器不匹配即停。
    const explicit = this.page.getByText('取消推荐', { exact: true });
    const selected = this.cfg.cancelSelector
      ? this.page.locator(this.cfg.cancelSelector)
      : this.page.getByText('已推荐', { exact: true });
    let button = explicit;
    try {
      await explicit.waitFor({ state: 'visible', timeout: 3000 });
    } catch {
      button = selected;
    }
    if ((await button.count()) !== 1 || !(await button.isVisible()))
      throw new SafeError(
        'CANCEL_SELECTOR',
        '未找到唯一的“取消推荐/已推荐”控件，停止取消；请检查页面版本。',
      );
    const label = ((await button.getAttribute('aria-label')) || (await button.innerText())).trim();
    if (!['取消推荐', '已推荐'].includes(label))
      throw new SafeError('CANCEL_STATE', '控件无法证明已推荐状态，拒绝点击。');
    await button.click();
    if (label === '已推荐') {
      try {
        await explicit.waitFor({ state: 'visible', timeout: 1500 });
      } catch {
        /* 某些版本直接切换状态；仍必须用列表接口复核。 */
      }
      if ((await explicit.count()) === 1 && (await explicit.isVisible())) await explicit.click();
    }
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
  await page.goto(HOME, { waitUntil: 'domcontentloaded' });
  // 使用抖音官方二维码，不实现私有二维码登录协议，也不提交密码。
  for (const text of ['登录', '扫码登录']) {
    const button = page.getByText(text, { exact: true });
    if ((await button.count()) === 1 && (await button.isVisible())) await button.click();
  }
  return page;
}
