import type { Config } from './config.js';
import { digest } from './crypto.js';
import { SafeError, type Snapshot, type Video } from './types.js';
import { Http } from './protocol/http.js';
import { Signer } from './protocol/sign.js';
export const HOME = 'https://www.douyin.com/user/self?from_tab_name=main&showTab=recommend';
export const FEED = '/aweme/v1/web/familiar/recommend/feed/';
export const CANCEL = '/aweme/v1/web/familiar/recommend/cancel';
export const SELF = '/aweme/v1/web/user/profile/self/';
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

export class Douyin {
  private scanned = new Set<string>();
  constructor(
    public http: Http,
    public cfg: Config,
    public signer = new Signer(),
    public browserQuery: Record<string, string> = {},
  ) {}
  async request(path: string, extra: Record<string, string> = {}, body?: Record<string, string>) {
    const q = new URLSearchParams({
      device_platform: 'webapp',
      aid: '6383',
      channel: 'channel_pc_web',
      ...extra,
      update_version_code: '170400',
      pc_client_type: '1',
      pc_libra_divert: 'Windows',
      support_h265: '1',
      support_dash: '1',
      cpu_core_num: '8',
      version_code: '170400',
      version_name: '17.4.0',
      cookie_enabled: 'true',
      screen_width: '1920',
      screen_height: '1080',
      browser_language: 'zh-CN',
      browser_platform: 'Win32',
      browser_name: 'Chrome',
      browser_version: '151.0.0.0',
      browser_online: 'true',
      engine_name: 'Blink',
      engine_version: '151.0.0.0',
      os_name: 'Windows',
      os_version: '10',
      device_memory: '8',
      platform: 'PC',
      downlink: '10',
      effective_type: '4g',
      round_trip_time: '0',
    });
    // Reuse only stable browser parameters. Identity, cursors, signatures and
    // tokens always come from this request / the current cookie jar.
    for (const key of Object.keys(this.browserQuery)) {
      if (
        (q.has(key) || key === 'webid') &&
        !Object.hasOwn(extra, key) &&
        !['aid', 'device_platform'].includes(key)
      )
        q.set(key, this.browserQuery[key]);
    }
    for (const [key, cookie] of [
      ['uifid', 'UIFID'],
      ['verifyFp', 's_v_web_id'],
      ['fp', 's_v_web_id'],
      ['msToken', 'msToken'],
    ]) {
      const v = this.http.jar.get(cookie);
      if (v) q.set(key, v);
    }
    const data = body ? new URLSearchParams(body).toString() : '';
    const headers: Record<string, string> = { Referer: HOME };
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const r = await this.http.request('https://www.douyin.com' + path, {
        method: 'HEAD',
        headers: { 'x-secsdk-csrf-request': '1', 'x-secsdk-csrf-version': '1.2.22' },
      });
      await r.body?.cancel();
      const csrf = r.headers.get('x-ware-csrf-token')?.split(',')[1]?.trim();
      if (!csrf) throw new SafeError('CSRF_REQUIRED', '未取得取消接口的 CSRF 凭证，停止操作。');
      headers['x-secsdk-csrf-token'] = csrf;
    }
    q.set('a_bogus', this.signer.sign(q.toString(), data));
    return this.http.json('https://www.douyin.com' + path + '?' + q, {
      method: body ? 'POST' : 'GET',
      headers,
      ...(body ? { body: data } : {}),
    });
  }
  async identity() {
    const j = await this.request(SELF, { publish_video_strategy_type: '2' });
    const u = j.user;
    if (
      j.status_code !== 0 ||
      !u ||
      typeof u.sec_uid !== 'string' ||
      !u.sec_uid ||
      !/^\d+$/.test(String(u.uid || ''))
    )
      throw new SafeError('LOGIN_REQUIRED', '无法确认本人登录状态，请重新扫码。');
    // 与 v0.1 相同，优先使用抖音号绑定；UID 是缺少抖音号时的稳定后备。
    const id = String(u.unique_id || u.short_id || u.uid);
    return { account: await digest(id), secUid: u.sec_uid as string };
  }
  async scan(): Promise<Snapshot> {
    this.scanned.clear();
    const { account, secUid } = await this.identity();
    const found = new Map<string, Video>(),
      cursors = new Set<string>();
    let cursor = '0';
    for (let i = 0; i < this.cfg.maxPages; i++) {
      const batch = parseFeed(
        await this.request(FEED, {
          sec_user_id: secUid,
          max_cursor: cursor,
          min_cursor: '0',
          whale_cut_token: '',
          count: '18',
          from: '1',
        }),
      );
      for (const v of batch.videos) {
        found.set(v.id, v);
        this.scanned.add(v.id);
      }
      if (!batch.more)
        return { videos: [...found.values()], complete: true, pages: i + 1, account };
      if (!batch.cursor || cursors.has(batch.cursor))
        return { videos: [...found.values()], complete: false, pages: i + 1, account };
      cursors.add(batch.cursor);
      cursor = batch.cursor;
    }
    return { videos: [...found.values()], complete: false, pages: this.cfg.maxPages, account };
  }
  async cancel(video: Video) {
    if (!/^\d+$/.test(video.id) || !this.scanned.has(video.id))
      throw new SafeError('CANCEL_CONTEXT', '只允许取消本轮推荐接口中已确认的作品。');
    const j = await this.request(
      CANCEL,
      { app_name: 'douyin_web' },
      { item_id: video.id, source: '0', type: '2' },
    );
    if (j.status_code !== 0)
      throw new SafeError('CANCEL_REJECTED', '抖音未确认取消成功，停止后续操作。');
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
