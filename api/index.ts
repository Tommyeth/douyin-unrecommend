import { getRequestListener } from '@hono/node-server';
import { vercelApp } from '../src/vercel/app.js';
export default getRequestListener((request) => {
  try {
    return vercelApp().fetch(request);
  } catch {
    return Response.json(
      { error: 'CONFIG', message: '请配置独立的 ADMIN_TOKEN、AUTH_SECRET 和私有 Blob。' },
      { status: 503 },
    );
  }
});
