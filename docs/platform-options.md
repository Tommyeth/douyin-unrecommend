# 免费部署与平台选择

核对日期：2026-11-16。以下是官方运行条件与架构判断，**不代表抖音登录在对应平台已通过验收**。当前分支只有纯协议 Cloudflare 与 Node 入口，尚无 Vercel 部署适配。

| 方案                                 | 浏览器能力                                | 免费运行的主要限制                                                        | 本项目判断                                                                 |
| ------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 普通 Cloudflare Worker               | 无内置 Chromium；当前提供 DOM/Canvas 子集 | 每次 HTTP / Cron CPU 10 ms；128 MB 内存                                   | HTTP 定时任务合适，环境模拟的 CPU 仍需实测                                 |
| Worker + Browser Run                 | 使用 Cloudflare 独立托管 Chromium         | 浏览器合计每天 10 分钟，另计 Worker/D1 用量                               | 每小时或两小时执行并立即关闭浏览器，可降低用量；扫码等待也计入预算         |
| Vercel Node.js Functions + Schedules | 可打包适合 serverless 的 Chromium         | Fluid Compute 下 Hobby 单次最多 300 秒、2 GB / 1 vCPU；Schedules 另有限额 | 从运行条件看，更适合需要真实浏览器的短时任务；需要适配登录会话与外部数据库 |

来源：[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[Browser Run 定价](https://developers.cloudflare.com/browser-run/pricing/)、[Vercel Functions 限制](https://vercel.com/docs/functions/limitations/)、[Vercel Chromium 官方示例](https://vercel.com/kb/guide/deploying-puppeteer-with-nextjs-on-vercel)。Vercel 应选择 Node.js Functions；此处不是指 Edge Runtime。

## Vercel 的定时任务有两套限制

旧 [Cron Jobs](https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing) 在 Hobby 中每个任务最多每天执行一次，时间可落在配置小时内。

新的 [Schedules（Beta）](https://vercel.com/docs/schedules/limits) 支持 Hobby 最快每 15 分钟一次，固定 15 分钟调度抖动窗口；每个团队每计费周期最多执行 5000 次，手动运行也计数。一小时一次按 30 天算为 720 次，低于这一调度配额，但 Functions、数据库等仍分别消耗额度。Beta API 与限制可能变化。

## 浏览器与扫码流程

Vercel 可以运行真实 Chromium，这能省去手工补齐 DOM/Canvas 的工作。浏览器不应在函数返回后依赖进程内存继续等待下一次请求：扫码等待需要在有效执行期限内完成，或设计独立、可恢复的会话流程；登录 Cookie 等状态需加密保存到持久数据库。当前 Node 版的本地 SQLite 文件不能直接作为无状态 Functions 的持久存储。

每轮任务应恢复登录态、读取推荐、按模式通知或取消、复核结果，然后关闭浏览器。实际是否通过抖音登录仍需测量，云平台出口和 headless 浏览器不会自动获得平台认可。

## 个人使用与客户服务

[Vercel Hobby](https://vercel.com/pricing) 定位为个人、非商业用途。个人自行部署测试可以评估免费方案；收费托管或商业客户服务应按适用套餐评估，不能把 Hobby 当成商业服务的永久免费承诺。

本项目先保留一小时的默认检查间隔，可调到两小时。延长间隔会增加发现和取消延迟，并不会提高单次 CPU、内存或执行时长限制。
