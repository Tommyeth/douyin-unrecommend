import schedule from '../vercel/schedule-policy.json';

export type BrowserPolicy = {
  runtime: 'vercel-chromium' | 'docker-chromium';
  minimumInterval: number;
  intervalStep: number;
  triggerSeconds: number;
  loginTimeout: number;
  desktop: boolean;
};
export const vercelPolicy: BrowserPolicy = {
  ...schedule,
  runtime: 'vercel-chromium',
  loginTimeout: 235000,
  desktop: false,
};
export const dockerPolicy: BrowserPolicy = {
  runtime: 'docker-chromium',
  minimumInterval: 300,
  intervalStep: 60,
  triggerSeconds: 15,
  loginTimeout: 900000,
  desktop: true,
};
