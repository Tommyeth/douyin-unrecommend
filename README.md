# 抖音推荐管理

定时读取自己的「个人主页 → 推荐」。支持新增提醒、自动取消、手动预览清理，以及 Bark、企业微信机器人、Webhook、SMTP 通知。

提供两种部署：**Vercel** 无需自备服务器；**VPS Docker** 自带 Chromium 和 noVNC，可直接在面板里操作浏览器。一个部署管理一个抖音账号。

|                 | Vercel                                 | VPS Docker                                     |
| --------------- | -------------------------------------- | ---------------------------------------------- |
| 浏览器          | 函数内真实 Chromium                    | 容器内真实 Chromium                            |
| 扫码与验证      | 实时截图、点击转发、文字输入栏         | noVNC 桌面，直接点击、键入、拖动；保留截图备用 |
| 登录窗口        | 约 4 分钟                              | 15 分钟                                        |
| 检查间隔        | 默认最短 900 秒；付费调度可配置 300 秒 | 最短 **300 秒**，按 60 秒递增                  |
| 持久化          | 加密 Private Blob                      | 加密 SQLite，Docker 数据卷                     |
| 默认模式 / 间隔 | 仅提醒 / 3600 秒                       | 仅提醒 / 3600 秒                               |

Vercel 已通过真实账号的扫码、短信验证、恢复登录态、读取推荐及取消验收，见 [验证记录](docs/vercel-verification.md)。Docker 共用这些业务代码；容器测试覆盖真实 Chromium + noVNC 输入和模拟登录，不代表已在每个 VPS 网络上完成真实账号验收。

## 运行方式

- **仅提醒 `notify`**：发现新增推荐就发送消息，保留推荐。至少配置一个通知渠道。
- **自动取消 `auto_cancel`**：处理已有及新增推荐，跳过保留名单。可以不配置通知；取消后重新读取完整列表，确认移除才记为成功。
- **手动清理**：预览本批作品 → 确认取消 → 复核结果。每批默认最多 5 条。

首次完整检查把已有推荐视为首次发现；仍在列表中的同一条推荐不会重复提醒，完整扫描确认消失后又出现则重新提醒。这是定时检查，不能判断误触，也不能监听手机点击瞬间；「自动取消」指检查到后处理。间隔、调度延迟、失败退避和单批上限都会影响处理时间。

## 方式一：Vercel

需要 Node.js 24 和自己的 Vercel 账号。网页、浏览器、任务和状态全部位于 Vercel；无需 Cloudflare、外置数据库或服务器。

```bash
git clone https://github.com/Tommyeth/douyin-unrecommend.git
cd douyin-unrecommend
npm ci
npx vercel@65.16.0 login
npx vercel@65.16.0 link
npx vercel@65.16.0 blob create-store douyin-private \
  --access private --region hnd1 --yes --environment production
```

分别运行两次 `openssl rand -hex 32` 生成两个不同的密钥，妥善备份，然后按 CLI 提示输入：

```bash
npx vercel@65.16.0 env add ADMIN_TOKEN production --sensitive
npx vercel@65.16.0 env add AUTH_SECRET production --sensitive
```

- `ADMIN_TOKEN` 是面板管理口令，只保留在当前页面内存，刷新后重新输入。
- `AUTH_SECRET` 加密登录态和任务记录；丢失后无法恢复原状态。
- Blob 必须选择 **Private**。创建并关联项目后，CLI 自动配置其凭证。

需要提醒时，参照 [通知示例](examples/notifications.json) 配置自己的渠道，把 JSON 数组粘贴到敏感环境变量；只用自动取消可省略：

```bash
npx vercel@65.16.0 env add NOTIFICATIONS_JSON production --sensitive
npx vercel@65.16.0 deploy --prod
npx vercel@65.16.0 schedules list
```

调度 `douyin-hourly` 应为 active，表达式 **`*/15 * * * *`**，目标是私有函数 `api/hourly`。名称为兼容旧部署而保留；它每 15 分钟检查是否到期，实际读取抖音的间隔由面板决定，默认仍为一小时。未到期时只读状态，不启动 Chromium、不写 Blob。

### 调整 Vercel 间隔

默认可在面板选择 900、1800、3600 等秒数，以 900 秒递增，上限 86400 秒。旧版 3600 秒下限是项目配置，并非抖音要求。

Vercel Hobby 的 [Schedules 最短间隔为 15 分钟](https://vercel.com/docs/schedules/limits)，固定 15 分钟调度窗口。若使用支持 5 分钟调度的付费计划：

```bash
npm run schedule:vercel -- 300
npx vercel@65.16.0 deploy --prod
```

脚本同步修改调度表达式和面板/API 的间隔限制，部署后再在面板保存 300 秒。恢复免费版兼容配置用 `npm run schedule:vercel -- 900` 后重新部署。项目不会自动变更套餐。

### Vercel 扫码输入

打开部署域名，输入管理口令，点击「生成 / 重新生成二维码」，用抖音 App 扫描页面里的实时二维码。

画面是远端 Chromium 的**截图**，不是本地浏览器窗口，所以不能直接在图片上键入。出现验证时：

1. 点击画面里的选项或输入框；必要时放大画面。
2. 显示「已选中远端输入框」后，在下方文字栏填写，点击「输入并确认」。若 Enter 无效，手动点击画面中的验证按钮。
3. 完成后等待保存；必要时点击「检查登录结果」。只有加密状态保存成功才显示已登录。

输入只用于转发当前人工操作，不写日志，消费后从临时队列删除；每次会话最多 40 项操作。窗口约 4 分钟，倒计时结束会关闭。图片约每秒更新一次，响应速度受网络和 Blob 读写影响。**Vercel 版不提供 noVNC 常驻 WebSocket 桌面**；需要完整鼠标键盘操作时使用 Docker 版。

### Vercel 额度

截至 2026-11-16，Hobby [Functions](https://vercel.com/docs/functions/limitations) 单次最多 300 秒，2 GB / 1 vCPU；[Schedules](https://vercel.com/docs/schedules/limits) 每周期最多 5000 次，仍为 Beta。

默认调度每 15 分钟触发，31 天为 2976 次；若实际每小时检测，通常有 744 轮浏览器任务、约 1488 次 Blob 写入。若改成每 15 分钟实际检测，则约 5952 次写入，超过 [Blob 免费高级操作额度](https://vercel.com/docs/vercel-blob/usage-and-pricing)。扫码、人工操作、设置、流量和计算也有额外用量；可选间隔不等于能保证落在免费额度内。

[Vercel Hobby](https://vercel.com/pricing) 面向个人、非商业用途；客户商业托管请按适用套餐部署。

## 方式二：VPS Docker（支持 noVNC）

使用能运行 Docker Engine + Compose 的 Linux VPS。建议至少 2 GB 可用内存；实际占用随抖音页面变化。首次构建会下载 Chromium 和中文字体。

```bash
git clone https://github.com/Tommyeth/douyin-unrecommend.git
cd douyin-unrecommend
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
```

编辑 `.env`，把两个不同的随机值分别填入 `ADMIN_TOKEN`、`AUTH_SECRET`。若希望每 5 分钟自动取消且暂不通知：

```dotenv
MODE=auto_cancel
POLL_INTERVAL_SECONDS=300
NOTIFICATIONS_JSON=[]
```

保留其他参数的默认值，然后启动：

```bash
docker compose up -d --build
docker compose logs -f --tail=100
```

默认只监听 VPS 的 `127.0.0.1:8787`。在自己电脑执行 SSH 隧道：

```bash
ssh -N -L 8787:127.0.0.1:8787 user@your-vps
```

在本地打开 `http://127.0.0.1:8787`，输入 `ADMIN_TOKEN` 即可。若改用域名访问，配置 HTTPS 反向代理并设置 `.env` 中的 `PUBLIC_ORIGIN=https://douyin.example.com`，重建容器；代理需支持 WebSocket 和流式响应，见 [Nginx 示例](examples/nginx.conf)。

### 直接控制 Chromium

1. 点击「打开登录浏览器」。页面自动连接 noVNC，显示容器里的完整 Chromium 窗口。
2. 用抖音 App 扫码。出现验证时，**直接在浏览器画面里点击、键入、按 Enter 或拖动**，由你本人完成。
3. 登录窗口最长 15 分钟；成功保存后关闭浏览器并撤销桌面连接。之后不必保持面板打开。
4. 连接中断可点击「重新连接桌面」。截图及文字输入栏仍可备用；中文输入法或移动设备键盘不兼容时，可使用文字输入栏。

容器内运行 Xvfb、Chromium、x11vnc 和 Node 服务；noVNC 客户端随项目打包。VNC 的 5900 端口仅绑定容器内部回环地址，**不需要开放 5900 或 6080**。WebSocket 通过面板同源入口连接，要求管理口令换取的 HttpOnly 会话 Cookie，绑定当前登录窗口；结束后撤销。日常检测使用无头 Chromium，不开放桌面。

Docker 检查间隔支持 **300–86400 秒，按 60 秒递增**，例如 300、600、900、3600。后台每 15 秒检查到期任务，不依赖浏览器页面或外部 Cron。

### 保存、更新与备份

设置、加密登录态、去重记录和通知队列保存在 Compose 的 `douyin-data` 数据卷，普通重启或重新构建不会丢失。面板保存的模式和间隔优先于 `.env` 默认值；修改 `.env` 后不要误以为覆盖了已保存设置。

```bash
# 更新代码和镜像
git pull --ff-only
docker compose up -d --build

# 查看状态与重启
docker compose ps
docker compose restart

# 备份：暂停写入后复制整个数据目录（含 SQLite WAL）
docker compose stop
mkdir -p backup
docker compose cp douyin:/app/data ./backup/
docker compose start
```

同时备份 `.env` 中的 `AUTH_SECRET`；不要把备份提交到公开仓库。`docker compose down` 保留数据，`down -v` 会删除数据卷。旧纯协议 SQLite 不会自动迁移，切换 Chromium 版后重新扫码。

## 配置与通知

| 参数                    | 默认值   | 说明                                   |
| ----------------------- | -------- | -------------------------------------- |
| `MODE`                  | `notify` | `notify` / `auto_cancel`，面板设置优先 |
| `POLL_INTERVAL_SECONDS` | `3600`   | 面板设置优先；范围见两种部署说明       |
| `MAX_PAGES`             | `10`     | 每轮读取页数上限                       |
| `MAX_ACTIONS`           | `5`      | 每轮/每批取消数上限                    |
| `ACTION_DELAY_MS`       | `3000`   | 取消后到复核前的等待                   |
| `PAGE_TIMEOUT_MS`       | `20000`  | 页面/接口等待上限                      |
| `IGNORE_IDS`            | 空       | 逗号分隔的保留作品 ID，不提醒、不取消  |
| `NOTIFICATIONS_JSON`    | `[]`     | 通知渠道 JSON 数组，见示例             |
| `PUBLIC_ORIGIN`         | 空       | Docker HTTPS 反向代理的来源地址        |

| 通知渠道       | 支持方式                                                  |
| -------------- | --------------------------------------------------------- |
| Bark           | 官方或自建服务，JSON POST                                 |
| 企业微信机器人 | 群机器人 Webhook，检查业务错误码                          |
| Webhook        | JSON POST，可附 Bearer token，携带事件 ID                 |
| SMTP           | 隐式 TLS 465、AUTH LOGIN、UTF-8 MIME；不支持 STARTTLS 587 |

事件有 `new_recommendation`、`cancelled`、`error`、`test`。通知失败后退避重试，只有配置的渠道会收到消息；外部投递在极端断线时可能重复，Webhook 可用 `Idempotency-Key` 去重。建议配置后先点击「测试通知」。

取消请求由官方网页环境发起 `familiar/recommend/cancel`，页面处理签名；只允许取消本轮推荐列表实际读到的作品，并检查接口成功和完整列表已移除，不操作「喜欢」。账号不匹配、读取失败或需重新登录时停止相关操作。

## 开发与验证

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
- Vercel 本地：`vercel env pull .env.local` 后运行 `npm run dev:vercel`，默认 `127.0.0.1:8791`；请连接开发用私有 Blob。
- 原纯协议 Cloudflare Worker / Node 保留为实验路径，未通过真实登录整体验收，见 [纯协议说明](docs/pure-protocol.md)。Docker 默认已改用 Chromium；纯协议 Node 入口是 `npm run start:protocol`。

公开反馈请去除账号、验证码及 Cookie。许可证 [MIT](LICENSE)，依赖许可见 [第三方说明](THIRD_PARTY_NOTICES.md)。本项目与抖音/字节跳动无隶属关系。
