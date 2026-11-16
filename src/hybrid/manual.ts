import type { Page } from 'playwright-core';
import { SafeError } from '../types.js';

export type ManualVerification = { control: string } & (
  { action: 'sms' } | { action: 'resend' } | { action: 'code'; code: string }
);
export function parseVerification(raw: unknown): ManualVerification {
  const input = raw as Record<string, unknown> | null;
  if (!input || typeof input.control !== 'string' || !/^[a-f0-9-]{36}$/.test(input.control))
    throw new SafeError('INPUT', '验证会话无效，请重新连接登录窗口。', 400);
  if (input.action === 'sms' || input.action === 'resend')
    return { control: input.control, action: input.action };
  if (input.action === 'code' && typeof input.code === 'string' && /^\d{4,8}$/.test(input.code))
    return { control: input.control, action: 'code', code: input.code };
  throw new SafeError('INPUT', '请输入 4–8 位短信验证码。', 400);
}
/** Relays a user's explicit SMS action only. Does not select or solve CAPTCHA answers. */
export async function applyVerification(page: Page, input: ManualVerification) {
  const url = new URL(page.url());
  if (url.protocol !== 'https:' || url.hostname !== 'www.douyin.com')
    throw new SafeError('INPUT_ORIGIN', '当前页面不是抖音登录页面。');
  const field = page.getByPlaceholder('请输入验证码', { exact: true }).filter({ visible: true });
  if (input.action === 'sms') {
    if (await field.count())
      throw new SafeError('INPUT_STAGE', '已进入短信页，请输入验证码或选择重新发送。', 400);
    const choice = page.getByText('接收短信验证码', { exact: true }).filter({ visible: true });
    if ((await choice.count()) !== 1)
      throw new SafeError('INPUT_STAGE', '当前页面没有可用的短信验证选项。', 400);
    await choice.evaluate((el) => (el as HTMLElement).click());
    return { ok: true };
  }
  if ((await field.count()) !== 1)
    throw new SafeError('INPUT_STAGE', '当前页面没有可用的验证码输入框。', 400);
  const panel = page.locator('article').filter({ has: field });
  if ((await panel.count()) !== 1) throw new SafeError('INPUT_STAGE', '无法确认短信验证区域。');
  if (input.action === 'resend') {
    const resend = panel.getByText('重新发送', { exact: true }).filter({ visible: true });
    if ((await resend.count()) !== 1)
      throw new SafeError('INPUT_STAGE', '请等待短信重发倒计时结束。', 400);
    await resend.evaluate((el) => (el as HTMLElement).click());
    return { ok: true };
  }
  // The Douyin page may ignore CDP native input in Browser Run. Use the input's
  // native value setter and DOM events, with a human-supplied code only.
  await field.evaluate((el, value) => {
    const input = el as HTMLInputElement;
    if (input.disabled || input.readOnly) throw Error('Input unavailable');
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, input.code);
  const submit = panel.getByText('验证', { exact: true }).filter({ visible: true });
  if ((await submit.count()) !== 1) throw new SafeError('INPUT_STAGE', '无法确认验证码提交按钮。');
  await submit.evaluate((el) => {
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true')
      throw Error('Submit unavailable');
    (el as HTMLElement).click();
  });
  return { ok: true };
}
