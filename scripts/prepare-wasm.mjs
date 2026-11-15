import { mkdir, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const destination = new URL('../src/generated/', import.meta.url);
await mkdir(destination, { recursive: true });
await copyFile(
  require.resolve('@jitl/quickjs-wasmfile-release-sync/wasm'),
  new URL('quickjs.wasm', destination),
);
