import type { Page } from 'playwright-core';
import { digest } from '../crypto.js';
import { SafeError } from '../types.js';

export type AccountIdentity = { account: string; douyinId: string };
export type AccountProfile = AccountIdentity & {
  nickname: string;
  updatedAt: number;
  avatar?: { mime: 'image/jpeg'; data: string };
};

export async function readAccount(page: Page, timeout = 10000): Promise<AccountIdentity> {
  const info = page.locator('#user_detail_element [data-e2e="user-info"]');
  try {
    await info.waitFor({ state: 'visible', timeout });
    const text = await info.innerText();
    const douyinId = text.match(/抖音号[：:]\s*([A-Za-z0-9_.-]+)/)?.[1];
    if (!douyinId || douyinId.length > 100) throw new Error();
    return { account: await digest(douyinId), douyinId };
  } catch {
    throw new SafeError(
      'LOGIN_REQUIRED',
      '无法确认本人登录状态，请扫码登录；如有验证码，请在抖音官方页面人工处理。',
    );
  }
}

/** Cache an already rendered avatar, without exposing expiring CDN URLs or fetching arbitrary URLs. */
export async function captureProfile(
  page: Page,
  owner: AccountIdentity,
  previous: AccountProfile | null,
): Promise<AccountProfile> {
  const profile: AccountProfile = {
    ...owner,
    nickname: previous?.nickname ?? '',
    updatedAt: Date.now(),
    ...(previous?.avatar ? { avatar: previous.avatar } : {}),
  };
  const root = page.locator('#user_detail_element');
  const nickname = await root
    .locator('h1')
    .first()
    .textContent({ timeout: 500 })
    .catch(() => null);
  if (nickname?.trim()) profile.nickname = nickname.trim().slice(0, 160);
  const avatar = root.locator('[data-e2e="live-avatar"] img, img[alt$="头像"]').first();
  try {
    await avatar.waitFor({ state: 'visible', timeout: 700 });
    const box = await avatar.boundingBox();
    const loaded = await avatar.evaluate(async (element) => {
      const img = element as HTMLImageElement;
      await Promise.race([
        img.decode().catch(() => {}),
        new Promise((done) => setTimeout(done, 1200)),
      ]);
      return img.complete && img.naturalWidth > 0;
    });
    if (
      loaded &&
      box &&
      box.width >= 16 &&
      box.height >= 16 &&
      box.width <= 512 &&
      box.height <= 512
    ) {
      const bytes = await avatar.screenshot({
        type: 'jpeg',
        quality: 80,
        timeout: 1500,
        animations: 'disabled',
      });
      if (bytes.length <= 96_000)
        profile.avatar = { mime: 'image/jpeg', data: bytes.toString('base64') };
    }
  } catch {
    // Missing/slow images must not break login or recommendation processing.
  }
  const current = await readAccount(page, 500);
  if (current.account !== owner.account)
    throw new SafeError('ACCOUNT_CHANGED', '读取资料时账号已变化，请使用原账号重新扫码。');
  return profile;
}
