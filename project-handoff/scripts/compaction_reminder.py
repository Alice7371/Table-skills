"""Codex lifecycle adapter. No network, model calls, or business-file writes."""
import argparse
import hashlib
import json
import msvcrt
import os
from pathlib import Path
import re
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


def state_path(root, session):
    return root / (hashlib.sha256(session.encode()).hexdigest() + ".json")


def read_state(path, session):
    state = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {
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
    # Additive extension: old adapters can still read the original fields.
    # A legacy receipt contains a compaction index, not a notification total.
    if "tracking_version" not in state:
        state.update(tracking_version=2,
                     reminder_count=0 if state["last_notified_at"] is None else None,
                     tracked_reminder_count=0, stage_keys=[], confusion_keys=[],
                     proposal=None, defer_until=None, last_response_turn_id=None,
                     active_turn_id=None)
    if (state.get("tracking_version") != 2 or
            type(state.get("tracked_reminder_count")) is not int or
            state["tracked_reminder_count"] < 0 or
            (state.get("reminder_count") is not None and
             (type(state["reminder_count"]) is not int or state["reminder_count"] < 0)) or
            not isinstance(state.get("stage_keys"), list) or
            not isinstance(state.get("confusion_keys"), list) or
            (state.get("proposal") is not None and not isinstance(state["proposal"], dict))):
        raise ValueError("invalid tracking fields; original file preserved")
    return state


def key_arg(value, label):
    if not isinstance(value, str) or not value.strip() or len(value) > 160:
        raise ValueError(f"missing or invalid {label}")
    return value.strip()


def prepare(state, event, reason, opts):
    turn = key_arg(event.get("turn_id"), "turn_id")
    if state.get("active_turn_id") and turn != state["active_turn_id"]:
        raise ValueError("turn_id differs from the current host event")
    stage = key_arg(opts.get("stage_key"), "stage_key")
    notice = opts.get("notice", "").strip()
    if not notice.startswith("交接建议：") or not 20 <= len(notice) <= 600 or "\n" in notice:
        raise ValueError("notice must be one bounded handoff suggestion paragraph")
    if reason not in {"count", "stage", "confusion", "checkpoint"}:
        raise ValueError("invalid reminder reason")
    if state["muted"] or not opts.get("safe") or not opts.get("has_next"):
        return {"prepared": False, "why": "muted_or_not_ready"}
    old = state["proposal"]
    # Re-arm an interrupted/missed delivery, keeping the same ID and count.
    if (old and not old["closed"] and not old["final_delivered"] and
            old["stage_key"] == stage and old["reason"] == reason and
            old["cause_key"] == opts.get("cause_key")):
        old.update(turn_id=turn, notice=notice)
        return {"prepared": True, "proposal": old}
    if state["defer_until"] and reason not in {"checkpoint", "confusion"}:
        return {"prepared": False, "why": "waiting_for_user_checkpoint"}
    cause = opts.get("cause_key")
    if reason == "confusion":
        cause = key_arg(cause, "cause_key")
        if cause in state["confusion_keys"] or not opts.get("benefit"):
            return {"prepared": False, "why": "same_confusion_or_no_benefit"}
    elif reason == "checkpoint":
        if not state["defer_until"] or opts.get("checkpoint_key") != state["defer_until"]:
            return {"prepared": False, "why": "checkpoint_not_matched"}
    else:
        has_prior = state["last_notified_at"] is not None or bool(state["stage_keys"])
        if stage in state["stage_keys"]:
            return {"prepared": False, "why": "same_work_stage"}
        if reason == "count":
            if (has_prior or
                    state["auto_count"] < state["next_reminder_at"]):
                return {"prepared": False, "why": "count_only_is_first_reminder"}
        elif not opts.get("benefit"):
            return {"prepared": False, "why": "no_switching_benefit"}
        if (has_prior and
                state["auto_count"] < state["next_reminder_at"]):
            return {"prepared": False, "why": "cooldown"}
    identity = json.dumps([state["session_id"], turn, reason, stage, cause], ensure_ascii=False)
    proposal = {"id": hashlib.sha256(identity.encode()).hexdigest()[:24],
                "turn_id": turn, "reason": reason, "stage_key": stage,
                "cause_key": cause, "notice": notice, "counted": False,
                "commentary_delivered": False, "final_delivered": False,
                "retry_used": False, "final_missed": False, "closed": False}
    state.update(proposal=proposal, response="pending")
    if reason == "checkpoint":
        state["defer_until"] = None
    return {"prepared": True, "proposal": proposal}


def receipt(state, proposal, channel):
    if proposal["closed"]:
        raise ValueError("proposal already closed")
    proposal[channel + "_delivered"] = True
    if not proposal["counted"]:
        proposal["counted"] = True
        state["tracked_reminder_count"] += 1
        if state["reminder_count"] is not None:
            state["reminder_count"] += 1
        state["last_notified_at"] = state["auto_count"]
        state["last_reason"] = proposal["reason"]
        state["next_reminder_at"] = max(state["next_reminder_at"], state["auto_count"] + INTERVAL)
        if proposal["stage_key"] not in state["stage_keys"]:
            state["stage_keys"].append(proposal["stage_key"])
        if proposal["reason"] == "confusion":
            state["confusion_keys"].append(proposal["cause_key"])


def respond(state, event, response, opts):
    turn = key_arg(event.get("turn_id"), "response turn_id")
    if response not in {"continue", "defer", "mute", "handoff", "resume"}:
        raise ValueError("invalid response")
    if state["last_response_turn_id"] == turn:
        return  # Re-reading the same response must not slide the cooldown.
    proposal = state["proposal"]
    if response not in {"mute", "resume"}:
        if not proposal or opts.get("proposal_id") != proposal["id"] or proposal["closed"]:
            raise ValueError("response must identify the current open proposal")
    if response == "defer":
        state["defer_until"] = key_arg(opts.get("checkpoint_key"), "checkpoint_key")
    elif response != "resume":
        state["defer_until"] = None
    state["last_response_turn_id"] = turn
    state["response"] = response
    if response in {"mute", "handoff"}:
        state["muted"] = True
    elif response == "resume":
        state["muted"] = False
    else:
        state["next_reminder_at"] = max(state["next_reminder_at"], state["auto_count"] + INTERVAL)
    if proposal:
        proposal["closed"] = True
        if proposal["stage_key"] not in state["stage_keys"]:
            state["stage_keys"].append(proposal["stage_key"])


def final_contains_notice(message, notice):
    if not isinstance(message, str):
        return False
    # Only inspect the host-supplied final text, excluding quoted/code examples.
    message = message.split("<oai-mem-citation>", 1)[0]
    lines, fenced = [], False
    for line in message.splitlines():
        if line.lstrip().startswith(("```", "~~~")):
            fenced = not fenced
        elif not fenced and not line.lstrip().startswith(">"):
            lines.append(line)
    normalize = lambda value: re.sub(r"[\s*`_]", "", value)
    return any(normalize(p) == normalize(notice)
               for p in re.split(r"\n\s*\n", "\n".join(lines)))


def check_stop(state, event):
    proposal = state["proposal"]
    if (state["muted"] or not proposal or proposal["closed"] or
            proposal["final_delivered"] or event.get("turn_id") != proposal["turn_id"]):
        return {}
    if final_contains_notice(event.get("last_assistant_message"), proposal["notice"]):
        receipt(state, proposal, "final")
        proposal["final_missed"] = False
        return {}
    if proposal["final_missed"]:
        return {}
    if not proposal["retry_used"] and not event.get("stop_hook_active"):
        proposal["retry_used"] = True
        return {"decision": "block", "reason": (
            "本轮已准备的交接建议漏出最终答复。保留本轮成果答复，在末尾补上下面这一段；"
            "只补答复，不重做工作、不保存交接材料、不新建任务。本次补写最多一次：\n"
            + proposal["notice"])}
    proposal["final_missed"] = True
    return {"systemMessage": "project-handoff：最终提醒仍未核验到，本轮不再自动补写；未虚报最终送达。"}


def context_output(state, name):
    count = state["auto_count"]
    if count == 0 and not state["proposal"] and not state["muted"]:
        return {}
    total = (str(state["reminder_count"]) + "次" if state["reminder_count"] is not None else
             f"历史总数未知，新版已核验{state['tracked_reminder_count']}次")
    base = f"project-handoff：自动压缩{count}次；实际提醒{total}；"
    if state.get("active_turn_id"):
        base += f"当前turn_id={state['active_turn_id']}；"
    if state["last_notified_at"] is not None:
        base += f"上次提醒发生于第{state['last_notified_at']}次压缩。"
    if state["muted"]:
        context = "本任务主动提醒已关闭；显式交接或恢复提醒请求仍执行。"
    elif state["proposal"] and not state["proposal"]["closed"] and not state["proposal"]["final_delivered"]:
        context = ("存在尚未核验最终送达的建议。先核对用户最新回应；本轮仍需展示才按原阶段重新prepare，"
                   "并在最终答复保留notice原段，不因进度消息已发而遗漏；不得每轮追问。")
    elif state["defer_until"]:
        context = f"等待用户指定节点{state['defer_until']}；到节点再评估，普通阶段和次数不催促。"
    elif count < state["next_reminder_at"]:
        context = f"冷却至第{state['next_reminder_at']}次压缩；新阶段不越过冷却。"
    elif state["last_notified_at"] is None and not state["stage_keys"]:
        context = "首次次数提醒已到点：收拢操作、有明确后续时准备建议，并保留在本轮最终答复。"
    else:
        context = "冷却已解除，仅在新的实质阶段且有具体切换收益时再提醒；不能仅因次数提醒。"
    context += (f"执行前读取{SKILL}及references/compaction-reminder.md。"
                "新且已核实的混淆先纠正，可提前提醒；同一问题去重，静默优先。"
                "纯问答、无后续或讨论/修改本Skill不提醒。注入不算送达，普通继续不算交接批准。")
    return {"hookSpecificOutput": {"hookEventName": name, "additionalContext": base + context}}


def process(event, root, action="hook", response=None, reason=None, **opts):
    session = event.get("session_id")
    if not isinstance(session, str) or not session or len(session) > 256:
        raise ValueError("missing or invalid session_id")
    name = event.get("hook_event_name")
    if action == "hook":
        if name not in {"PostCompact", "SessionStart", "UserPromptSubmit", "Stop"}:
            return {}
        if is_subagent(event):
            return {}
        if name == "PostCompact" and event.get("trigger") != "auto":
            return {}
    path = state_path(root, session)
    if action == "status":
        return read_state(path, session)  # No mkdir, lock file, migration or write.
    if action == "hook" and name != "PostCompact" and not path.exists():
        return {}
    with locked(path.with_suffix(".lock")):
        state = read_state(path, session)
        before = json.dumps(state, sort_keys=True, ensure_ascii=False)
        result = None
        if action == "hook" and name != "Stop" and event.get("turn_id"):
            state["active_turn_id"] = key_arg(event["turn_id"], "turn_id")
        if action == "hook" and name == "PostCompact":
            # One callback per successful automatic compaction. Do not deduplicate
            # by turn_id: a single turn can legitimately compact several times.
            state["auto_count"] += 1
        elif action == "prepare":
            result = prepare(state, event, reason, opts)
        elif action == "notified":
            proposal = state["proposal"]
            if not proposal or opts.get("proposal_id") != proposal["id"]:
                raise ValueError("notified requires a prepared proposal ID")
            channel = opts.get("channel")
            if channel not in {"commentary", "final"}:
                raise ValueError("receipt requires an explicit delivery channel")
            if event.get("turn_id") != proposal["turn_id"]:
                raise ValueError("receipt must identify the original delivery turn")
            if channel == "final" and (not state.get("active_turn_id") or
                                       event["turn_id"] == state["active_turn_id"]):
                raise ValueError("manual final receipt is only allowed on a later verified turn")
            receipt(state, proposal, channel)
        elif action == "cancel":
            proposal = state["proposal"]
            if not proposal or opts.get("proposal_id") != proposal["id"]:
                raise ValueError("cancel requires the current proposal ID")
            proposal["closed"] = True
            state["response"] = "cancelled"
        elif action == "respond":
            respond(state, event, response, opts)
        elif action == "hook" and name == "Stop":
            result = check_stop(state, event)
        elif action != "hook":
            raise ValueError("invalid action")
        if json.dumps(state, sort_keys=True, ensure_ascii=False) != before:
            state["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            temp = path.with_suffix(".tmp")
            temp.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n",
                            encoding="utf-8")
            os.replace(temp, path)
        if action != "hook":
            return result if result is not None else state
        if name == "Stop":
            return result
        if name == "PostCompact":
            return {}
        return context_output(state, name)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--action", choices=["hook", "status", "prepare", "notified", "respond", "cancel"],
                        default="hook")
    parser.add_argument("--session-id")
    parser.add_argument("--turn-id")
    parser.add_argument("--response", choices=["continue", "defer", "mute", "handoff", "resume"])
    parser.add_argument("--reason", choices=["count", "confusion", "stage", "checkpoint"])
    parser.add_argument("--stage-key")
    parser.add_argument("--cause-key")
    parser.add_argument("--checkpoint-key")
    parser.add_argument("--proposal-id")
    parser.add_argument("--channel", choices=["commentary", "final"])
    parser.add_argument("--notice")
    parser.add_argument("--safe", action="store_true")
    parser.add_argument("--has-next", action="store_true")
    parser.add_argument("--benefit", action="store_true")
    args = parser.parse_args()
    try:
        event = (json.load(sys.stdin) if args.action == "hook"
                 else {"session_id": args.session_id, "turn_id": args.turn_id})
        options = {k: v for k, v in vars(args).items()
                   if k not in {"session_id", "turn_id", "state_dir", "action", "response", "reason"}}
        result = process(event, args.state_dir, args.action, args.response, args.reason, **options)
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
