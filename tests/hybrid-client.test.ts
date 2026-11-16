import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transform } from 'esbuild';

test('经 Wrangler 同样的 UA 替换后，序列化采集函数仍读取远端 Chromium 标识', async () => {
  const source = await readFile(new URL('../src/hybrid/client.ts', import.meta.url), 'utf8');
  const { code } = await transform(source, {
    loader: 'ts',
    format: 'cjs',
    define: { 'navigator.userAgent': '"Cloudflare-Workers"' },
  });
  const bundled = { exports: {} as { captureBrowserClient: () => unknown } };
  vm.runInNewContext(code, { module: bundled });
  const fixture = {
    window: { navigator: { userAgent: 'real-remote-Chromium' } },
    navigator: { platform: 'Linux x86_64' },
    performance: {
      getEntriesByType: () => [
        {
          name: 'https://www.douyin.com/aweme/v1/web/familiar/recommend/feed/?device_platform=&browser_platform=Linux&webid=123&sec_user_id=private',
        },
      ],
    },
    innerWidth: 1100,
    innerHeight: 800,
    outerWidth: 1100,
    outerHeight: 800,
    screen: { availWidth: 1280, availHeight: 720, width: 1280, height: 720 },
    URL,
    URLSearchParams,
  };
  const result = vm.runInNewContext(
    '(' + bundled.exports.captureBrowserClient.toString() + ')()',
    fixture,
  );
  assert.equal(result.userAgent, 'real-remote-Chromium');
  assert.equal(result.query.webid, '123');
  assert.equal(result.query.device_platform, undefined);
  assert.equal(result.query.sec_user_id, undefined);
});
