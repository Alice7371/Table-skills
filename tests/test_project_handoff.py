import concurrent.futures
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
import uuid

SOURCE = Path(__file__).resolve().parents[1] / "project-handoff"
QA = Path(__file__).resolve().parents[1] / ".test-output" / "project-handoff"
QA.mkdir(parents=True, exist_ok=True)
ROOT = QA / "fixtures" / str(uuid.uuid4())
SCRIPT = SOURCE / "scripts" / "compaction_reminder.py"
spec = importlib.util.spec_from_file_location("reminder", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class ReminderTests(unittest.TestCase):
    def setUp(self):
        self.session = str(uuid.uuid4())

    def event(self, name="PostCompact", **extra):
        return {"session_id": self.session, "hook_event_name": name,
                "trigger": "auto", "turn_id": "same-turn", **extra}

    def run_event(self, name="PostCompact", **extra):
        return mod.process(self.event(name, **extra), ROOT)

    def status(self):
        return mod.process(self.event(), ROOT, "status")

    def context(self):
        return self.run_event("SessionStart", source="compact").get(
            "hookSpecificOutput", {}).get("additionalContext", "")

    def test_threshold_and_delivery_acknowledgment(self):
        for count in [1, 2]:
            self.assertEqual(self.run_event(), {})
            self.assertEqual(self.status()["auto_count"], count)
            self.assertNotIn("已到次数提醒点", self.context())
        self.run_event()
        self.assertIn("已到次数提醒点", self.context())
        self.assertIn("已到次数提醒点", self.context())
        self.assertIsNone(self.status()["last_notified_at"])
        mod.process(self.event(), ROOT, "notified", reason="count")
        self.assertEqual(self.status()["next_reminder_at"], 6)
        for _ in range(2):
            self.run_event()
            self.assertNotIn("已到次数提醒点", self.context())
        self.run_event()
        self.assertIn("已到次数提醒点", self.context())

    def test_same_turn_counts_every_auto_compaction(self):
        for _ in range(3):
            self.run_event()
        self.assertEqual(self.status()["auto_count"], 3)

    def test_manual_resume_and_keywords_do_not_count(self):
        self.run_event()
        self.run_event(trigger="manual")
        for _ in range(3):
            self.run_event("SessionStart", source="resume")
            self.run_event("UserPromptSubmit", prompt="第三次压缩，同意修改 Skill，继续")
        self.assertEqual(self.status()["auto_count"], 1)
        self.assertIsNone(self.status()["response"])

    def test_continue_extends_cooldown_from_reply(self):
        for _ in range(3):
            self.run_event()
        mod.process(self.event(), ROOT, "notified", reason="count")
        self.run_event()
        mod.process(self.event(), ROOT, "respond", response="continue")
        self.assertEqual(self.status()["next_reminder_at"], 7)
        self.assertNotIn("已到次数提醒点", self.context())

    def test_mute_survives_compactions_and_resume(self):
        mod.process(self.event(), ROOT, "respond", response="mute")
        for _ in range(8):
            self.run_event()
        text = self.run_event("SessionStart", source="resume")
        self.assertIn("主动提醒已关闭", json.dumps(text, ensure_ascii=False))
        self.assertTrue(self.status()["muted"])

    def test_new_sessions_are_isolated(self):
        for _ in range(3):
            self.run_event()
        original = self.session
        self.session = str(uuid.uuid4())
        self.assertEqual(self.status()["auto_count"], 0)
        self.assertEqual(self.context(), "")
        self.session = original
        self.assertEqual(self.status()["auto_count"], 3)

    def test_known_subagents_are_ignored(self):
        self.run_event(agent_id="child")
        self.assertEqual(self.status()["auto_count"], 0)
        transcript = ROOT / "child.jsonl"
        transcript.parent.mkdir(parents=True, exist_ok=True)
        transcript.write_text(json.dumps({"type": "session_meta", "payload": {
            "id": self.session, "source": {"subagent": {"spawn": {}}}}}) + "\n",
            encoding="utf-8")
        self.run_event(transcript_path=str(transcript))
        self.assertEqual(self.status()["auto_count"], 0)

    def test_corrupt_state_is_not_reset(self):
        self.run_event()
        path = ROOT / (hashlib.sha256(self.session.encode()).hexdigest() + ".json")
        path.write_text("broken-json", encoding="utf-8")
        result = subprocess.run([sys.executable, "-X", "utf8", str(SCRIPT),
            "--state-dir", str(ROOT)], input=json.dumps(self.event()),
            text=True, encoding="utf-8", capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0)
        self.assertIn("计数不可用", json.loads(result.stdout)["systemMessage"])
        self.assertEqual(path.read_text(), "broken-json")

    def test_parallel_events_do_not_lose_counts(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(lambda _: self.run_event(), range(12)))
        self.assertEqual(self.status()["auto_count"], 12)

    def test_no_prompt_body_is_saved(self):
        self.run_event()
        self.run_event("UserPromptSubmit", prompt="PRIVATE-SENTINEL-DO-NOT-SAVE")
        path = ROOT / (hashlib.sha256(self.session.encode()).hexdigest() + ".json")
        self.assertNotIn("PRIVATE-SENTINEL", path.read_text(encoding="utf-8"))

    def test_cli_utf8_context_and_pending_retry(self):
        for _ in range(3):
            self.run_event()
        result = subprocess.run([sys.executable, "-X", "utf8", str(SCRIPT),
            "--state-dir", str(ROOT)], input=json.dumps(self.event("UserPromptSubmit")),
            text=True, encoding="utf-8", capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0)
        output = json.loads(result.stdout)
        self.assertEqual(output["hookSpecificOutput"]["hookEventName"], "UserPromptSubmit")
        self.assertIn("已到次数提醒点", output["hookSpecificOutput"]["additionalContext"])
        self.assertNotIn("continue", output)
        self.assertNotIn("decision", output)

    def test_handoff_response_never_creates_a_task(self):
        state = mod.process(self.event(), ROOT, "respond", response="handoff")
        self.assertEqual(state["response"], "handoff")
        self.assertTrue(state["muted"])
        self.assertNotIn("destination_thread", state)


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ReminderTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    (QA / "test-result.json").write_text(json.dumps({"tests": result.testsRun,
        "failures": len(result.failures), "errors": len(result.errors),
        "passed": result.wasSuccessful(), "fixtures": str(ROOT),
        "scope": "local simulated lifecycle events; not native hook execution"},
        ensure_ascii=False, indent=2), encoding="utf-8")
    raise SystemExit(not result.wasSuccessful())
