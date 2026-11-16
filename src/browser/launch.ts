import serverChromium from '@sparticuz/chromium';
import { chromium, type Browser } from 'playwright-core';
import { copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export type LaunchBrowser = () => Promise<Browser>;
export const launchBrowser: LaunchBrowser = async () => {
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
  const serverPath = process.env.VERCEL ? await serverChromium.executablePath() : undefined;
  if (process.env.VERCEL) {
    await mkdir('/tmp/fonts', { recursive: true });
    await copyFile(
      resolve('assets/fonts/NotoSansCJKsc-Regular.otf'),
      '/tmp/fonts/NotoSansCJKsc-Regular.otf',
    );
  }
  return chromium.launch({
    executablePath: executablePath || serverPath,
    args: process.env.VERCEL ? serverChromium.args : [],
    headless: true,
    timeout: 30000,
  });
};
