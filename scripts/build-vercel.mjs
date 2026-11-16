import { mkdir, copyFile } from 'node:fs/promises';
import './prepare-vercel-font.mjs';
// The Vercel Node builder traces API dependencies and includes the pinned Chromium binaries.
await mkdir('public', { recursive: true });
await copyFile('LICENSE', 'public/LICENSE.txt');
