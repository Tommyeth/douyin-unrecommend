#!/usr/bin/env python3
"""Private bookkeeping for a browser-operated workflow. No network/browser access."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import sys
import tempfile
import time


def require(condition, message):
    if not condition:
        raise ValueError(message)


def account(value):
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", value), "抖音号无效")
    return value


def ids(values):
    require(isinstance(values, list) and all(isinstance(v, str) and re.fullmatch(r"\d{1,40}", v) for v in values), "作品 ID 必须是数字字符串")
    return list(dict.fromkeys(values))


def snapshot(value, owner):
    require(isinstance(value, dict) and value.get("account") == owner, "观察账号与绑定账号不同")
    require(type(value.get("complete")) is bool, "必须明确 complete")
    videos = value.get("videos")
    require(isinstance(videos, list) and len(videos) <= 10000, "作品列表无效或超过上限")
    normalized = {}
    for video in videos:
        require(isinstance(video, dict), "作品格式无效")
        ident = ids([video.get("id")])[0]
        url = video.get("url")
        require(url in [f"https://www.douyin.com/video/{ident}", f"https://www.douyin.com/note/{ident}"], "作品链接与 ID 不匹配")
        require(ident not in normalized, "观察列表含重复 ID，请先合并滚动结果")
        title = video.get("title", "")
        require(isinstance(title, str), "标题格式无效")
        normalized[ident] = {"id": ident, "url": url, "title": title[:300]}
    if value["complete"]:
        reason = value.get("end_reason")
        require(reason in ["empty", "end_marker", "count_matched"], "完整读取需要结束证据")
        if reason == "empty":
            require(not normalized, "空列表证据与内容矛盾")
        if reason == "count_matched":
            require(type(value.get("total")) is int and value["total"] == len(normalized), "总数与唯一作品数不符")
    return normalized


def current_run(state, token, now):
    run = state.get("run")
    require(run and run["id"] == token, "本轮已失效，请重新读取状态")
    require(not state["paused"] and now < run["expires_at"], "本轮已暂停或到期，请停止点击")
    return run


def plan(state, run):
    return {
        "run": run["id"], "expires_at": run["expires_at"], "mode": state["mode"],
        "complete": run.get("complete", False),
        "candidates": [v for key, v in run.get("allowed", {}).items()
                       if run.get("complete") and key in run.get("observed", {})
                       and key not in run["cancelled"] and key not in state["keep"]]
                      if state["mode"] == "auto_cancel" else [],
        "notifications": state["pending"] if state["mode"] == "notify" else [],
        "confirmed_cancelled": run["cancelled"],
    }


def transition(state, operation, payload, now):
    if operation == "init":
        require(state is None, "已有状态，不允许覆盖或静默换绑")
        mode = payload.get("mode", "notify")
        require(mode in ["notify", "auto_cancel"], "模式无效")
        state = {"version": 1, "account": account(payload["account"]), "mode": mode,
                 "paused": False, "keep": [], "baseline": False, "present": {},
                 "pending": [], "sequence": 0, "run": None, "last_run": None}
        return state, {"initialized": True, "account": state["account"], "mode": mode}
    require(state is not None and state.get("version") == 1, "没有有效状态，请先初始化并确认账号")
    if operation == "status":
        return state, {key: state[key] for key in ["account", "mode", "paused", "keep", "baseline", "run", "last_run"]} | {"pending_count": len(state["pending"])}
    if operation == "configure":
        if payload.get("mode") is not None:
            require(payload["mode"] in ["notify", "auto_cancel"], "模式无效")
            state["mode"] = payload["mode"]
        if payload.get("paused") is not None:
            require(type(payload["paused"]) is bool, "paused 必须是布尔值")
            state["paused"] = payload["paused"]
        if payload.get("keep") is not None:
            state["keep"] = ids(payload["keep"])
        state["run"] = None
        return state, {"mode": state["mode"], "paused": state["paused"], "keep": state["keep"], "schedule_changed": False}
    if operation == "begin":
        require(payload["account"] == state["account"], "账号与绑定账号不同，停止操作")
        require(not state["paused"], "任务已暂停")
        require(not state["run"] or state["run"]["expires_at"] <= now, "已有任务执行中，不重复启动")
        state["run"] = {"id": secrets.token_hex(16), "expires_at": now + 600,
                        "observations": 0, "allowed": {}, "planned": False, "cancelled": []}
        return state, plan(state, state["run"])
    # A failed or expired run may still release its own lease, but never a newer one.
    if operation == "finish":
        run = state["run"]
        require(run and run["id"] == payload["run"], "不能结束其他任务")
        state["last_run"] = {"at": now, "complete": run.get("complete", False),
                             "observed_at": run.get("observed_at"),
                             "observed_count": len(run.get("observed", {})),
                             "confirmed_cancelled": run["cancelled"],
                             "error": str(payload.get("error") or "")[:200]}
        state["run"] = None
        return state, state["last_run"]
    run = current_run(state, payload["run"], now)
    if operation == "plan":
        return state, plan(state, run)
    if operation == "observe":
        observation = payload["snapshot"]
        found = snapshot(observation, state["account"])
        complete = observation["complete"]
        run["observations"] += 1
        run["observed_at"] = now
        run["observed"] = found
        run["complete"] = complete
        if state["baseline"]:
            for key, video in found.items():
                if key not in state["present"] and state["mode"] == "notify":
                    require(len(state["pending"]) < 10000, "待提醒记录过多，请先处理")
                    state["sequence"] += 1
                    state["pending"].append({"event": state["sequence"], "video": video})
        if complete:
            state["baseline"] = True
            state["present"] = found.copy()
        elif state["baseline"]:
            state["present"].update(found)
        if complete and not run["planned"]:
            run["planned"] = True
            run["plan_observation"] = run["observations"]
            run["allowed"] = dict(list((key, v) for key, v in found.items() if key not in state["keep"])[:5]) if state["mode"] == "auto_cancel" else {}
        return state, plan(state, run)
    if operation == "confirm":
        ident = payload["id"]
        require(state["mode"] == "auto_cancel" and ident in run["allowed"] and ident not in state["keep"], "作品不在本轮取消计划内")
        require(payload.get("control_state") == "unrecommended", "尚未观察到未推荐状态")
        require(run.get("complete") and run["observations"] > run["plan_observation"] and ident not in run["observed"], "取消后未完成完整列表复核")
        if ident not in run["cancelled"]:
            run["cancelled"].append(ident)
        return state, {"confirmed": ident, "confirmed_cancelled": run["cancelled"]}
    if operation == "ack":
        events = payload["events"]
        require(state["mode"] == "notify" and all(type(v) is int for v in events), "提醒事件无效")
        require(set(events).issubset({p["event"] for p in state["pending"]}), "含不存在的提醒事件")
        state["pending"] = [p for p in state["pending"] if p["event"] not in events]
        return state, {"pending_count": len(state["pending"])}
    raise ValueError("未知命令")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", required=True)
    commands = parser.add_subparsers(dest="operation", required=True)
    for name in ["init", "status", "configure", "begin", "plan", "observe", "confirm", "ack", "finish"]:
        sub = commands.add_parser(name)
        if name in ["init", "begin"]:
            sub.add_argument("--account", required=True)
        if name in ["init", "configure"]:
            sub.add_argument("--mode", choices=["notify", "auto_cancel"], default="notify" if name == "init" else None)
        if name == "configure":
            sub.add_argument("--keep")
            sub.add_argument("--paused", choices=["true", "false"])
        if name in ["plan", "observe", "confirm", "ack", "finish"]:
            sub.add_argument("--run", required=True)
        if name == "observe":
            sub.add_argument("--input", required=True)
        if name == "confirm":
            sub.add_argument("--id", required=True)
            sub.add_argument("--control-state", required=True, choices=["unrecommended"])
        if name == "ack":
            sub.add_argument("--events", required=True)
        if name == "finish":
            sub.add_argument("--error")
    args = vars(parser.parse_args())
    path = Path(args.pop("state")).expanduser().absolute()
    operation = args.pop("operation")
    if args.get("keep") is not None:
        args["keep"] = args["keep"].split(",") if args["keep"] else []
    if args.get("paused") is not None:
        args["paused"] = args["paused"] == "true"
    if "events" in args:
        args["events"] = [int(v) for v in args["events"].split(",")]
    if "input" in args:
        args["snapshot"] = json.loads(Path(args.pop("input")).read_text())
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = path.with_name(path.name + ".lock")
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise ValueError("状态写锁忙；若进程崩溃，确认没有任务后再移除 .lock 文件") from None
    temporary = None
    try:
        os.close(fd)
        require(not path.is_symlink(), "状态路径不能是符号链接")
        state = json.loads(path.read_text()) if path.exists() else None
        state, result = transition(state, operation, args, int(time.time()))
        if operation not in ["status", "plan"]:
            fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".douyin-state-")
            with os.fdopen(fd, "w") as output:
                json.dump(state, output, ensure_ascii=False)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, path)
        print(json.dumps(result, ensure_ascii=False))
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
        lock.unlink()


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
