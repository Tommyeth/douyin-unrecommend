import schedule from '../vercel/schedule-policy.json' with { type: 'json' };

export type BrowserPolicy = {
  runtime: 'vercel-chromium' | 'docker-chromium' | 'cloudflare-hybrid' | 'vercel-hybrid';
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
export const vercelHybridPolicy: BrowserPolicy = {
  ...vercelPolicy,
  runtime: 'vercel-hybrid',
};
export const dockerPolicy: BrowserPolicy = {
  runtime: 'docker-chromium',
  minimumInterval: 300,
  intervalStep: 60,
  triggerSeconds: 15,
  loginTimeout: 900000,
  desktop: true,
};
