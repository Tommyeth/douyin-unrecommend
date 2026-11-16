// Adapted from yunsur/douyin-mcp fpk.go and login.go (MIT).
// Copyright (c) 2026 Yunsur. See THIRD_PARTY_NOTICES.md.
import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import profile from './challenge-profile.json';
import { UA, passportEncode } from './sign.js';
import type { CookieJar } from './http.js';
const enc = new TextEncoder(),
  mask = (1n << 64n) - 1n;
const u = (x: bigint) => x & mask,
  rot = (x: bigint, n: bigint) => u((u(x) << n) | (u(x) >> (64n - n)));
export function murmur128(text: string) {
  const b = enc.encode(text),
    view = new DataView(b.buffer),
    c1 = 0x87c37b91114253d5n,
    c2 = 0x4cf5ad432745937fn;
  let h1 = 0n,
    h2 = 0n,
    off = 0;
  for (; off + 16 <= b.length; off += 16) {
    let k1 = view.getBigUint64(off, true),
      k2 = view.getBigUint64(off + 8, true);
    k1 = u(rot(k1 * c1, 31n) * c2);
    h1 ^= k1;
    h1 = u(rot(h1, 27n) + h2);
    h1 = u(h1 * 5n + 0x52dce729n);
    k2 = u(rot(k2 * c2, 33n) * c1);
    h2 ^= k2;
    h2 = u(rot(h2, 31n) + h1);
    h2 = u(h2 * 5n + 0x38495ab5n);
  }
  let k1 = 0n,
    k2 = 0n;
  for (let i = off; i < b.length; i++) {
    if (i - off < 8) k1 |= BigInt(b[i]) << BigInt(8 * (i - off));
    else k2 |= BigInt(b[i]) << BigInt(8 * (i - off - 8));
  }
  if (b.length - off > 8) h2 ^= u(rot(k2 * c2, 33n) * c1);
  if (b.length > off) h1 ^= u(rot(k1 * c1, 31n) * c2);
  h1 ^= BigInt(b.length);
  h2 ^= BigInt(b.length);
  h1 = u(h1 + h2);
  h2 = u(h2 + h1);
  const mix = (k: bigint) => {
    k ^= k >> 33n;
    k = u(k * 0xff51afd7ed558ccdn);
    k ^= k >> 33n;
    k = u(k * 0xc4ceb9fe1a85ec53n);
    return k ^ (k >> 33n);
  };
  h1 = mix(h1);
  h2 = mix(h2);
  h1 = u(h1 + h2);
  h2 = u(h2 + h1);
  return h1.toString(16).padStart(16, '0') + h2.toString(16).padStart(16, '0');
}
function fingerprintDigest() {
  const components = profile.fingerprintjs_components as Record<string, unknown>;
  return murmur128(
    Object.keys(components)
      .filter((k) => k !== 'id' && k !== 'visitorId')
      .sort()
      .map((k) => {
        let v: any = components[k];
        if (v && typeof v === 'object' && ('value' in v || 'duration' in v)) v = v.value;
        return k.replace(/[\\:|]/g, '\\$&') + ':' + JSON.stringify(v);
      })
      .join('|'),
  );
}
export function fpk1(digest = fingerprintDigest(), salt = randomBytes(8)) {
  let material = Buffer.alloc(0),
    prev = Buffer.alloc(0);
  while (material.length < 48) {
    prev = createHash('md5').update(prev).update('byte_fingerprint').update(salt).digest();
    material = Buffer.concat([material, prev]);
  }
  const cipher = createCipheriv('aes-256-cbc', material.subarray(0, 32), material.subarray(32, 48));
  return Buffer.concat([
    Buffer.from('Salted__'),
    salt,
    cipher.update(Buffer.from(digest, 'utf8')),
    cipher.final(),
  ]).toString('base64');
}
export type PassportSession = { queryStamp: string; cookieStamp: string; sourceInfo: string };
export function passportSession(): PassportSession {
  const digits = (n: number) =>
      [...crypto.getRandomValues(new Uint8Array(n))].map((v) => v % 10).join(''),
    suffix = digits(9),
    queryStamp = digits(4) + suffix,
    cookieStamp = digits(4) + suffix;
  const info = {
    hardwareConcurrency: 8,
    webdriver: false,
    chromedriver: false,
    shelldriver: false,
    plugins: 5,
    innerHeight: 855,
    innerWidth: 1920,
    outerHeight: 1032,
    outerWidth: 1920,
    webgl: {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
    automation: { s: '00000000', c: '0000', p: '0000000', s1: '00000000', c1: '0000', p1: '0' },
    performance: {
      timeOrigin: Date.now() - 10000,
      usedJSHeapSize: 472537551,
      navigationTiming: {
        decodedBodySize: 968454,
        entryType: 'navigation',
        initiatorType: 'navigation',
        name: 'https://www.douyin.com/?recommend=1',
        renderBlockingStatus: 'non-blocking',
        serverTiming: 'cdn-cache,edge,origin,inner,tt_agw',
        guleStart: 610.8999999761581,
        guleDuration: 'none',
      },
    },
    browser: { t: queryStamp, bit_protocol: 'false', bit_helper: false },
  };
  return { queryStamp, cookieStamp, sourceInfo: passportEncode(JSON.stringify(info)) };
}
export function sourceCookie(session: PassportSession, extra: Record<string, unknown> = {}) {
  return passportEncode(
    JSON.stringify({
      automa_ele: 'false',
      bit_helper: 'false',
      chrome_extension_script: '[]',
      console_lied: 'false',
      global_variables: '[]',
      swt_alt: 'false',
      zn_cap: 'false',
      hok_noti: 'false',
      inj_zfb: 'false',
      t: session.cookieStamp,
      bit_protocol: 'false',
      ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'console_liad')),
    }),
  );
}
export function pageCookies(jar: CookieJar, session: PassportSession) {
  const values: Record<string, string> = {
    enter_pc_once: '1',
    is_support_rtm_web_ts: '1',
    hevc_supported: 'true',
    IsDouyinActive: 'true',
    is_dash_user: '1',
    my_rd: '2',
    home_can_add_dy_2_desktop: '%220%22',
    strategyABtestKey: encodeURIComponent(JSON.stringify((Date.now() / 1000).toFixed(3))),
    dy_swidth: '1920',
    dy_sheight: '1080',
    device_web_cpu_core: '8',
    device_web_memory_size: '8',
    architecture: 'amd64',
    'x-web-secsdk-uid': crypto.randomUUID(),
    __security_mc_1_s_sdk_crypt_sdk:
      randomBytes(4).toString('hex') +
      '-' +
      randomBytes(2).toString('hex') +
      '-' +
      randomBytes(2).toString('hex'),
    bd_ticket_guard_regenerate_keys_time: new Date().toISOString().slice(0, 19).replace('T', '/'),
    fpk1: fpk1(),
    fpk2: createHash('md5').update(UA).digest('hex'),
    passport_auth_mix_state: randomBytes(24).toString('hex'),
    sdk_source_info: sourceCookie(session),
    stream_recommend_feed_params: encodeURIComponent(
      JSON.stringify(
        JSON.stringify({
          cookie_enabled: true,
          screen_width: 1920,
          screen_height: 1080,
          browser_online: true,
          cpu_core_num: 8,
          device_memory: 8,
          downlink: 10,
          effective_type: '4g',
          round_trip_time: 0,
        }),
      ),
    ),
  };
  for (const [k, v] of Object.entries(values)) if (!jar.get(k)) jar.set(k, v);
}

async function encryptForUA(text: string) {
  const key = await crypto.subtle.digest('SHA-256', enc.encode(UA));
  return Buffer.from(
    await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: new Uint8Array(key).slice(16) },
      await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt']),
      enc.encode(text),
    ),
  )
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_');
}
export async function challengeBody() {
  return {
    sign: await encryptForUA(Buffer.from(JSON.stringify(profile.fingerprint)).toString('base64')),
    sk: passportEncode(encodeURIComponent(profile.stack_current || profile.stack)),
  };
}
export const bitEnvironment = encryptForUA;
