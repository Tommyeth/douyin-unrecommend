import { serve } from '@hono/node-server';
import { vercelApp } from './app.js';
serve({ fetch: vercelApp().fetch, hostname: '127.0.0.1', port: Number(process.env.PORT || 8791) });
console.log('Vercel-compatible app: http://127.0.0.1:' + (process.env.PORT || 8791));
