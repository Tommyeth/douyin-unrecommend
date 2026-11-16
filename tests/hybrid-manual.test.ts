import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { parseVerification, applyVerification } from '../src/hybrid/manual.js';

test('辅助短信验证只接受当前会话标识与有限动作、数字验证码', () => {
  const control = crypto.randomUUID();
  assert.deepEqual(parseVerification({ control, action: 'sms' }), { control, action: 'sms' });
  assert.throws(() => parseVerification({ control, action: 'eval', code: 'script' }));
  assert.throws(() => parseVerification({ control, action: 'code', code: '1234\n' }));
  assert.throws(() => parseVerification({ control, action: 'code', code: '123456789' }));
  assert.throws(() => parseVerification({ control: 'old', action: 'sms' }));
});

test('辅助验证通过真实 DOM 事件填写并提交人工验证码，拒绝离开抖音的页面', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('**/*', (r) =>
      r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<article>
      <div id="choice" onclick="this.hidden=true;document.querySelector('#form').hidden=false">接收短信验证码</div>
      <div id="form" hidden><input placeholder="请输入验证码" type="tel"><button id="submit" disabled>验证</button><div id="resend">重新发送</div></div>
      <output id="result"></output></article><script>
      const field=document.querySelector('input');let code='';field.addEventListener('input',()=>{code=field.value;document.querySelector('#submit').disabled=code.length!==6;});
      document.querySelector('#submit').onclick=()=>document.querySelector('#result').textContent=code==='123456'?'confirmed':'wrong';
      document.querySelector('#resend').onclick=()=>document.querySelector('#result').textContent='resent';
      </script>`,
      }),
    );
    await page.goto('https://www.douyin.com/user/self');
    const control = crypto.randomUUID();
    await applyVerification(page, { control, action: 'sms' });
    await assert.rejects(applyVerification(page, { control, action: 'sms' }), /已进入/);
    await applyVerification(page, { control, action: 'resend' });
    assert.equal(await page.locator('output').innerText(), 'resent');
    await applyVerification(page, { control, action: 'code', code: '123456' });
    assert.equal(await page.locator('output').innerText(), 'confirmed');
    await page.goto('https://example.com/');
    await assert.rejects(
      applyVerification(page, { control, action: 'code', code: '123456' }),
      /不是抖音/,
    );
  } finally {
    await browser.close();
  }
});
