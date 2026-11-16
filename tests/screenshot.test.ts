import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { captureLoginImage } from '../src/browser/screenshot.js';

test('登录截图表面不可用时恢复视口并直接通过 CDP 抓图，保留原页面', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    await page.setContent('<h1>验证页面</h1><input aria-label="验证码">');
    await page.getByLabel('验证码').fill('fixture');
    page.screenshot = async () => {
      throw Error('Page.captureScreenshot: Unable to capture screenshot');
    };
    const bytes = await captureLoginImage(page);
    assert.equal(bytes.subarray(0, 2).toString('hex'), 'ffd8');
    assert.equal(await page.getByLabel('验证码').inputValue(), 'fixture');
    assert.equal(page.isClosed(), false);
  } finally {
    await browser.close();
  }
});
