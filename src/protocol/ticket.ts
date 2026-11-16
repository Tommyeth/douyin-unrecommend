// P-256 ticket-guard helpers adapted from yunsur/douyin-mcp (MIT).
// Copyright (c) 2026 Yunsur. See THIRD_PARTY_NOTICES.md.
import { SafeError } from '../types.js';
import type { CookieJar } from './http.js';

export type TicketState = {
  privateKey: JsonWebKey;
  publicKey: string;
  secTs?: string;
  serverCert?: string;
  tsSign?: string;
};
const enc = new TextEncoder();
const b64 = (value: ArrayBuffer) => Buffer.from(value).toString('base64');
const cookie = (value: unknown) =>
  encodeURIComponent(Buffer.from(JSON.stringify(value)).toString('base64'));

export class TicketGuard {
  constructor(public state: TicketState) {}
  static async create() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ]);
    return new TicketGuard({
      privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey),
      publicKey: b64(await crypto.subtle.exportKey('raw', pair.publicKey)),
    });
  }
  absorb(response: Response) {
    const secTs = response.headers.get('bd-ticket-guard-sec-ts');
    // The server value is opaque (it is not necessarily a numeric timestamp).
    if (secTs && secTs.length <= 2048 && /^[\x21-\x7e]+$/.test(secTs)) this.state.secTs = secTs;
  }
  async sync(jar: CookieJar) {
    const s = this.state;
    jar.set(
      'bd_ticket_guard_client_data',
      cookie({
        'bd-ticket-guard-version': 2,
        'bd-ticket-guard-iteration-version': 1,
        'bd-ticket-guard-ree-public-key': s.publicKey,
        'bd-ticket-guard-web-version': 2,
      }),
    );
    jar.set('bd_ticket_guard_client_web_domain', '2');
    if (!s.secTs || !s.serverCert) return;
    const key = await this.sharedKey();
    const reqSign = b64(await crypto.subtle.sign('HMAC', key, enc.encode('sec_ts=' + s.secTs)));
    jar.set(
      'bd_ticket_guard_client_data_v2',
      cookie({
        ree_public_key: s.publicKey,
        ...(s.tsSign ? { ts_sign: s.tsSign } : {}),
        req_content: 'sec_ts',
        req_sign: reqSign,
        sec_ts: s.secTs,
      }),
    );
  }
  async sharedKey() {
    const cert = this.state.serverCert || '';
    let point: Uint8Array;
    if (cert.startsWith('pub.')) point = Buffer.from(cert.slice(4), 'base64');
    else {
      const der = Buffer.from(cert.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''), 'base64');
      const prefix = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
      const offset = der.indexOf(prefix);
      if (offset < 0) throw new SafeError('LOGIN_CERT', '登录服务端证书中缺少 P-256 公钥。');
      point = der.subarray(offset + prefix.length, offset + prefix.length + 65);
    }
    if (point.length !== 65 || point[0] !== 4)
      throw new SafeError('LOGIN_CERT', '登录服务端公钥格式无效。');
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      this.state.privateKey,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    );
    const publicKey = await crypto.subtle.importKey(
      'raw',
      point as BufferSource,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const shared = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: publicKey },
      privateKey,
      256,
    );
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new Uint8Array() },
      await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']),
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign'],
    );
  }
}
