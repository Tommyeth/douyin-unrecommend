import serverChromium from '@sparticuz/chromium';
import { chromium, type Browser } from 'playwright-core';

export type LaunchBrowser = () => Promise<Browser>;
export const launchBrowser: LaunchBrowser = async () => {
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
  return chromium.launch({
    executablePath:
      executablePath || (process.env.VERCEL ? await serverChromium.executablePath() : undefined),
    args: process.env.VERCEL ? serverChromium.args : [],
    headless: true,
    timeout: 30000,
  });
};
