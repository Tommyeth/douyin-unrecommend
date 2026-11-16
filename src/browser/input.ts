import type { Page } from 'playwright-core';
import { SafeError } from '../types.js';

const keys = [
  'Enter',
  'Tab',
  'Shift+Tab',
  'Backspace',
  'Delete',
  'Escape',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'ControlOrMeta+A',
] as const;
type Action =
  | { action: 'click'; x: number; y: number }
  | { action: 'drag'; x: number; y: number; toX: number; toY: number }
  | { action: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { action: 'text'; text: string; submit?: boolean }
  | { action: 'check' }
  | { action: 'key'; key: (typeof keys)[number] };
export type LoginInput = { session: string; id: string; frame: string } & Action;
export type LoginControl = {
  session: string;
  poll(): Promise<{ cancelled: boolean; input: LoginInput | null }>;
};
const preparedPages = new WeakSet<Page>();
async function activatePage(page: Page) {
  await page.bringToFront();
  if (preparedPages.has(page)) return;
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    preparedPages.add(page);
    page.once('close', () => {
      void session.detach().catch(() => {});
    });
  } catch (error) {
    await session.detach().catch(() => {});
    throw error;
  }
}

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
  const unit = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  const delta = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1200;
  if (c.action === 'drag' && unit(c.x) && unit(c.y) && unit(c.toX) && unit(c.toY))
    return { ...base, action: 'drag', x: c.x, y: c.y, toX: c.toX, toY: c.toY };
  if (c.action === 'wheel' && unit(c.x) && unit(c.y) && delta(c.deltaX) && delta(c.deltaY))
    return { ...base, action: 'wheel', x: c.x, y: c.y, deltaX: c.deltaX, deltaY: c.deltaY };
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
  if (c.action === 'key' && keys.includes(c.key as (typeof keys)[number]))
    return { ...base, action: 'key', key: c.key as (typeof keys)[number] };
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
  await activatePage(page);
  // Only user-supplied actions are relayed. No recognition, answer selection or automatic retry.
  if (input.action === 'click') {
    const size = page.viewportSize()!;
    await page.mouse.click(
      Math.min(size.width - 1, input.x * size.width),
      Math.min(size.height - 1, input.y * size.height),
    );
    // Some login widgets suppress the click's default focus. Only focus an
    // editable element at the exact user-selected point, never pick a field.
    if (!(await hasFocusedInput(page)))
      await page.evaluate(
        ({ x, y }) => {
          let el = document.elementFromPoint(x, y);
          while (el?.shadowRoot) {
            const inner = el.shadowRoot.elementFromPoint(x, y);
            if (!inner || inner === el) break;
            el = inner;
          }
          if (
            (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
            !el.disabled &&
            !el.readOnly
          )
            el.focus();
          else if (el instanceof HTMLElement && el.isContentEditable) el.focus();
        },
        {
          x: Math.min(size.width - 1, input.x * size.width),
          y: Math.min(size.height - 1, input.y * size.height),
        },
      );
  } else if (input.action === 'drag' || input.action === 'wheel') {
    const size = page.viewportSize()!;
    const x = (v: number) => Math.min(size.width - 1, v * size.width);
    const y = (v: number) => Math.min(size.height - 1, v * size.height);
    await page.mouse.move(x(input.x), y(input.y));
    if (input.action === 'wheel') await page.mouse.wheel(input.deltaX, input.deltaY);
    else {
      await page.mouse.down();
      try {
        await page.mouse.move(x(input.toX), y(input.toY), { steps: 12 });
      } finally {
        await page.mouse.up();
      }
    }
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
