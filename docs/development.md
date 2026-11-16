# 开发与验证

```bash
npm ci
npx playwright-core install --with-deps chromium
npm run build:desktop
npm run check
npm test
npm run test:worker
```

- Docker 桌面集成测试由 GitHub Actions 构建真实镜像，验证 noVNC 点击、直接输入、Enter 提交、加密保存，以及 300 秒设置。使用模拟抖音页面，不连接真实账号。
- 本地 Node：配置 `.env` 后运行 `npm run dev`；默认无桌面。如自行提供 Xvfb/x11vnc，可设 `DESKTOP_ENABLED=1`。
- Vercel 混合版测试覆盖浏览器关闭后纯协议执行、旧会话转换、候选重试、失效会话停止调度；`tsc --noEmit false --outDir dist/node-check` 后原生 Node 导入 `dist/node-check/src/vercel/app.js`，检查生产模块加载。
- Vercel 本地：`vercel env pull .env.local` 后运行 `npm run dev:vercel`，默认 `127.0.0.1:8791`；请连接开发用私有 Blob。
- Cloudflare 混合版使用 `wrangler.hybrid.jsonc`，部署见 [混合版说明](cloudflare-hybrid.md)；`npm run test:hybrid` 验证 workerd + D1 中的协议执行且没有浏览器调用。
- 原纯协议 Cloudflare Worker / Node 保留为实验路径，未通过真实登录整体验收，见 [纯协议说明](pure-protocol.md)。Docker 默认已改用 Chromium；纯协议 Node 入口是 `npm run start:protocol`。
- Dots 直控版使用宿主云浏览器和已保存的定时任务，不访问现有管理 API。构建包用 `npm run build:dots`，验证状态逻辑用 `python3 tests/dots_state_test.py`，详见 [使用与验收](dots.md)。

公开反馈请去除账号、验证码及 Cookie。许可证 [MIT](../LICENSE)，依赖许可见 [第三方说明](../THIRD_PARTY_NOTICES.md)。本项目与抖音/字节跳动无隶属关系。
