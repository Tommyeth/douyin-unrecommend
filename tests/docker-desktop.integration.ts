// Run inside the built container: real Xvfb + Chromium + x11vnc + browser noVNC.
// Every Douyin request is fulfilled by a local fixture; no account or real OTP is used.
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright-core';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { localBackend } from '../src/desktop/state.js';
import { startDockerServer } from '../src/desktop/server.js';
import { readState } from '../src/vercel/state.js';

const dir = await mkdtemp(join(tmpdir(), 'desktop-e2e-'));
const env = {
  ADMIN_TOKEN: 'fixture-admin-'.repeat(4),
  AUTH_SECRET: 'fixture-key-'.repeat(4),
  DESKTOP_ENABLED: '1',
  HOST: '127.0.0.1',
  PORT: '0',
  DISABLE_SCHEDULER: '1',
};
const b = localBackend(join(dir, 'state.sqlite'), env.AUTH_SECRET);
const remote = await chromium.launch({ headless: false, args: ['--window-position=0,0'] });
let remotePage: Page;
const newContext = remote.newContext.bind(remote);
remote.newContext = async (options) => {
  const context = await newContext(options);
  const newPage = context.newPage.bind(context);
  context.newPage = async () => {
    const page = await newPage();
    remotePage = page;
    await page.route('**/*', (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<meta charset=utf-8><title>模拟登录验证</title><style>body{font:22px sans-serif;padding:70px;background:#fafaf8}input{display:block;width:360px;height:56px;font:24px sans-serif;margin-top:30px}</style><h1>浏览器输入测试</h1><p>此页面仅用于 noVNC 自动验证，不连接真实账号。</p><input id=code placeholder="点击此处输入测试文本" onkeydown="if(event.key==='Enter'&&this.value==='fixture-code')document.querySelector('#user_detail_element').hidden=false"><div id=user_detail_element hidden><div data-e2e=user-info>抖音号：fixture</div></div>`,
      }),
    );
    return page;
  };
  return context;
};
const runtime = startDockerServer(env, b, async (options) => {
  assert.equal(options?.headed, true);
  return remote;
});
if (!runtime.server.listening) await once(runtime.server, 'listening');
const client = await chromium.launch();
try {
  const page = await client.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`);
  await page.locator('#token').fill(env.ADMIN_TOKEN);
  await page.locator('#enter').click();
  await page.locator('[data-seconds="300"]').click();
  await page.locator('#modeSelect').selectOption('auto_cancel');
  await page.locator('#saveSettings').click();
  await page.waitForFunction(() => document.querySelector('#interval')?.textContent === '5 分钟');
  await page.locator('#login').click();
  await page.waitForFunction(
    () => document.querySelector('#desktopState')?.textContent?.startsWith('已连接'),
    { timeout: 30000 },
  );
  await page.locator('#connectDesktop').click();
  await page.waitForFunction(() =>
    document.querySelector('#desktopState')?.textContent?.startsWith('已连接'),
  );
  await remotePage!.locator('#code').waitFor();
  const location = await remotePage!.locator('#code').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      x: screenX + r.x + r.width / 2,
      y: screenY + outerHeight - innerHeight + r.y + r.height / 2,
    };
  });
  const canvas = page.locator('#desktopViewport canvas');
  const box = (await canvas.boundingBox())!;
  // Physical framebuffer is configured to 1280 × 900; noVNC scales it in CSS.
  await canvas.click({
    position: { x: (location.x / 1280) * box.width, y: (location.y / 900) * box.height },
  });
  await page.keyboard.type('fixture-code');
  await remotePage!.waitForFunction(
    () => (document.querySelector('#code') as HTMLInputElement).value === 'fixture-code',
  );
  await mkdir('/tmp/artifacts', { recursive: true });
  await page.screenshot({ path: '/tmp/artifacts/docker-desktop.png', fullPage: true });
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.querySelector('#logged')?.textContent === '已保存登录态',
    { timeout: 15000 },
  );
  assert.ok(await readState(b, (s) => s.get('auth')));
  assert.equal((await b.read()).state.lease, null);
  assert.equal(await page.locator('#desktopViewport').isHidden(), true);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: real noVNC mouse/keyboard/Enter → Chromium fixture login → encrypted persistence; 300-second settings saved.',
  );
} finally {
  await client.close();
  await remote.close();
  await runtime.close();
  b.close();
  await rm(dir, { recursive: true, force: true });
}
