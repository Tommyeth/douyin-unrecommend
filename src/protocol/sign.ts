// Adapted from yunsur/douyin-mcp, commit 7e90d139 (MIT).
// Copyright (c) 2026 Yunsur. See THIRD_PARTY_NOTICES.md.
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const enc = new TextEncoder();
const rot = (x: number, n: number) => (x << (n & 31)) | (x >>> ((32 - n) & 31));
export function sm3(input: Uint8Array | string) {
  const src = typeof input === 'string' ? enc.encode(input) : input;
  const buf = new Uint8Array(Math.ceil((src.length + 9) / 64) * 64);
  buf.set(src);
  buf[src.length] = 128;
  const view = new DataView(buf.buffer);
  view.setBigUint64(buf.length - 8, BigInt(src.length) * 8n);
  const v = new Uint32Array([
    0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e,
  ]);
  for (let p = 0; p < buf.length; p += 64) {
    const w = new Uint32Array(68);
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(p + i * 4);
    for (let i = 16; i < 68; i++) {
      const x = w[i - 16] ^ w[i - 9] ^ rot(w[i - 3], 15);
      w[i] = x ^ rot(x, 15) ^ rot(x, 23) ^ rot(w[i - 13], 7) ^ w[i - 6];
    }
    let [a, b, c, d, e, f, g, h] = v;
    for (let j = 0; j < 64; j++) {
      const s1 = rot((rot(a, 12) + e + rot(j < 16 ? 0x79cc4519 : 0x7a879d8a, j)) >>> 0, 7);
      const s2 = s1 ^ rot(a, 12);
      const t1 =
        ((j < 16 ? a ^ b ^ c : (a & b) | (a & c) | (b & c)) + d + s2 + (w[j] ^ w[j + 4])) >>> 0;
      const t2 = ((j < 16 ? e ^ f ^ g : (e & f) | (~e & g)) + h + s1 + w[j]) >>> 0;
      d = c;
      c = rot(b, 9);
      b = a;
      a = t1;
      h = g;
      g = rot(f, 19);
      f = e;
      e = t2 ^ rot(t2, 9) ^ rot(t2, 17);
    }
    [a, b, c, d, e, f, g, h].forEach((x, i) => (v[i] ^= x));
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  v.forEach((x, i) => ov.setUint32(i * 4, x));
  return out;
}
const s3 = 'ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe';
const s4 = 'Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe';
function b64(data: number[] | Uint8Array, alphabet: string) {
  let out = '';
  for (let i = 0; i < data.length; i += 3) {
    const v = ((data[i] & 255) << 16) | ((data[i + 1] || 0) << 8) | (data[i + 2] || 0);
    out +=
      alphabet[(v >>> 18) & 63] +
      alphabet[(v >>> 12) & 63] +
      (i + 1 < data.length ? alphabet[(v >>> 6) & 63] : '=') +
      (i + 2 < data.length ? alphabet[v & 63] : '=');
  }
  return out;
}
function rc4(key: number[], data: number[]) {
  const s = Array.from({ length: 256 }, (_, i) => 255 - i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j * s[i] + j + key[i % key.length]) % 256;
    [s[i], s[j]] = [s[j], s[i]];
  }
  let i = 0;
  j = 0;
  return data.map((x) => {
    i = (i + 1) % 256;
    j = (j + s[i]) % 256;
    [s[i], s[j]] = [s[j], s[i]];
    return x ^ s[(s[i] + s[j]) % 256];
  });
}
const perm = [
  34, 44, 56, 61, 73, 29, 70, 45, 35, 49, 38, 66, 51, 68, 28, 48, 64, 47, 30, 71, 26, 55, 31, 69,
  59, 40, 62, 63, 27, 72, 41, 74, 57, 52, 42, 39, 33, 67, 53, 43, 65, 46, 36, 24, 60, 32, 79, 80,
  84, 85,
];
const blend = (a: number, b: number, c: number, d: number) => [
  (c & 170) | (a & 85),
  (c & 85) | (a & 170),
  (d & 170) | (b & 85),
  (d & 85) | (b & 170),
];
const bytes = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const escape = (d: Uint8Array, i: number, res: number, fallback: number) => {
  while (d[i] === res) i++;
  return d[i] ?? fallback;
};
export class Signer {
  counter = 2;
  constructor(
    public ua = UA,
    public geo = [1920, 855, 1920, 1032, 1920, 1032, 1920, 1080],
    public now = Date.now,
    public random = Math.random,
    public platform = 'Win32',
  ) {}
  sign(query: string, body = '', host = 'www.douyin.com') {
    const cfg =
      host === 'login.douyin.com' ? [14, 0, 0, 0, 6383, 6241] : [8, 132, 1, 1, 6383, 11881];
    const L = new Array<number>(100).fill(0),
      t = this.now();
    this.counter++;
    const put = (p: number, x: number, n: number) => {
      for (let i = 0; i < n; i++) L[p + i] = Math.floor(x / 2 ** (8 * i)) & 255;
    };
    const h1 = sm3(sm3(query + 'dhzx')),
      h2 = sm3(sm3(body + 'dhzx'));
    const hu = sm3(b64(rc4([0, 1, cfg[0]], bytes(this.ua)), s3));
    L[24] = 41;
    L[26] = Math.trunc((t - 1721836800000) / 1209600000);
    L[27] = this.counter > 10745 ? 3 : this.counter > 1283 ? 4 : this.counter > 139 ? 5 : 6;
    L[28] = 3;
    put(29, t, 6);
    put(35, 1, 2);
    put(38, 1, 2);
    [L[40], L[41], L[42]] = cfg.slice(1, 4);
    put(44, cfg[0], 4);
    L[48] = h1[9];
    L[49] = h1[18];
    L[51] = escape(h1, 3, 11, 12);
    L[52] = h2[10];
    L[53] = h2[19];
    L[55] = escape(h2, 4, 8, 9);
    L[56] = hu[11];
    L[57] = hu[21];
    L[59] = escape(hu, 5, 12, 13);
    put(60, t - 1, 6);
    L[66] = 3;
    put(67, cfg[5], 4);
    put(71, cfg[4], 4);
    const geo = bytes([...this.geo, this.platform].join('|')),
      suffix = bytes(String((t + 3) & 255) + ',');
    put(79, geo.length, 2);
    put(84, suffix.length, 2);
    const r = Math.floor(this.random() * 65535),
      a8 = blend(1, 0, r & 255, (r >> 8) & 255);
    this.random();
    const p = Math.floor(this.random() * 240),
      p2 = (Math.floor(this.random() * 255) & 77) | 178;
    a8.push(...blend(1, 0, p > 109 ? p + (p % 2) + 1 : p, p2));
    const chk = [...a8, ...perm.map((i) => L[i])].reduce((a, b) => a ^ b, 0);
    const data = [...perm.map((i) => L[i]), ...geo, ...suffix, chk];
    const prefix = blend(
      3,
      82,
      Math.floor(this.random() * 65535) & 255,
      Math.floor(this.random() * 40),
    );
    const expanded: number[] = [];
    for (let i = 0; i < data.length; i += 3) {
      if (i + 2 < data.length) {
        const n = Math.floor(this.random() * 1000) & 255;
        expanded.push(
          (n & 145) | (data[i] & 110),
          (n & 66) | (data[i + 1] & 189),
          (n & 44) | (data[i + 2] & 211),
          (data[i] & 145) | (data[i + 1] & 66) | (data[i + 2] & 44),
        );
      } else {
        expanded.push(data[i]);
        if (data[i + 1]) expanded.push(data[i + 1]);
      }
    }
    return b64(
      [
        ...prefix,
        ...rc4(
          [211],
          [...a8, ...expanded].map((x) => x & 65535),
        ).map((x) => x & 255),
      ],
      s4,
    );
  }
}
