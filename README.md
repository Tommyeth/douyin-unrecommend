# 抖音推荐防误触

定时检查自己在抖音推荐过的作品，发现新增推荐时发消息提醒，或在检测到后自动取消。支持中文管理页、官方二维码登录、批量预览清理、Bark / 企业微信机器人 / Webhook / SMTP 邮箱。

**Vercel 版使用真实 Chromium，网页、扫码会话、每小时任务和加密状态都运行在 Vercel，无需自备服务器或 Cloudflare 账号。**

> Vercel 版本已通过真实账号验收：官方二维码与短信验证、加密保存并恢复登录态、读取新增推荐、自动取消并复核移除。实测新增 1 条、取消 1 条、完整列表归零。每小时 Schedules 已部署；通知协议通过自动测试，真实送达需配置自己的渠道。详细范围见 [Vercel 验证记录](docs/vercel-verification.md)。

## 两种模式

| 模式                    | 行为                                                                     |
| ----------------------- | ------------------------------------------------------------------------ |
| `notify` 仅提醒（默认） | 发现新增推荐时发送消息，保留推荐；需配置至少一个通知渠道                 |
| `auto_cancel` 自动取消  | 处理已有及新增推荐，保留名单除外；取消后读取完整列表，确认移除才记录成功 |

默认**每小时检查一次**。管理页支持 1–24 个整小时；检测到后立即处理，但不会实时监听手机误触。免费 Schedules 有 15 分钟调度窗口，网络耗时和失败退避也会增加延迟。两次检查之间发生又撤回的推荐可能被漏过。

首次完整检查会将已有推荐视为首次发现。保留的推荐不会重复提醒，完整扫描确认消失后再次出现则重新提醒。另有「预览本批 → 确认取消 → 复核」的批量清理功能，预览令牌一次有效，每批默认最多 5 条。

## Vercel 部署

使用 Node.js 24。以下命令从本分支部署；需要你自己的 Vercel 账号。每个客户使用独立项目、私有 Blob 与密钥，一个项目绑定一个抖音账号。

```bash
git clone --branch feat/vercel-chromium https://github.com/Tommyeth/douyin-unrecommend.git
cd douyin-unrecommend
npm ci
npx vercel@65.16.0 login
npx vercel@65.16.0 link
```

创建 **Private** Blob 并连接生产环境：

```bash
npx vercel@65.16.0 blob create-store douyin-private \
  --access private --region hnd1 --yes --environment production
```

CLI 会把 Blob 凭证配置进项目。不要创建 public 存储，也不要把凭证提交到 Git。

分别用两次 `openssl rand -hex 32` 生成两个不同的密钥，再通过 CLI 输入：

```bash
npx vercel@65.16.0 env add ADMIN_TOKEN production --sensitive
npx vercel@65.16.0 env add AUTH_SECRET production --sensitive
```

- `ADMIN_TOKEN`：管理页口令；只保留在页面内存中，刷新后重新输入。
- `AUTH_SECRET`：登录态及整个状态快照的 AES-GCM 加密密钥；应妥善备份，丢失后无法解密原状态。

按 [examples/notifications.json](examples/notifications.json) 选择通知渠道，把填好的 JSON 数组作为敏感环境变量保存：

```bash
npx vercel@65.16.0 env add NOTIFICATIONS_JSON production --sensitive
npx vercel@65.16.0 deploy --prod
```

`vercel.json` 使用新版 **Schedules**，不是旧版每天一次的 Hobby Cron Jobs。部署后检查：

```bash
npx vercel@65.16.0 schedules list
```

应看到 `douyin-hourly` 为 active，表达式 `0 * * * *`，目标为私有函数 `api/hourly`。私有任务没有公开调用 URL，管理 API 另有管理员口令与同源检查。

## 扫码与使用

1. 打开部署域名，输入 `ADMIN_TOKEN`。
2. 点击「生成 / 重新生成二维码」。页面展示的是 Vercel Chromium 中的官方抖音登录画面。
3. 用抖音 App 扫描**页面中的实时二维码**并确认，保持管理页连接。二维码可能自动刷新，不宜转发静态截图后长时间等待。
4. 如果画面出现验证方式选择或输入框，可直接点击画面人工操作；文字看不清时点击「放大 / 还原画面」。先点击远端输入框；系统确认焦点后显示「已选中远端输入框」，并自动定位到本地输入栏。在这里填写验证码等文本并点击「输入并确认」；也可用「输入到选中框」和「确认 / Enter」分步操作。上方图片不能直接键入；若 Enter 没有提交，请手动点击画面内的「验证」按钮。程序只转发你的操作，不自动选择验证答案。验证期间不会自动刷新页面；完成后若仍停在原画面，可点击「验证完成，检查登录」。
5. 只有登录态已成功加密持久化，页面才显示登录成功。会话从启动开始约 4 分钟，画面上方显示剩余时间，最后一分钟提示即将结束。主动退出时点击「取消扫码」，系统会提交独立取消请求并关闭云端浏览器。单纯关闭页面不一定能立即结束 Vercel 中的连接，会话会在期限内自动退出。
6. 使用「预览本批作品」核对本人推荐；按需要切换仅提醒或自动取消。仅提醒需先配置通知渠道，使用「测试通知」检查送达。
7. 之后无需保持网页打开，每小时任务会恢复登录态并执行，结束时关闭 Chromium。

人工操作通过已鉴权的接口和加密 Private Blob 临时转发，绑定当前扫码会话及画面。输入正文不写日志，消费时从待执行队列删除；未消费的输入在会话正常结束或下一次会话覆盖时清除。同一操作编号不会自动重放。每次会话最多 40 项操作，支持点击、文本、有限按键及主动检查登录；遇到滑块等尚未支持的交互，需停止并按官方流程处理。画面以 JPEG 传输，约每秒更新一次；操作等待时间仍受网络与 Blob 读写耗时影响。

取消使用官方网页环境内发起的 `familiar/recommend/cancel` 请求，由页面自己的请求环境处理签名；不是模拟点按「喜欢」，也不会重放旧签名。只允许取消本轮推荐接口实际读到的作品。取消成功需同时满足接口成功、完整推荐列表中已移除。

## 全流程如何留在 Vercel

- **Functions**：管理 API、真实 Chromium、二维码展示、读取与取消；单次工作有执行期限。
- **Private Blob**：保存整个加密状态快照，包括浏览器登录态、设置、去重记录与通知待发队列。SQLite 只在本次函数内存中执行查询，不依赖 `/tmp` 文件持久化。
- **条件写与一致读**：每次从 Blob 读取最新版本，用强 ETag 条件写争抢租约，避免两次检测或扫码同时操作账号；GET 禁用响应压缩，防止较大状态的弱 ETag 导致条件写失败。过期任务不能覆盖新任务结果。
- **Schedules**：每小时调用私有函数，按计划时间判断下一轮，兼容免费版的调度抖动。

通常每个检测任务写 Blob 两次：占用租约、保存结果并释放租约。异常中断后租约最长六分钟过期。临近函数执行期限时会把剩余通知留在队列，先保存本轮结果。外部通知采用至少一次投递，极端断线仍可能重复；Webhook 接收端可用 `Idempotency-Key` 去重。

不需要第三方数据库。抖音 App 和你选用的 Bark、企微或邮件服务仍是各自的外部服务，需要相应账号或密钥。

## 免费额度

截至 2026-11-16，Hobby 的 [Functions](https://vercel.com/docs/functions/limitations) 在 Fluid Compute 下每次最多 300 秒，2 GB / 1 vCPU；[Schedules](https://vercel.com/docs/schedules/limits) 每周期最多执行 5000 次，固定 15 分钟调度窗口，仍为 Beta。

按 31 天、每小时一次计算为 744 轮，通常约 1488 次 Blob 写入，低于 [Private Blob 的 2000 次高级操作额度](https://vercel.com/docs/vercel-blob/usage-and-pricing)。手动检测、扫码、修改设置、额外通知操作和其他项目用量另计；任务 CPU、内存时间、流量和存储各有配额，不能据此保证所有账号永久免费。

[Vercel Hobby](https://vercel.com/pricing) 面向个人、非商业用途；收费托管或商业客户服务应按适用套餐评估。项目不会自动开通付费计划。

## 参数和通知

| 参数                    | 默认值   | 说明                                      |
| ----------------------- | -------- | ----------------------------------------- |
| `MODE`                  | `notify` | 管理页保存的模式优先                      |
| `POLL_INTERVAL_SECONDS` | `3600`   | Vercel 使用 1–24 个整小时；管理页设置优先 |
| `MAX_PAGES`             | `10`     | 每轮最多读取页数                          |
| `MAX_ACTIONS`           | `5`      | 每轮/每批最多取消数                       |
| `ACTION_DELAY_MS`       | `3000`   | 取消后到复核前的等待                      |
| `PAGE_TIMEOUT_MS`       | `20000`  | 页面/接口等待上限                         |
| `IGNORE_IDS`            | 空       | 逗号分隔的保留作品 ID，不提醒、不取消     |
| `NOTIFICATIONS_JSON`    | `[]`     | 见通知示例；敏感变量                      |

| 通知协议       | 支持方式                                                  |
| -------------- | --------------------------------------------------------- |
| Bark           | 官方或自建服务，JSON POST                                 |
| 企业微信机器人 | 群机器人 Webhook，检查业务错误码                          |
| Webhook        | JSON POST，可附 Bearer token，携带事件 ID                 |
| SMTP           | 隐式 TLS 465、AUTH LOGIN、UTF-8 MIME；不支持 STARTTLS 587 |

事件有 `new_recommendation`、`cancelled`、`error`、`test`。队列失败后退避，在后续任务中重试；只有配置的渠道会收到消息。长期未读完全部推荐列表，不会把未看到的记录误判为已删除。

## 其他部署与开发

原有纯协议 Worker / Node / Docker 实验版保留，部署方法见 [纯协议说明](docs/pure-protocol.md)。该模式仍未通过真实登录验收，与 Vercel Chromium 的运行证据独立。

```bash
npm ci
npx playwright-core install --with-deps chromium
npm run check
npm test
npm run test:worker
```

Vercel 本地联调：用 `vercel env pull .env.local` 获取开发环境配置，补充两个独立密钥后运行 `npm run dev:vercel`；默认监听 `127.0.0.1:8791`。开发环境应连接自己的私有 Blob；不要误用客户生产存储。

`npm test` 包含真实 Chromium + 模拟抖音页面测试、状态并发与持久化、两种模式、协议签名和通知测试。模拟测试不会登录或操作真实账号。

敏感数据、`.env.local`、`.vercel/`、本地数据和截图均忽略。公开反馈请只提供去除个人信息的错误分类。许可证 [MIT](LICENSE)，依赖许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目与抖音/字节跳动无隶属关系。
