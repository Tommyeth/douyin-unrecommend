import type { Page } from 'playwright-core';
import { SafeError } from '../types.js';

type Action =
  | { action: 'click'; x: number; y: number }
  | { action: 'text'; text: string; submit?: boolean }
  | { action: 'check' }
  | { action: 'key'; key: 'Enter' | 'Tab' | 'Backspace' | 'Escape' };
export type LoginInput = { session: string; id: string; frame: string } & Action;
export type LoginControl = {
  session: string;
  poll(): Promise<{ cancelled: boolean; input: LoginInput | null }>;
};
const uuid = (x: unknown): x is string => typeof x === 'string' && /^[a-f\d-]{36}$/i.test(x);
async function hasFocusedInput(page: Page) {
  for (const frame of page.frames()) {
    const focused = await frame
      .evaluate(() => {
        if (!document.hasFocus()) return false;
        let el = document.activeElement;
        while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
        if (el instanceof HTMLInputElement)
          return (
            !el.disabled &&
            !el.readOnly &&
            ['text', 'password', 'tel', 'email', 'number', 'search', 'url'].includes(el.type)
          );
        if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
        return el instanceof HTMLElement && el.isContentEditable;
      })
      .catch(() => false);
    if (focused) return true;
  }
  return false;
}
export function parseLoginInput(raw: unknown): LoginInput {
  if (!raw || typeof raw !== 'object') throw new SafeError('INPUT', '验证操作格式无效。', 400);
  const c = raw as Record<string, unknown>;
  if (!uuid(c.session) || !uuid(c.id) || !uuid(c.frame))
    throw new SafeError('INPUT', '验证操作缺少会话或画面编号。', 400);
  const base = { session: c.session, id: c.id, frame: c.frame };
  if (c.action === 'check') return { ...base, action: 'check' };
  if (
    c.action === 'click' &&
    typeof c.x === 'number' &&
    typeof c.y === 'number' &&
    Number.isFinite(c.x) &&
    Number.isFinite(c.y) &&
    c.x >= 0 &&
    c.x <= 1 &&
    c.y >= 0 &&
    c.y <= 1
  )
    return { ...base, action: 'click', x: c.x, y: c.y };
  if (
    c.action === 'text' &&
    typeof c.text === 'string' &&
    c.text.length > 0 &&
    c.text.length <= 128 &&
    !/[\x00-\x1f\x7f]/.test(c.text)
  )
    return {
      ...base,
      action: 'text',
      text: c.text,
      ...(c.submit === true ? { submit: true } : {}),
    };
  if (c.action === 'key' && ['Enter', 'Tab', 'Backspace', 'Escape'].includes(String(c.key)))
    return { ...base, action: 'key', key: c.key as 'Enter' | 'Tab' | 'Backspace' | 'Escape' };
  throw new SafeError('INPUT', '仅支持画面点击、最多 128 字符文本及指定按键。', 400);
}
export async function applyLoginInput(
  page: Page,
  input: LoginInput,
  frame: string | ReadonlySet<string>,
) {
  if (typeof frame === 'string' ? input.frame !== frame : !frame.has(input.frame))
    throw new SafeError('INPUT_STALE', '画面已更新，请在新画面上重新操作。');
  const url = new URL(page.url());
  if (
    url.protocol !== 'https:' ||
    !(url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'))
  )
    throw new SafeError('INPUT_ORIGIN', '页面已离开抖音域名，停止验证操作。');
  // Only user-supplied actions are relayed. No recognition, answer selection or automatic retry.
  if (input.action === 'click') {
    const size = page.viewportSize()!;
    await page.mouse.click(
      Math.min(size.width - 1, input.x * size.width),
      Math.min(size.height - 1, input.y * size.height),
    );
  } else if (input.action === 'text') {
    if (!(await hasFocusedInput(page)))
      throw new SafeError(
        'INPUT_FOCUS',
        '尚未选中远端输入框，请先点击画面中的输入框，等到选中提示后再发送。',
      );
    await page.keyboard.insertText(input.text);
    if (input.submit) await page.keyboard.press('Enter');
  } else if (input.action === 'check') {
    await page.goto('https://www.douyin.com/user/self?from_tab_name=main&showTab=recommend', {
      waitUntil: 'commit',
      timeout: 15000,
    });
  } else await page.keyboard.press(input.key);
  return { focusedInput: await hasFocusedInput(page) };
}
