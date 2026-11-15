const enc = new TextEncoder();
export async function digest(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', enc.encode(value));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}
async function key(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    await crypto.subtle.digest('SHA-256', enc.encode(secret)),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
}
export async function seal(value: unknown, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await key(secret),
    enc.encode(JSON.stringify(value)),
  );
  return JSON.stringify({
    v: 1,
    iv: Buffer.from(iv).toString('base64'),
    data: Buffer.from(data).toString('base64'),
  });
}
export async function unseal<T>(value: string, secret: string): Promise<T> {
  const obj = JSON.parse(value);
  if (obj.v !== 1) throw new Error('Unsupported encryption version');
  const data = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(obj.iv, 'base64') },
    await key(secret),
    Buffer.from(obj.data, 'base64'),
  );
  return JSON.parse(new TextDecoder().decode(data));
}
export async function validToken(received: string, expected: string) {
  const a = await digest(received);
  const b = await digest(expected);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
