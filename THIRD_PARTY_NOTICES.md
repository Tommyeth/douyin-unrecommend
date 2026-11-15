# 第三方代码与致谢

`src/protocol/sign.ts` 的 SM3、a_bogus 和 Passport 签名，以及 `src/protocol/login.ts` 的 Passport 参数构建，参考并移植自 [yunsur/douyin-mcp](https://github.com/yunsur/douyin-mcp)，固定参考提交 `7e90d139007f141cb7389aa509d8e6e67f7b5840`。

本项目将相关 Go 代码移植为可在 Cloudflare Workers 执行的 TypeScript，没有引入上游 Go 进程或 HTTP 客户端依赖，仅保留本项目所需域名的签名分支。确定性签名测试向量同样来自该提交。上游许可如下，适用于对应移植部分。

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
