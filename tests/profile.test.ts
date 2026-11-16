import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { digest, seal } from '../src/crypto.js';
import { captureProfile, readAccount, type AccountProfile } from '../src/browser/profile.js';
import { vercelApp } from '../src/vercel/app.js';
import { changeState, readState, emptyState, type StateBackend } from '../src/vercel/state.js';
import { SafeError } from '../src/types.js';
import type { BrowserService } from '../src/browser/service.js';
type Status = Awaited<ReturnType<BrowserService['status']>>;

const env = {
  ADMIN_TOKEN: 'profile-fixture-admin-'.repeat(3),
  AUTH_SECRET: 'fixture-secret-'.repeat(4),
};
const headers = { Authorization: 'Bearer ' + env.ADMIN_TOKEN };
const avatarSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#dce9e1"/><circle cx="40" cy="30" r="13" fill="#557263"/><path d="M15 75a25 25 0 0 1 50 0" fill="#557263"/></svg>';
function backend(): StateBackend {
  let state = emptyState(),
    revision = 0;
  return {
    async read() {
      return { state: structuredClone(state), etag: String(revision) };
    },
    async write(next, etag) {
      if (etag !== String(revision)) throw new SafeError('BUSY', '冲突');
      state = structuredClone(next);
      return String(++revision);
    },
  };
}
async function savedLogin(b: StateBackend, id = 'fixture.profile') {
  await changeState(b, async (s) => {
    await s.set('account', await digest(id));
    await s.set(
      'auth',
      await seal({ version: 'chromium-1', state: { cookies: [], origins: [] } }, env.AUTH_SECRET),
    );
    await s.set('settings', JSON.stringify({ mode: 'auto_cancel', interval: 900 }));
    await s.set('next_poll', '1234567890000');
  });
}
function profileBrowser(id: string, requests: string[], navigationAvatar = false) {
  return async () => {
    const browser = await chromium.launch();
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (options) => {
      const context = await newContext(options);
      const newPage = context.newPage.bind(context);
      context.newPage = async () => {
        const page = await newPage();
        await page.route('**/*', async (route) => {
          const request = route.request();
          requests.push(request.method() + ' ' + new URL(request.url()).pathname);
          if (new URL(request.url()).pathname === '/fixture-avatar.svg') {
            await new Promise((done) => setTimeout(done, 1600));
            await route.fulfill({ contentType: 'image/svg+xml', body: avatarSvg });
          } else {
            await route.fulfill({
              contentType: 'text/html; charset=utf-8',
              body: `${navigationAvatar ? '<a href="/user/someone-else"><span data-e2e="live-avatar"><img alt="其他人头像"></span></a><a href="//www.douyin.com/user/self"><span data-e2e="live-avatar"><img src="/fixture-avatar.svg"></span></a>' : ''}<div id="user_detail_element">${navigationAvatar ? '' : '<span data-e2e="live-avatar"><img src="/fixture-avatar.svg" alt="测试头像"></span>'}<h1>测试用户 &lt;b&gt;示例&lt;/b&gt;</h1><div data-e2e="user-info">抖音号：${id}</div></div>`,
            });
          }
        });
        return page;
      };
      return context;
    };
    return browser;
  };
}

test(
  '旧登录态可从面板补齐资料和头像，鉴权隔离、刷新不取消推荐或修改设置',
  { timeout: 20000 },
  async () => {
    const b = backend(),
      requests: string[] = [];
    await savedLogin(b);
    const app = vercelApp(env, b, profileBrowser('fixture.profile', requests, true));
    for (const [path, method] of [
      ['/api/status', 'GET'],
      ['/api/account/avatar', 'GET'],
      ['/api/account/refresh', 'POST'],
    ])
      assert.equal((await app.request(path, { method })).status, 401);
    assert.equal(
      (
        await app.request('/api/account/refresh', {
          method: 'POST',
          headers: { ...headers, Origin: 'https://other.test' },
        })
      ).status,
      403,
    );
    assert.equal(
      ((await (await app.request('/api/status', { headers })).json()) as Status).profile,
      null,
    );
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
      await page.locator('#token').fill(env.ADMIN_TOKEN);
      await page.locator('#enter').click();
      await page.locator('#main').waitFor();
      assert.equal(await page.locator('#accountNickname').textContent(), '账号资料待更新');
      await page.locator('#profileRefresh').click();
      await page.waitForFunction(
        () => document.querySelector('#message')?.textContent === '账号资料已更新。',
      );
      await page.locator('#accountAvatar').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#accountNickname').textContent(), '测试用户 <b>示例</b>');
      assert.equal(await page.locator('#accountNickname b').count(), 0);
      assert.equal(await page.locator('#accountId').textContent(), '抖音号：fixture.profile');
      assert.equal(
        await page
          .locator('#accountAvatar')
          .evaluate((el) => (el as HTMLImageElement).naturalWidth > 0),
        true,
      );
      for (const width of [1440, 900, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
      }
      assert.ok((await page.locator('.account-info').boundingBox())!.width >= 130);
      assert.deepEqual(errors, []);
      const status = (await (await app.request('/api/status', { headers })).json()) as Status;
      assert.ok(status.profile);
      assert.deepEqual(Object.keys(status.profile).sort(), [
        'douyinId',
        'hasAvatar',
        'nickname',
        'updatedAt',
      ]);
      assert.equal(status.profile.hasAvatar, true);
      assert.equal(status.mode, 'auto_cancel');
      assert.equal(status.interval, 900);
      assert.deepEqual(status.channels, []);
      assert.equal(await readState(b, (s) => s.get('next_poll')), '1234567890000');
      assert.equal(await readState(b, (s) => s.get('last_scan')), null);
      const image = await app.request('/api/account/avatar', { headers });
      assert.equal(image.status, 200);
      assert.equal(image.headers.get('Content-Type'), 'image/jpeg');
      assert.equal(image.headers.get('Cache-Control'), 'no-store');
      const bytes = new Uint8Array(await image.arrayBuffer());
      assert.deepEqual(Array.from(bytes.slice(0, 3)), [255, 216, 255]);
      assert.ok(bytes.length <= 96000);
      assert.deepEqual(requests.sort(), ['GET /fixture-avatar.svg', 'GET /user/self']);
      assert.equal((await (await app.request('/')).text()).includes('fixture.profile'), false);
    } finally {
      await browser.close();
      await new Promise<void>((done, reject) => server.close((e) => (e ? reject(e) : done())));
    }
  },
);

test('账号改变时拒绝覆盖资料；错绑缓存不返回资料或头像', { timeout: 15000 }, async () => {
  const b = backend(),
    requests: string[] = [];
  await savedLogin(b);
  const old: AccountProfile = {
    account: await digest('fixture.profile'),
    douyinId: 'fixture.profile',
    nickname: '旧资料',
    updatedAt: 1,
    avatar: { mime: 'image/jpeg', data: 'fixture' },
  };
  await changeState(b, (s) => s.set('account_profile', JSON.stringify(old)));
  const app = vercelApp(env, b, profileBrowser('different.account', requests));
  const response = await app.request('/api/account/refresh', { method: 'POST', headers });
  assert.equal(((await response.json()) as { error: string }).error, 'ACCOUNT_CHANGED');
  assert.deepEqual(JSON.parse((await readState(b, (s) => s.get('account_profile')))!), old);
  assert.ok(requests.every((r) => r.startsWith('GET ')));
  await changeState(b, (s) => s.set('account', 'wrong-owner'));
  assert.equal(
    ((await (await app.request('/api/status', { headers })).json()) as Status).profile,
    null,
  );
  assert.equal((await app.request('/api/account/avatar', { headers })).status, 404);
});

test('资料读取容忍缺少头像或昵称，读取期间切换账号则拒绝保存', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<div id="user_detail_element"><div data-e2e="user-info">抖音号：fallback</div></div>',
    );
    const owner = await readAccount(page);
    await page.locator('#user_detail_element').evaluate(
      (root, image) => {
        const heading = document.createElement('h1');
        heading.textContent = '资料页昵称';
        const img = document.createElement('img');
        img.alt = '资料页昵称头像';
        img.src = image;
        root.appendChild(heading);
        root.appendChild(img);
      },
      'data:image/svg+xml;base64,' + Buffer.from(avatarSvg).toString('base64'),
    );
    const full = await captureProfile(page, owner, null);
    assert.equal(full.nickname, '资料页昵称');
    assert.equal(full.avatar?.mime, 'image/jpeg');
    await page.locator('h1, img').evaluateAll((elements) => elements.forEach((el) => el.remove()));
    const previous: AccountProfile = {
      ...owner,
      nickname: '原昵称',
      updatedAt: 1,
      avatar: { mime: 'image/jpeg', data: 'old-avatar' },
    };
    const profile = await captureProfile(page, owner, previous);
    assert.equal(profile.nickname, '原昵称');
    assert.deepEqual(profile.avatar, previous.avatar);
    assert.ok(profile.updatedAt > previous.updatedAt);
    const fresh = await captureProfile(page, owner, null);
    assert.equal(fresh.nickname, '');
    assert.equal(fresh.avatar, undefined);
    await page
      .locator('[data-e2e="user-info"]')
      .evaluate((el) => (el.textContent = '抖音号：switched'));
    await assert.rejects(captureProfile(page, owner, previous), /账号已变化/);
  } finally {
    await browser.close();
  }
});
