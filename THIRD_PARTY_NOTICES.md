# 第三方代码与致谢

`src/protocol/sign.ts` 的 SM3、a_bogus 和 Passport 签名，以及 `src/protocol/login.ts` 的 Passport 参数构建，参考并移植自 [yunsur/douyin-mcp](https://github.com/yunsur/douyin-mcp)，固定参考提交 `7e90d139007f141cb7389aa509d8e6e67f7b5840`。

本项目将相关 Go 代码移植为可在 Cloudflare Workers 执行的 TypeScript，没有引入上游 Go 进程或 HTTP 客户端依赖，仅保留本项目所需域名的签名分支。确定性签名测试向量同样来自该提交。

`src/protocol/ticket.ts` 参考该提交的 `bd_ticket.go`、`passport.go` 和 `api_session.go`，使用 Web Crypto 实现 P-256 / ECDH / HKDF / HMAC 登录凭证交换。`src/protocol/token.ts` 参考 `strdata.go` 和 `mstoken.go`，`src/protocol/device-profile.json` 来自该提交的 `profiles/mstoken_profile.json`。该文件是上游的预设设备档案，不是 Worker 实时渲染或用户设备采集结果。

上游许可如下，适用于对应移植部分。

`src/protocol/fingerprint.ts` 参考该提交的 `fpk.go`、`challenge.go`、`login.go`。`src/protocol/challenge-profile.json` 来自 `profiles/challenge_profile.json`；早期最小环境参考 `profiles/challenge_template_runner.js`；现由 `src/protocol/environment/runtime.js` 中的 LinkeDOM、CanvasKit 桥接与有预算的任务调度替代，不使用上游 Node vm 或文件读取。档案是上游预设数据，不包含本项目用户的浏览器会话。

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

## QuickJS WebAssembly

使用 [quickjs-emscripten](https://github.com/justjake/quickjs-emscripten) 0.32.0 的 `quickjs-emscripten-core` 和 `@jitl/quickjs-wasmfile-release-sync`。部署包中的 WASM 来自锁定的 npm 依赖，其许可证如下：

```text
quickjs-emscripten:
The MIT License

quickjs-emscripten copyright (c) 2019-2024 Jake Teton-Landis

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


quickjs:
QuickJS Javascript Engine

Copyright (c) 2017-2021 Fabrice Bellard
Copyright (c) 2017-2021 Charlie Gordon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

```

## DOM、Canvas 与字体

- [LinkeDOM](https://github.com/WebReflection/linkedom) 0.18.15，ISC 许可，提供 QuickJS 内的 DOM；原始许可见 [licenses/linkedom.txt](licenses/linkedom.txt)。
- [Skia CanvasKit](https://skia.org/docs/user/modules/canvaskit/) 0.42.0，BSD-3-Clause 许可，提供 CPU Canvas 2D 栅格化。`scripts/prepare-wasm.mjs` 对锁定版本的加载器加入预编译 WASM 模块注入，避免 Worker 动态读取或编译 WASM。原始许可见 [licenses/canvaskit.txt](licenses/canvaskit.txt)。
- Fontsource 分发的 Arimo / Tinos / Cousine 5.3.0，只嵌入 Latin、400、normal 的 WOFF 字体，未修改字体文件。字体采用 SIL Open Font License 1.1；原始版权及许可见 [Arimo](licenses/arimo.txt)、[Tinos](licenses/tinos.txt)、[Cousine](licenses/cousine.txt)。运行时的 Arial / Times New Roman / Courier New 名称映射到这些替代字体，并不包含微软字体，也不宣称像素完全相同。

生成的运行文件存放在忽略目录 `src/generated/`，来源由 `package-lock.json` 锁定。分发构建产物时应一并保留本说明和 `licenses/`。

## Vercel Chromium 运行时

- [Playwright](https://github.com/microsoft/playwright) 1.65.1，Apache-2.0；[许可](licenses/playwright.txt)、[NOTICE](licenses/playwright-notice.txt)。
- [@sparticuz/chromium](https://github.com/Sparticuz/chromium) 153.0.0，打包器 MIT；[许可](licenses/sparticuz-chromium.txt)。Chromium 二进制及其第三方组件仍适用各自许可，由锁定的 npm 包分发。
- [@vercel/blob](https://github.com/vercel/storage) 2.9.0，Apache-2.0；[许可](licenses/vercel-blob.txt)。
- 定时任务使用 Vercel 官方 `@vercel/schedules` 0.0.3 SDK；接口仍处于 Beta，使用方法见 [官方文档](https://vercel.com/docs/schedules/handle-runs)。

仓库不保存浏览器二进制或用户登录数据；依赖版本由 `package-lock.json` 锁定，安装和部署时获取。
