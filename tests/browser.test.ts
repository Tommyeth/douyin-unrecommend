import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type BrowserContext } from 'playwright';
import { config } from '../src/config.js';
import { Douyin, FEED } from '../src/douyin.js';

const cfg = config({
  ADMIN_TOKEN: 'a'.repeat(40),
  AUTH_SECRET: 'b'.repeat(40),
  PAGE_TIMEOUT_MS: '5000',
  ACTION_DELAY_MS: '1000',
});
async function fixture(
  context: BrowserContext,
  ids: Set<string>,
  options: { broken?: boolean; noEffect?: boolean; pagination?: boolean; wrongTab?: boolean } = {},
) {
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
    if (u.pathname === '/test-cancel') {
      if (!options.noEffect) ids.delete(u.searchParams.get('id')!);
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (u.pathname.startsWith('/video/')) {
      const id = u.pathname.split('/').at(-1);
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<button onclick="fetch('/test-cancel?id=${id}',{method:'POST'}).then(()=>this.textContent='推荐')">${options.broken ? '推荐' : '已推荐'}</button>`,
      });
      return;
    }
    if (u.pathname === '/user/self') {
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<div id="user_detail_element"><div data-e2e="user-info">测试账号 抖音号：fixture</div><div id="semiTabrecommend" aria-selected="${options.wrongTab ? 'false' : 'true'}">推荐</div><div style="overflow-y:auto;height:100px" id="scroll"><div data-e2e="user-like-list"><ul data-e2e="scroll-list" style="height:800px"></ul></div></div></div><script>fetch('${FEED}');document.querySelector('#scroll').onscroll=()=>fetch('${FEED}?next=1');</script>`,
      });
      return;
    }
    await route.abort();
  });
}
test('浏览器读接口、翻页和取消后复核（全网络模拟，不操作真实账号）', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  try {
    const ids = new Set(['101', '102']);
    await fixture(context, ids, { pagination: true });
    const bot = new Douyin(await context.newPage(), cfg);
    const snapshot = await bot.scan();
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.videos.length, 2);
    assert.equal(snapshot.pages, 2);
    await bot.cancel(snapshot.videos[0]);
    assert.equal(ids.has('101'), false);
    assert.equal(ids.has('102'), true);
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
test('不点击普通“推荐”按钮；服务端未取消时不能报成功', async () => {
  const browser = await chromium.launch();
  try {
    for (const broken of [true, false]) {
      const context = await browser.newContext();
      const ids = new Set(['101']);
      await fixture(context, ids, { broken, noEffect: true });
      const bot = new Douyin(await context.newPage(), cfg);
      const s = await bot.scan();
      await assert.rejects(bot.cancel(s.videos[0]), broken ? /控件/ : /确认移除/);
      assert.equal(ids.has('101'), true);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
