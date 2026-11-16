# 状态文件与命令

需要 Python 3.10+，只使用标准库。`state.py` 接受 `--state` 指定绝对路径。状态中不存 Cookie、口令或验证码；目录保持私有，不放到 Git 仓库或公开附件。下面用 `STATE` 和 `SCRIPT` 表示已确认的云电脑路径；命令行里的账号和模式必须来自当前用户授权。

```sh
python3 "$SCRIPT" --state "$STATE" init --account '页面确认的抖音号' --mode notify
python3 "$SCRIPT" --state "$STATE" status
python3 "$SCRIPT" --state "$STATE" configure --mode auto_cancel
python3 "$SCRIPT" --state "$STATE" configure --keep '111,222'
python3 "$SCRIPT" --state "$STATE" configure --paused true
python3 "$SCRIPT" --state "$STATE" begin --account '页面再次确认的抖音号'
```

`begin` 输出 `run` 和 `expires_at`（Unix 秒），本轮其余命令带相同 run。锁忙或状态丢失时不要新建状态覆盖。过期任务停止后可以开始新一轮；每轮必须重新读页面。

用环境提供的文件写入工具保存观察 JSON，数字 ID 始终为字符串：

```json
{
  "account": "example.account",
  "complete": true,
  "end_reason": "end_marker",
  "videos": [
    {"id": "111", "title": "示例作品", "url": "https://www.douyin.com/video/111"}
  ]
}
```

- `end_reason`：明确空列表用 `empty`；明确结束提示用 `end_marker`；总数匹配用 `count_matched` 并附整数 `total`。不完整时 `complete:false`，省略结束原因。
- 记录的 URL 不带追踪参数；脚本仅接受与 ID 一致的官方 `/video/`、`/note/` 链接。
- 不要把未实际观察的数据、外部作者页数据或猜测总数填进去。

```sh
python3 "$SCRIPT" --state "$STATE" observe --run "$RUN" --input /absolute/path/observation.json
```

输出 `candidates`、`notifications`、`complete`。首次完整观察在提醒模式下仅建立基线，现有作品不算新增；自动取消模式仍会给出全部已观察且未保留的候选，最多 5 条。

完成网页取消、看到未推荐状态、回本人页完整复核后，再次 `observe`，然后：

```sh
python3 "$SCRIPT" --state "$STATE" confirm --run "$RUN" --id 111 --control-state unrecommended
```

每次点击前先 `plan --run "$RUN"` 检查当前候选与租约。如果上一条取消导致页面变化，下一条重新定位。`confirm` 会拒绝非候选作品、仍在列表的作品、不完整复核、过期计划及其他账号。

通知成功送达后，用 `notifications` 中的事件 ID 标记；未确认发送成功则不要执行：

```sh
python3 "$SCRIPT" --state "$STATE" ack --run "$RUN" --events 1,2
python3 "$SCRIPT" --state "$STATE" finish --run "$RUN"
# 本轮失败时：
python3 "$SCRIPT" --state "$STATE" finish --run "$RUN" --error '需要用户接管安全验证'
```

`configure` 会使正在执行的 run 失效；下一次操作应停止并重新读取配置。新建文件不代表定时任务已创建；`paused` 只是本地执行保护，仍需同步更新宿主实际调度。通知采用确认后移除的方式，发送后崩溃可能导致重复提醒。
