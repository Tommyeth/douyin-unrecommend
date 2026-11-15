import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const revision = 'f8d157532fbfaeda587e826d4cd5b21a49186f7c';
const target = new URL('../assets/fonts/NotoSansCJKsc-Regular.otf', import.meta.url);
const expected = '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b';
const valid = (data) => createHash('sha256').update(data).digest('hex') === expected;
let data = await readFile(target).catch(() => null);
if (!data || !valid(data)) {
  const r = await fetch(
    `https://raw.githubusercontent.com/notofonts/noto-cjk/${revision}/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf`,
    { signal: AbortSignal.timeout(60000) },
  );
  if (!r.ok) throw new Error('Noto font download failed: ' + r.status);
  data = Buffer.from(await r.arrayBuffer());
  if (!valid(data)) throw new Error('Noto font SHA-256 mismatch');
  await mkdir(new URL('../assets/fonts/', import.meta.url), { recursive: true });
  await writeFile(target, data);
}
