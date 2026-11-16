// mssdk report encoder adapted from yunsur/douyin-mcp (MIT).
// Copyright (c) 2026 Yunsur. See THIRD_PARTY_NOTICES.md.
import profile from './device-profile.json' with { type: 'json' };
import { SafeError } from '../types.js';
import type { Http } from './http.js';

const alphabet = 'Dkdpgh4ZKsQB80/Mfvw36XI1R25+WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe';
export function tokenReport(plaintext: string, nonce: number) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + nonce) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  let i = 0;
  j = 0;
  const bytes = [...new TextEncoder().encode(plaintext)].map((b) => {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    return b ^ s[(s[i] + s[j]) & 255];
  });
  const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  return Buffer.from([0x41, nonce, ...bytes])
    .toString('base64')
    .replace(/[A-Za-z0-9+/]/g, (c: string) => alphabet[standard.indexOf(c)]);
}
export async function refreshToken(http: Http) {
  const p = structuredClone(profile),
    n = p.nWID as typeof p.nWID & { custom?: string };
  const version = n.ms_version;
  delete (n as Partial<typeof n>).ms_version;
  n.navigator.userAgent = http.userAgent;
  n.custom = JSON.stringify({
    version,
    fxgDid: '',
    uuid: crypto.randomUUID(),
    collectTime: 40 + Math.random() * 120,
    aid: 6383,
    pageId: 6241,
  });
  n.ms_version = version;
  const nonce = crypto.getRandomValues(new Uint8Array(1))[0];
  const body = JSON.stringify({
    magic: 538969122,
    version: 1,
    dataType: 8,
    strData: tokenReport(JSON.stringify({ nWID: n, wID: p.wID }), nonce),
    tspFromClient: Date.now(),
    ulr: 0,
  });
  const response = await http.request('https://mssdk.bytedance.com/web/r/token?ms_appid=6383', {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'cross-site',
    },
    body,
  });
  await response.body?.cancel();
  const token =
    response.headers.get('x-ms-token') ||
    (response.headers.getSetCookie().some((c) => c.startsWith('msToken='))
      ? http.jar.get('msToken', 'mssdk.bytedance.com')
      : '');
  if (response.status !== 200 || !token || token.length > 2048 || /[;\s]/.test(token))
    throw new SafeError('SESSION_TOKEN', '未取得抖音会话令牌，已停止本轮请求。');
  http.jar.set('msToken', token);
}
