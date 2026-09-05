"""Codex lifecycle adapter. No network, model calls, or business-file writes."""
import argparse
import hashlib
import json
import msvcrt
import os
from pathlib import Path
import sys
import time
from contextlib import contextmanager

INTERVAL = 3
SKILL = Path(__file__).resolve().parents[1] / "SKILL.md"


@contextmanager
def locked(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        deadline = time.monotonic() + 2
        while True:
            try:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("state lock timed out")
                time.sleep(0.025)
        try:
            yield
        finally:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


def is_subagent(event):
    if event.get("agent_id") or event.get("agent_transcript_path"):
        return True
    # Read only the supplied transcript's metadata, never its conversation body.
    transcript = event.get("transcript_path")
    if transcript:
        try:
            with Path(transcript).open(encoding="utf-8-sig") as handle:
                record = json.loads(handle.readline(65536))
            if record.get("type") == "session_meta":
                meta = record.get("payload", {})
                source = meta.get("source")
                return (meta.get("id") != event.get("session_id") or
                        (isinstance(source, dict) and "subagent" in source))
        except (OSError, ValueError):
            pass  # Metadata is optional; lifecycle fields remain authoritative.
    return False


def process(event, root, action="hook", response=None, reason=None):
    session = event.get("session_id")
    if not isinstance(session, str) or not session or len(session) > 256:
        raise ValueError("missing or invalid session_id")
    name = event.get("hook_event_name")
    if action == "hook":
        if name not in {"PostCompact", "SessionStart", "UserPromptSubmit"}:
            return {}
        if is_subagent(event):
            return {}
        if name == "PostCompact" and event.get("trigger") != "auto":
            return {}
    key = hashlib.sha256(session.encode()).hexdigest()
    path = root / (key + ".json")
    with locked(root / (key + ".lock")):
        exists = path.exists()
        state = json.loads(path.read_text(encoding="utf-8")) if exists else {
            "schema": 1, "session_id": session, "auto_count": 0,
            "next_reminder_at": INTERVAL, "muted": False,
            "last_notified_at": None, "last_reason": None,
            "response": None, "coverage": "observed_since_hook_enabled",
        }
        if (state.get("schema") != 1 or state.get("session_id") != session or
                type(state.get("auto_count")) is not int or state["auto_count"] < 0 or
                type(state.get("next_reminder_at")) is not int or
                state["next_reminder_at"] < INTERVAL or
                type(state.get("muted")) is not bool):
            raise ValueError("invalid state; original file preserved")
        changed = False
        if action == "hook" and name == "PostCompact":
            # One callback per successful automatic compaction. Do not deduplicate
            # by turn_id: a single turn can legitimately compact several times.
            state["auto_count"] += 1
            changed = True
        elif action == "notified":
            if reason not in {"count", "confusion", "stage"}:
                raise ValueError("notified requires a reason")
            state["last_notified_at"] = state["auto_count"]
            state["last_reason"] = reason
            state["next_reminder_at"] = state["auto_count"] + INTERVAL
            state["response"] = "pending"
            changed = True
        elif action == "respond":
            if response not in {"continue", "mute", "handoff"}:
                raise ValueError("invalid response")
            state["response"] = response
            if response in {"mute", "handoff"}:
                state["muted"] = True
            else:
                state["next_reminder_at"] = max(
                    state["next_reminder_at"], state["auto_count"] + INTERVAL)
            changed = True
        elif action not in {"hook", "status"}:
            raise ValueError("invalid action")
        if changed:
            state["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            temp = path.with_suffix(".tmp")
            temp.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n",
                            encoding="utf-8")
            os.replace(temp, path)
        if action != "hook":
            return state
        # PostCompact cannot inject model context. SessionStart(compact) does.
        if name == "PostCompact" or not exists:
            return {}
        count = state["auto_count"]
        if count == 0:
            return {}
        base = (f"project-handoff 状态：本任务启用计数后观察到 {count} 次自动压缩；"
                "旧压缩次数未知，不回填猜测值。")
        if state["muted"]:
            context = base + "本任务主动提醒已关闭；用户显式要求交接时仍执行。"
        elif count < state["next_reminder_at"]:
            context = base + (f"次数提醒冷却至第 {state['next_reminder_at']} 次。"
                              "继续已授权工作，不因次数打断；新的已核实混淆仍可提前提醒。")
        else:
            context = base + (
                f"已到次数提醒点。读取 {SKILL} 的提醒规则，在最近一次进度汇报中"
                "提醒交接一次；先收拢当前操作，不要求额外证明切换收益，也不等待新的大阶段。"
                "若任务已完成且无后续，或当前只讨论/修改本 Skill，则不提示交接。"
                "先核对最近回应：用户已拒绝、要求继续或已收到本次提醒时，按 Skill 记录并冷却。"
                "提醒不授权保存或新建，不停止工作。只有提醒已实际发出才记录 notified；"
                "本提示注入不等于提醒已送达。")
        return {"hookSpecificOutput": {"hookEventName": name,
                                       "additionalContext": context}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--action", choices=["hook", "status", "notified", "respond"],
                        default="hook")
    parser.add_argument("--session-id")
    parser.add_argument("--response", choices=["continue", "mute", "handoff"])
    parser.add_argument("--reason", choices=["count", "confusion", "stage"])
    args = parser.parse_args()
    try:
        event = (json.load(sys.stdin) if args.action == "hook"
                 else {"session_id": args.session_id})
        result = process(event, args.state_dir, args.action, args.response, args.reason)
        if result:
            print(json.dumps(result, ensure_ascii=False))
        return 0
    except (OSError, ValueError, TypeError, KeyError) as error:
        # Preserve corrupt state and continue work; make tracking failure visible.
        if args.action == "hook":
            print(json.dumps({"systemMessage":
                f"project-handoff 计数不可用（{type(error).__name__}）；未重置计数，任务继续。"},
                ensure_ascii=False))
            return 0
        print(f"project-handoff: {type(error).__name__}; state preserved", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
    raise SystemExit(main())
