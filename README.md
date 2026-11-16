# 抖音推荐管理

定时检查自己「个人主页 → 推荐」里的视频，支持**新增提醒**或**自动取消**，也可手动预览后批量清理。后台面板可配置 Bark、企业微信机器人、Webhook、SMTP，检测到登录失效时通知；一个部署绑定一个抖音账号。

| 方案与部署文档                                          | 登录 / 日常处理                     | 月费参考（美元）                                  | 部署条件与验收状态                                                                                                                                                              |
| ------------------------------------------------------- | ----------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[Vercel 混合版](docs/vercel.md)**                     | Chromium 扫码 / Node 纯协议         | Hobby $0；Pro $20/开发者席位起，另计超额用量      | 无需服务器；Private Blob 持久化。Hobby 最短 15 分钟调度，但持续 15 分钟写入超出 Blob 免费额度。真实扫码、纯协议读取与取消已通过，[验收记录](docs/vercel-hybrid-verification.md) |
| **[Cloudflare Paid 混合版](docs/cloudflare-hybrid.md)** | Browser Run 扫码 / Worker 纯协议    | Workers Paid $5 起；浏览器含 10 小时/月，超出另计 | 无需服务器；D1 持久化。默认 15 分钟，真实扫码、读取和取消已通过；直接键鼠控制仍有兼容限制                                                                                       |
| **[VPS Docker](docs/docker.md)**                        | Chromium 扫码和日常处理，noVNC 直控 | 项目免费；自付 VPS、存储和流量                    | Linux Docker，建议至少 2 GB 可用内存，最短 5 分钟；容器与模拟页面验收通过，真实账号需按服务器出口测试                                                                           |
| [Dots 云浏览器直控](docs/dots.md)                       | Dot 操作自己的云浏览器              | 依宿主订阅与任务额度，不承诺免费 VPS              | 实验技能包；真实云端扫码、取消和定时任务未验收                                                                                                                                  |
| [全程纯协议 Worker / Node](docs/pure-protocol.md)       | 扫码、读取、取消都尝试协议          | 依运行平台与额度                                  | 实验路径，真实扫码登录未跑通；不建议作为长期任务部署                                                                                                                            |

价格核对于 **2026-11-16**，不含税及超额用量：[Vercel 套餐](https://vercel.com/pricing)、[Blob 额度](https://vercel.com/docs/vercel-blob/usage-and-pricing)、[Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)、[Browser Run 定价](https://developers.cloudflare.com/browser-run/pricing/)。Vercel Hobby 用于个人非商业项目；客户托管需选适用套餐。其他平台的评估见 [部署可行性说明](docs/platform-options.md)。

Vercel / Cloudflare 在登录后关闭浏览器，日常任务独立请求接口；协议失败时停止并报告，不自动改用浏览器。Docker 适合需要直接操作远端 Chromium 的用户。各方案的架构图、安装命令、扫码方法、费用与限制都在上表链接中。

- **仅提醒**：发现新增推荐后发送消息，保留推荐，需要配置通知渠道。
- **自动取消**：取消已读到的推荐，跳过保留名单，再完整读取确认移除；每轮默认最多 5 条，可以不发通知。
- **定时检查**：按所选间隔运行，不能识别是否误触，也不能在手机点击瞬间处理。登录失效或安全验证需要本人操作。

Vercel / Docker 新部署默认仅提醒、每小时；Cloudflare 混合版默认自动取消、每 15 分钟、不发通知。已有面板设置优先于部署默认值。

[模式、参数与通知](docs/configuration.md) · [开发与测试](docs/development.md) · [MIT 许可证](LICENSE) · [第三方许可](THIRD_PARTY_NOTICES.md)

反馈问题时请移除账号、验证码、Cookie 和密钥。本项目与抖音/字节跳动无隶属关系。
