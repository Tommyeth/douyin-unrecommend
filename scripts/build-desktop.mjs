import { build } from 'esbuild';
await build({
  entryPoints: ['src/desktop/client.js'],
  outfile: 'dist/desktop.js',
  bundle: true,
  format: 'esm',
  minify: true,
  legalComments: 'eof',
  target: 'es2022',
});
