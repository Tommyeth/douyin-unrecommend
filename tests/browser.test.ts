import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type BrowserContext } from 'playwright';
import { config } from '../src/config.js';
import { Douyin, FEED, CANCEL, cancelURL } from '../src/douyin.js';

const cfg = config({
  ADMIN_TOKEN: 'a'.repeat(40),
  AUTH_SECRET: 'b'.repeat(40),
  PAGE_TIMEOUT_MS: '5000',
  ACTION_DELAY_MS: '1000',
});
async function fixture(
  context: BrowserContext,
  ids: Set<string>,
  options: {
    rejected?: boolean;
    noEffect?: boolean;
    pagination?: boolean;
    wrongTab?: boolean;
    ssr?: boolean;
  } = {},
) {
  const requests: URLSearchParams[] = [];
  await context.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === FEED) {
      const all = [...ids];
      const next = u.searchParams.has('next');
      const selected = options.pagination ? (next ? all.slice(1) : all.slice(0, 1)) : all;
      await route.fulfill({
        json: {
          status_code: 0,
          has_more: !!options.pagination && !next,
          max_cursor: next ? 2 : 1,
          total: ids.size,
          aweme_list: selected.map((id) => ({ aweme_id: id, desc: '测试 ' + id })),
        },
      });
      return;
    }
    if (u.pathname === CANCEL) {
      assert.equal(route.request().method(), 'POST');
      const body = new URLSearchParams(route.request().postData()!);
      assert.equal(body.get('source'), '0');
      assert.equal(body.get('type'), '2');
      assert.equal(u.searchParams.get('app_name'), 'douyin_web');
      requests.push(body);
      if (!options.noEffect && !options.rejected) ids.delete(body.get('item_id')!);
      await route.fulfill({ json: { status_code: options.rejected ? 8 : 0 } });
      return;
    }
    if (u.pathname === '/user/self') {
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<div id="user_detail_element"><div data-e2e="user-info">测试账号 抖音号：fixture</div><button id="semiTablike">喜欢</button><button id="semiTabrecommend" aria-selected="${options.wrongTab ? 'false' : 'true'}">推荐</button><div style="overflow-y:auto;height:100px" id="scroll"><div data-e2e="user-like-list"><ul data-e2e="scroll-list" style="height:800px"></ul></div></div></div><script>${options.ssr ? '' : `fetch('${FEED}?aid=6383');`}document.querySelector('#semiTabrecommend').onclick=()=>fetch('${FEED}?aid=6383');document.querySelector('#scroll').onscroll=()=>fetch('${FEED}?aid=6383&next=1');</script>`,
      });
      return;
    }
    await route.abort();
  });
  return requests;
}
test('只复制设备参数，丢弃旧签名、分页和账号查询字段', () => {
  const url = new URL(
    cancelURL(
      `https://www.douyin.com${FEED}?aid=6383&device_platform=webapp&a_bogus=stale&msToken=stale&max_cursor=99&sec_user_id=private`,
    ),
  );
  assert.equal(url.pathname, CANCEL);
  assert.deepEqual([...url.searchParams.keys()], ['device_platform', 'aid', 'app_name']);
  assert.throws(() => cancelURL(`https://evil.example${FEED}`), /上下文/);
});
test('浏览器读接口、翻页、协议取消后复核（全网络模拟）', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  try {
    const ids = new Set(['101', '102']);
    const requests = await fixture(context, ids, { pagination: true });
    const bot = new Douyin(await context.newPage(), cfg);
    const snapshot = await bot.scan();
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.videos.length, 2);
    assert.equal(snapshot.pages, 2);
    await bot.cancel(snapshot.videos[0]);
    assert.equal(ids.has('101'), false);
    assert.equal(ids.has('102'), true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].get('item_id'), '101');
  } finally {
    await browser.close();
  }
});
test('首屏没有网络接口时切换标签，获取实时列表', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await fixture(context, new Set(['101']), { ssr: true });
    assert.equal((await new Douyin(await context.newPage(), cfg).scan()).videos[0].id, '101');
  } finally {
    await browser.close();
  }
});
test('未选中推荐标签时拒绝读取', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  try {
    await fixture(context, new Set(['101']), { wrongTab: true });
    await assert.rejects(new Douyin(await context.newPage(), cfg).scan(), /推荐标签/);
  } finally {
    await browser.close();
  }
});
test('拒绝未扫描的作品；协议报错或列表仍存在时不能报成功', async () => {
  const browser = await chromium.launch();
  try {
    for (const rejected of [true, false]) {
      const context = await browser.newContext();
      const ids = new Set(['101']);
      const requests = await fixture(context, ids, { rejected, noEffect: true });
      const bot = new Douyin(await context.newPage(), cfg);
      const s = await bot.scan();
      await assert.rejects(
        bot.cancel({ id: '999', title: '未扫描', url: 'https://www.douyin.com/video/999' }),
        /本轮推荐接口/,
      );
      assert.equal(requests.length, 0);
      await assert.rejects(bot.cancel(s.videos[0]), rejected ? /未确认取消成功/ : /确认移除/);
      assert.equal(ids.has('101'), true);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
