import { SafeError, type Video } from './types.js';
export const FEED = '/aweme/v1/web/familiar/recommend/feed/';
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
