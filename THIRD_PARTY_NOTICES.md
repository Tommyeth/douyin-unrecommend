# 第三方代码与致谢

`src/protocol/sign.ts` 的 SM3、a_bogus 签名，参考并移植自 [yunsur/douyin-mcp](https://github.com/yunsur/douyin-mcp)，固定参考提交 `7e90d139007f141cb7389aa509d8e6e67f7b5840`。

本项目将相关 Go 代码移植为可在 Cloudflare Workers 执行的 TypeScript，没有引入上游 Go 进程或 HTTP 客户端依赖，仅保留本项目所需域名的签名分支。确定性签名测试向量同样来自该提交。

`src/protocol/token.ts` 参考 `strdata.go` 和 `mstoken.go`，`src/protocol/device-profile.json` 来自该提交的 `profiles/mstoken_profile.json`。该文件是上游的预设设备档案，不是 Worker 实时渲染或用户设备采集结果。

上游许可如下，适用于对应移植部分。

```text
MIT License

Copyright (c) 2026 Yunsur

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

```

## Vercel Chromium 运行时

- [Playwright](https://github.com/microsoft/playwright) 1.65.1，Apache-2.0；[许可](licenses/playwright.txt)、[NOTICE](licenses/playwright-notice.txt)。
- [@sparticuz/chromium](https://github.com/Sparticuz/chromium) 153.0.0，打包器 MIT；[许可](licenses/sparticuz-chromium.txt)。Chromium 二进制及其第三方组件仍适用各自许可，由锁定的 npm 包分发。
- [@vercel/blob](https://github.com/vercel/storage) 2.9.0，Apache-2.0；[许可](licenses/vercel-blob.txt)。
- 定时任务使用 Vercel 官方 `@vercel/schedules` 0.0.3 SDK；接口仍处于 Beta，使用方法见 [官方文档](https://vercel.com/docs/schedules/handle-runs)。

仓库不保存浏览器二进制或用户登录数据；依赖版本由 `package-lock.json` 锁定，安装和部署时获取。

## 中文验证画面字体

Vercel Chromium 使用 [Noto CJK](https://github.com/notofonts/noto-cjk) 的 `NotoSansCJKsc-Regular.otf`，上游提交固定为 `f8d157532fbfaeda587e826d4cd5b21a49186f7c`，SIL Open Font License 1.1，原始许可见 [licenses/noto-cjk.txt](licenses/noto-cjk.txt)。构建时下载并校验 SHA-256，原始字体不修改；函数启动前配置到 Chromium 的字体目录。字体不提交为仓库二进制文件。

## Docker 远程桌面

- [noVNC](https://github.com/novnc/noVNC/tree/v1.7.0) 1.7.0，核心 MPL-2.0；[许可说明](licenses/novnc.txt)、[MPL 原文](licenses/novnc-mpl-2.0.txt)、[pako 许可](licenses/novnc-pako.txt)。通过锁定的 npm 包打包原始客户端，不修改上游文件；对应源码可从上游标签或 `npm pack @novnc/novnc@1.7.0` 获取。
- [ws](https://github.com/websockets/ws) 8.23.0，MIT；[许可](licenses/ws.txt)。仅在 Docker 的同源鉴权入口转发 RFB 数据。
- Docker 的 Xvfb、Openbox、x11vnc、字体与系统库由 Debian 软件包安装，各自版权和许可保留在镜像 `/usr/share/doc/`；Chromium 由锁定版本的 Playwright 安装。

## Cloudflare Browser Run

混合版使用 [@cloudflare/playwright](https://github.com/cloudflare/browser-run/tree/main/packages/playwright-cloudflare) 1.4.0（Apache-2.0）；[许可证](licenses/cloudflare-browser-run.txt)。包中 Playwright 代码仍适用上述 Playwright 许可与 NOTICE。远端 Chromium 由 Cloudflare Browser Run 服务提供，本仓库不分发其二进制。
