"""Behavioral checks in retained, isolated fixtures. No live session writes."""
import importlib.util
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time
import unittest
import uuid

REPO = Path(__file__).resolve().parents[1]
QA = REPO / ".test-output" / "project-handoff"
QA.mkdir(parents=True, exist_ok=True)
SCRIPT = REPO / "project-handoff" / "scripts" / "compaction_reminder.py"
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("reminder", SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
RUN = QA / "fixtures" / uuid.uuid4().hex
NOTICE = "交接建议：设计已经确认，后续进入样片；确认后保存材料，在同一项目新建并打开任务接续。"


class ReminderTests(unittest.TestCase):
    def setUp(self):
        # Keep fixtures below the legacy Windows path limit in nested checkouts.
        self.root = RUN / hashlib.sha256(self._testMethodName.encode()).hexdigest()[:12]
        self.sid = "main-session"
        self.turn = "turn-a"

    def event(self, name, **extra):
        return dict(session_id=self.sid, turn_id=self.turn, hook_event_name=name, **extra)

    def hook(self, name, **extra):
        return m.process(self.event(name, **extra), self.root)

    def compact(self, n=1):
        for _ in range(n):
            self.hook("PostCompact", trigger="auto")

    def status(self):
        return m.process(self.event(""), self.root, "status")

    def prep(self, reason="count", stage="design", **kw):
        args = dict(stage_key=stage, safe=True, has_next=True, notice=NOTICE)
        args.update(kw)
        return m.process(self.event(""), self.root, "prepare", reason=reason, **args)

    def pid(self):
        return self.status()["proposal"]["id"]

    def shown(self, channel="commentary", original_turn=None):
        event = dict(session_id=self.sid, turn_id=original_turn or self.turn)
        return m.process(event, self.root, "notified", proposal_id=self.pid(), channel=channel)

    def reply(self, value, turn="response-a", **kw):
        args = dict(proposal_id=self.pid(), **kw)
        return m.process(dict(session_id=self.sid, turn_id=turn), self.root,
                         "respond", response=value, **args)

    def delivered(self):
        self.compact(3)
        self.assertTrue(self.prep()["prepared"])
        self.hook("Stop", last_assistant_message="已完成交付。\n\n" + NOTICE)

    def test_status_is_readonly_even_for_missing_state(self):
        self.assertEqual(self.status()["auto_count"], 0)
        self.assertFalse(self.root.exists())

    def test_initial_threshold_and_prepare_not_delivery(self):
        self.compact(2)
        self.assertFalse(self.prep()["prepared"])
        self.compact()
        self.assertTrue(self.prep()["prepared"])
        self.assertEqual(self.status()["reminder_count"], 0)

    def test_manual_resume_and_prompt_never_increment(self):
        self.compact()
        for _ in range(3):
            self.hook("PostCompact", trigger="manual")
            self.hook("SessionStart", source="resume")
            self.hook("UserPromptSubmit", prompt="继续，压缩")
        self.assertEqual(self.status()["auto_count"], 1)

    def test_many_compactions_in_one_turn_are_distinct(self):
        self.compact(6)
        self.assertEqual(self.status()["auto_count"], 6)

    def test_no_proposal_means_stop_has_no_effect(self):
        self.compact(9)
        self.assertEqual(self.hook("Stop", last_assistant_message="普通任务已完成"), {})
        self.assertEqual(self.status()["reminder_count"], 0)

    def test_unsafe_or_finished_work_cannot_prepare(self):
        self.compact(3)
        self.assertFalse(self.prep(safe=False)["prepared"])
        self.assertFalse(self.prep(has_next=False)["prepared"])

    def test_host_turn_identity_cannot_be_guessed(self):
        self.compact(3)
        self.turn = "wrong-turn"
        with self.assertRaises(ValueError):
            self.prep()

    def test_commentary_and_final_count_once_and_keep_cooldown(self):
        self.compact(3)
        self.prep()
        self.shown()
        self.compact()
        self.hook("Stop", last_assistant_message="成果如下。\n\n**" + NOTICE + "**")
        s = self.status()
        self.assertEqual((s["reminder_count"], s["last_notified_at"], s["next_reminder_at"]), (1, 3, 6))
        self.assertTrue(s["proposal"]["final_delivered"])

    def test_final_only_counts_after_stop_evidence(self):
        self.compact(3)
        self.prep()
        self.assertEqual(self.status()["reminder_count"], 0)
        self.hook("Stop", last_assistant_message=NOTICE)
        self.assertEqual(self.status()["reminder_count"], 1)

    def test_cannot_premark_final_in_current_turn(self):
        self.compact(3)
        self.prep()
        with self.assertRaises(ValueError):
            self.shown("final")
        self.assertEqual(self.status()["reminder_count"], 0)

    def test_next_turn_manual_receipt_and_stop_are_idempotent(self):
        self.compact(3)
        self.prep()
        self.turn = "turn-b"
        self.hook("UserPromptSubmit", prompt="后续工作")
        self.shown("final", "turn-a")
        self.shown("final", "turn-a")
        self.assertEqual(self.status()["reminder_count"], 1)

    def test_missing_final_repairs_once_then_records_failure(self):
        self.compact(3)
        self.prep()
        first = self.hook("Stop", last_assistant_message="已完成")
        self.assertEqual(first["decision"], "block")
        second = self.hook("Stop", last_assistant_message="还是漏了", stop_hook_active=True)
        self.assertIn("systemMessage", second)
        self.assertEqual(self.hook("Stop", last_assistant_message="还是漏了"), {})
        self.assertEqual(self.status()["reminder_count"], 0)
        self.assertTrue(self.status()["proposal"]["final_missed"])

    def test_repair_success_counts_once(self):
        self.compact(3)
        self.prep()
        self.hook("Stop", last_assistant_message="已完成")
        self.hook("Stop", last_assistant_message="已完成\n\n" + NOTICE, stop_hook_active=True)
        self.hook("Stop", last_assistant_message=NOTICE)
        self.assertEqual(self.status()["reminder_count"], 1)

    def test_other_stop_hook_continuation_does_not_start_a_retry_loop(self):
        self.compact(3)
        self.prep()
        self.assertNotIn("decision", self.hook("Stop", last_assistant_message="结果", stop_hook_active=True))

    def test_stale_turn_cannot_check_or_repeat_previous_notice(self):
        self.compact(3)
        self.prep()
        self.turn = "unrelated-turn"
        self.assertEqual(self.hook("Stop", last_assistant_message="普通答复"), {})
        self.assertFalse(self.status()["proposal"]["retry_used"])

    def test_examples_are_not_delivery(self):
        for text in ("> " + NOTICE, "```text\n" + NOTICE + "\n```", "示例：" + NOTICE):
            self.assertFalse(m.final_contains_notice(text, NOTICE))
        self.assertTrue(m.final_contains_notice("结果\n\n" + NOTICE + "\n\n<oai-mem-citation>meta", NOTICE))

    def test_cooldown_alone_does_not_trigger_repeat(self):
        self.delivered()
        self.compact(30)
        self.assertFalse(self.prep(reason="count", stage="full")["prepared"])
        self.assertFalse(self.prep(reason="stage", stage="full")["prepared"])

    def test_new_stage_cannot_bypass_cooldown(self):
        self.delivered()
        self.compact(2)
        self.assertFalse(self.prep(reason="stage", stage="sample", benefit=True)["prepared"])
        self.compact()
        self.assertTrue(self.prep(reason="stage", stage="sample", benefit=True)["prepared"])

    def test_same_stage_versions_and_revisit_are_deduplicated(self):
        self.delivered()
        self.compact(3)
        self.assertFalse(self.prep(reason="stage", stage="design", benefit=True)["prepared"])
        self.prep(reason="stage", stage="sample", benefit=True)
        self.shown()
        self.hook("Stop", last_assistant_message=NOTICE)
        self.compact(3)
        self.assertFalse(self.prep(reason="stage", stage="design", benefit=True)["prepared"])

    def test_user_continue_cools_from_response_and_is_not_approval(self):
        self.delivered()
        self.compact(2)
        self.reply("continue")
        s = self.status()
        self.assertEqual(s["next_reminder_at"], 8)
        self.assertFalse(s["muted"])
        self.assertEqual(s["response"], "continue")
        self.compact(2)
        self.reply("continue")
        self.assertEqual(self.status()["next_reminder_at"], 8)

    def test_continue_before_receipt_still_suppresses_first_count_route(self):
        self.compact(3)
        self.prep()
        self.reply("continue")
        self.compact(3)
        self.assertFalse(self.prep(reason="count", stage="sample")["prepared"])
        self.assertTrue(self.prep(reason="stage", stage="sample", benefit=True)["prepared"])

    def test_independent_hook_processes_do_not_lose_increments(self):
        from concurrent.futures import ThreadPoolExecutor
        command = [sys.executable, "-X", "utf8", str(SCRIPT), "--state-dir", str(self.root)]
        event = json.dumps(self.event("PostCompact", trigger="auto"))
        def invoke(_):
            return subprocess.run(command, input=event, text=True, encoding="utf-8",
                                  capture_output=True, timeout=8)
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(invoke, range(12)))
        self.assertTrue(all(r.returncode == 0 and not r.stdout.strip() for r in results))
        self.assertEqual(self.status()["auto_count"], 12)

    def test_ordinary_continue_prompt_is_not_a_response(self):
        self.delivered()
        self.turn = "turn-next"
        self.hook("UserPromptSubmit", prompt="同意修改这个 Skill，继续")
        self.assertEqual(self.status()["response"], "pending")
        self.assertFalse(self.status()["muted"])

    def test_wrong_proposal_response_preserves_state(self):
        self.delivered()
        before = m.state_path(self.root, self.sid).read_bytes()
        with self.assertRaises(ValueError):
            m.process(dict(session_id=self.sid, turn_id="response-b"), self.root,
                      "respond", response="continue", proposal_id="wrong")
        self.assertEqual(before, m.state_path(self.root, self.sid).read_bytes())

    def test_defer_until_checkpoint_ignores_count_and_other_stages(self):
        self.delivered()
        self.reply("defer", checkpoint_key="sample-ready")
        self.compact(30)
        self.assertFalse(self.prep(reason="stage", stage="full", benefit=True)["prepared"])
        self.assertFalse(self.prep(reason="checkpoint", checkpoint_key="wrong")["prepared"])
        self.assertTrue(self.prep(reason="checkpoint", checkpoint_key="sample-ready")["prepared"])

    def test_user_checkpoint_does_not_require_extra_compactions(self):
        self.delivered()
        self.reply("defer", checkpoint_key="sample-ready")
        self.assertTrue(self.prep(reason="checkpoint", stage="sample", checkpoint_key="sample-ready")["prepared"])

    def test_verified_new_confusion_bypasses_cooldown_but_not_mute(self):
        self.delivered()
        self.assertTrue(self.prep(reason="confusion", cause_key="wrong-master", benefit=True)["prepared"])
        self.shown()
        self.hook("Stop", last_assistant_message=NOTICE)
        self.compact(5)
        self.assertFalse(self.prep(reason="confusion", cause_key="wrong-master", benefit=True)["prepared"])
        self.reply("mute")
        self.assertFalse(self.prep(reason="confusion", cause_key="new-error", benefit=True)["prepared"])

    def test_mute_resume_and_handoff_only_change_reminder_state(self):
        self.delivered()
        self.reply("mute")
        self.compact(10)
        self.assertFalse(self.prep(reason="stage", stage="sample", benefit=True)["prepared"])
        self.reply("resume", turn="response-b")
        self.assertTrue(self.prep(reason="stage", stage="sample", benefit=True)["prepared"])
        self.shown()
        self.reply("handoff", turn="response-c")
        self.assertTrue(self.status()["muted"])
        self.assertEqual({p.suffix for p in self.root.iterdir()}, {".json", ".lock"})

    def test_cancel_prevents_stale_final_repair(self):
        self.compact(3)
        self.prep()
        m.process(self.event(""), self.root, "cancel", proposal_id=self.pid())
        self.assertEqual(self.hook("Stop", last_assistant_message="任务已结束"), {})
        self.assertEqual(self.status()["reminder_count"], 0)

    def test_repeat_prepare_and_interruption_rearm_keep_one_identity(self):
        self.compact(3)
        self.prep()
        identity = self.pid()
        self.prep()
        self.shown()
        self.turn = "resumed-turn"
        self.hook("UserPromptSubmit", prompt="处理下一步")
        self.prep()
        self.assertEqual(self.pid(), identity)
        self.hook("Stop", last_assistant_message=NOTICE)
        self.assertEqual(self.status()["reminder_count"], 1)

    def test_parent_child_isolation_and_distinct_sessions(self):
        self.hook("PostCompact", trigger="auto", agent_id="child")
        self.assertFalse(self.root.exists())
        self.compact(3)
        other = m.process(dict(session_id="other"), self.root, "status")
        self.assertEqual(other["auto_count"], 0)
        self.assertEqual(self.status()["auto_count"], 3)

    def test_transcript_metadata_subagent_isolation(self):
        self.root.mkdir(parents=True)
        path = self.root / "child.jsonl"
        path.write_text(json.dumps({"type": "session_meta", "payload": {
            "id": "child", "source": {"subagent": {}}}}), encoding="utf-8")
        self.hook("PostCompact", trigger="auto", transcript_path=str(path))
        self.assertFalse(m.state_path(self.root, self.sid).exists())

    def test_legacy_ten_is_not_ten_notifications_and_status_preserves_bytes(self):
        self.root.mkdir(parents=True)
        legacy = dict(schema=1, session_id=self.sid, auto_count=10, next_reminder_at=13,
                      muted=False, last_notified_at=10, last_reason="count", response="pending")
        path = m.state_path(self.root, self.sid)
        path.write_text(json.dumps(legacy), encoding="utf-8")
        before = path.read_bytes()
        s = self.status()
        self.assertIsNone(s["reminder_count"])
        self.assertEqual(s["tracked_reminder_count"], 0)
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse(path.with_suffix(".lock").exists())
        self.compact(3)
        self.prep(reason="stage", stage="full", benefit=True)
        self.hook("Stop", last_assistant_message=NOTICE)
        s = self.status()
        self.assertIsNone(s["reminder_count"])
        self.assertEqual((s["tracked_reminder_count"], s["auto_count"]), (1, 13))

    def test_corrupt_state_is_preserved(self):
        self.root.mkdir(parents=True)
        path = m.state_path(self.root, self.sid)
        path.write_text('{"schema":999}', encoding="utf-8")
        before = path.read_bytes()
        with self.assertRaises(ValueError):
            self.compact()
        self.assertEqual(path.read_bytes(), before)

    def test_cli_stop_json_and_fail_open_error(self):
        self.compact(3)
        self.prep()
        command = [sys.executable, "-X", "utf8", str(SCRIPT), "--state-dir", str(self.root)]
        result = subprocess.run(command, input=json.dumps(self.event("Stop", last_assistant_message="成果")),
                                text=True, encoding="utf-8", capture_output=True, timeout=8)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)["decision"], "block")
        result = subprocess.run(command, input="{}", text=True, encoding="utf-8", capture_output=True, timeout=8)
        self.assertEqual(result.returncode, 0)
        self.assertIn("systemMessage", json.loads(result.stdout))

    def test_prompt_body_is_not_saved_in_state(self):
        self.compact()
        self.hook("UserPromptSubmit", prompt="PRIVATE-SENTINEL-DO-NOT-SAVE")
        saved = m.state_path(self.root, self.sid).read_text(encoding="utf-8")
        self.assertNotIn("PRIVATE-SENTINEL", saved)

    def test_same_session_subagent_source_is_ignored(self):
        self.root.mkdir(parents=True)
        path = self.root / "subagent.jsonl"
        path.write_text(json.dumps({"type": "session_meta", "payload": {
            "id": self.sid, "source": {"subagent": {"spawn": {}}}}}), encoding="utf-8")
        self.hook("PostCompact", trigger="auto", transcript_path=str(path))
        self.assertEqual(self.status()["auto_count"], 0)

    def test_malformed_json_cli_preserves_original_file(self):
        self.compact()
        path = m.state_path(self.root, self.sid)
        path.write_text("broken-json", encoding="utf-8")
        command = [sys.executable, "-X", "utf8", str(SCRIPT), "--state-dir", str(self.root)]
        result = subprocess.run(command, input=json.dumps(self.event("PostCompact", trigger="auto")),
                                text=True, encoding="utf-8", capture_output=True, timeout=8)
        self.assertEqual(result.returncode, 0)
        self.assertIn("systemMessage", json.loads(result.stdout))
        self.assertEqual(path.read_text(encoding="utf-8"), "broken-json")

    def test_cli_prompt_context_does_not_request_stop_continuation(self):
        self.compact(3)
        command = [sys.executable, "-X", "utf8", str(SCRIPT), "--state-dir", str(self.root)]
        result = subprocess.run(command, input=json.dumps(self.event("UserPromptSubmit")),
                                text=True, encoding="utf-8", capture_output=True, timeout=8)
        self.assertEqual(result.returncode, 0)
        output = json.loads(result.stdout)
        self.assertEqual(output["hookSpecificOutput"]["hookEventName"], "UserPromptSubmit")
        self.assertIn("首次", output["hookSpecificOutput"]["additionalContext"])
        self.assertNotIn("decision", output)
        self.assertNotIn("continue", output)


if __name__ == "__main__":
    started = time.time()
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ReminderTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    record = {"tests": result.testsRun, "failures": len(result.failures), "errors": len(result.errors),
              "seconds": round(time.time()-started, 3), "fixture_dir": str(RUN),
              "failure_details": [{"test": str(t), "traceback": detail}
                                  for t, detail in result.failures + result.errors]}
    (QA / "test-result.json").write_text(json.dumps(record, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    raise SystemExit(not result.wasSuccessful())
