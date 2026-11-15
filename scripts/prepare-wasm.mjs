import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const destination = new URL('../src/generated/', import.meta.url);
await mkdir(destination, { recursive: true });
await copyFile(
  require.resolve('@jitl/quickjs-wasmfile-release-sync/wasm'),
  new URL('quickjs.wasm', destination),
);
await copyFile(
  require.resolve('canvaskit-wasm/bin/canvaskit.wasm'),
  new URL('canvaskit.wasm', destination),
);
// CanvasKit 0.42 removed instantiateWasm from INCOMING_MODULE_JS_API.
// Restore compiled-module injection; never fetch/compile WASM dynamically in workerd.
const canvasSource = await readFile(require.resolve('canvaskit-wasm'), 'utf8');
const needle = 'async function hb(a){var b=eb;';
if (canvasSource.split(needle).length !== 2)
  throw Error('CanvasKit loader changed; review the compiled-module adapter');
await writeFile(
  new URL('canvaskit.cjs', destination),
  canvasSource.replace(
    needle,
    'async function hb(a){if(u.wasmModule)return {instance:new WebAssembly.Instance(u.wasmModule,a)};var b=eb;',
  ),
);
const result = await build({
  entryPoints: ['src/protocol/environment/runtime.js'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  write: false,
  minify: true,
  legalComments: 'inline',
});
await writeFile(
  new URL('environment.ts', destination),
  '// Generated from pinned dependencies. Do not edit.\nexport const environment=' +
    JSON.stringify(result.outputFiles[0].text) +
    ';\n',
);
const fonts = [];
for (const [pkg, aliases] of [
  ['arimo', ['Arimo', 'Arial', 'sans-serif']],
  ['tinos', ['Tinos', 'Times New Roman', 'serif']],
  ['cousine', ['Cousine', 'Courier New', 'monospace']],
]) {
  const data = (
    await readFile(require.resolve(`@fontsource/${pkg}/files/${pkg}-latin-400-normal.woff`))
  ).toString('base64');
  for (const family of aliases) fonts.push({ family, data });
}
await writeFile(
  new URL('environment-assets.ts', destination),
  '// Generated from OFL font packages.\nexport const fonts=' + JSON.stringify(fonts) + ';\n',
);
