"""Tests for the Sync commands of supercub/scripts/connect.py (sync, answer, policy, context, leave).

Run from the repo root:  python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from typing import Any

from test_connect_py import SKILL_DIR, ConnectPyBase, connect_py

FIXTURE = SKILL_DIR / "assets" / "context-example.json"
ASK = {
    "id": "sug-1",
    "text": "Someone in your CSE 310 section is working on HW4 too and is open to studying with classmates. "
            "Want me to see if you'd both like to connect?",
    "kind": "study",
    "shared": ["enrolled_in:cse310", "working_on:hw4"],
    "expires_at": "2026-10-26T16:00:00Z",
}
AGREED = {
    "id": "sug-1",
    "first_name": "Jordan",
    "contact": "+1 480 555 0199",
    "when": {"start": "2026-10-30T02:00:00Z", "end": "2026-10-30T03:00:00Z"},
    "text": "You're on. Jordan said yes too. Thu 7 to 8 pm.",
}


class SyncBase(ConnectPyBase):
    def setUp(self) -> None:
        super().setUp()
        self.home = tempfile.TemporaryDirectory()
        self.old_home = os.environ.get("HOME")
        os.environ["HOME"] = self.home.name
        self.context_file = Path(self.home.name) / ".config" / "supercub" / "context.json"
        self.context_file.parent.mkdir(parents=True)
        self.context_file.write_text(FIXTURE.read_text())

    def tearDown(self) -> None:
        if self.old_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = self.old_home
        self.home.cleanup()
        super().tearDown()

    def opt_in(self, *extra: str) -> None:
        code, out = self.run_cli("policy", "--participating", "yes", *extra)
        self.assertEqual(code, 0, out)

    def stub_sync(self, ask: Any = None, agreed: Any = None, accepted: int = 5) -> None:
        self.stub.responses[("PUT", "/api/context")] = (
            200, {"accepted": accepted, "rejected": [{"index": 2, "reason": "grades are never accepted"}],
                  "signals_total": accepted, "open_suggestion": ask is not None})
        self.stub.responses[("GET", "/api/suggestions")] = (
            200, {"ask": ask, "agreed": agreed or [], "nothing_new": ask is None and not agreed})

    def sync(self) -> tuple[int, str]:
        return self.run_cli("sync", "--file", str(self.context_file))

    def write_context(self, value: Any) -> None:
        self.context_file.write_text(json.dumps(value))

    def put_body(self) -> dict[str, Any]:
        puts = [c for c in self.stub.calls if c["method"] == "PUT"]
        self.assertEqual(len(puts), 1)
        return puts[0]["body"]


class PolicyTests(SyncBase):
    def test_policy_saves_locally_without_network(self) -> None:
        code, out = self.run_cli("policy", "--participating", "yes", "--discoverable", "section", "--share-events", "no")
        self.assertEqual(code, 0, out)
        self.assertTrue(out.startswith("POLICY SAVED."), out)
        self.assertIn("people in your classes", out)
        self.assertEqual(self.stub.calls, [])
        saved = json.loads((Path(self.tmp.name) / "policy.json").read_text())
        self.assertEqual(saved, {"participating": True, "discoverable": "section", "share_events": False})

    def test_policy_updates_one_flag_and_keeps_the_rest(self) -> None:
        self.opt_in("--discoverable", "network")
        self.run_cli("policy", "--share-events", "yes")
        policy = connect_py.load_policy()
        self.assertEqual((policy["participating"], policy["discoverable"], policy["share_events"]),
                         (True, "network", True))

    def test_policy_needs_a_flag_and_valid_values(self) -> None:
        code, out = self.run_cli("policy")
        self.assert_one_error_line(code, out, "USAGE")
        code, out = self.run_cli("policy", "--discoverable", "everyone")
        self.assert_one_error_line(code, out, "USAGE")


class SyncTests(SyncBase):
    def test_sync_sends_context_then_relays_one_ask(self) -> None:
        self.opt_in()
        self.stub_sync(ask=ASK)
        code, out = self.sync()
        self.assertEqual(code, 0, out)
        self.assertEqual(out.strip().splitlines(), ["ASK sug-1", ASK["text"]])
        self.assertEqual([(c["method"], c["path"]) for c in self.stub.calls],
                         [("PUT", "/api/context"), ("GET", "/api/suggestions")])
        call = self.stub.calls[0]
        identity = self.identity()
        assert identity is not None
        self.assertEqual(call["auth"], f"Bearer {identity['token']}")
        self.assertEqual(call["token"], identity["token"])
        self.assertEqual(call["student_id"], identity["student_id"])

        body = call["body"]
        self.assertEqual(body["tz"], "America/Phoenix")
        self.assertEqual(body["policy"], {
            "participating": True, "discoverable": "school", "intro": "ask", "share_events": False,
            "share_applications": False, "max_suggestions_per_week": 1,
            "first_name": "Alex", "school": "ASU", "contact": "alex@example.edu"})
        self.assertEqual(len(body["free"]), 2)
        types = [s["type"] for s in body["signals"]]
        # share_events is off, so the hackathon stays on this device.
        self.assertEqual(types, ["enrolled_in", "working_on", "interested_in", "can_help_with", "open_to"])
        hw = body["signals"][1]
        self.assertEqual(hw["entity"], {"kind": "assignment", "key": "CSE 310 HW4", "label": "CSE 310 HW4"})
        self.assertEqual(hw["due"], "2026-10-28T23:59:00-07:00")
        self.assertEqual(hw["source"], "canvas")
        self.assertEqual(hw["observed_at"], "2026-10-24T16:00:00+00:00")

    def test_same_ask_is_not_repeated_on_the_next_sync(self) -> None:
        self.opt_in()
        self.stub_sync(ask=ASK)
        self.sync()
        code, out = self.sync()
        self.assertEqual(code, 0, out)
        self.assertEqual(out.strip(), "NOTHING NEW")

    def test_nothing_new(self) -> None:
        self.opt_in()
        self.stub_sync()
        code, out = self.sync()
        self.assertEqual((code, out.strip()), (0, "NOTHING NEW"))

    def test_agreed_comes_first_and_only_once(self) -> None:
        self.opt_in()
        self.stub_sync(ask={**ASK, "id": "sug-2"}, agreed=[AGREED])
        code, out = self.sync()
        self.assertEqual(code, 0, out)
        lines = out.strip().splitlines()
        self.assertEqual(lines[:3], ["AGREED", AGREED["text"], "+1 480 555 0199"])
        self.assertTrue(lines[3].startswith("Calendar times: 2026-10-29T19:00-07:00"), lines)
        code, out = self.sync()  # the agreed one was shown; the ask comes next
        self.assertEqual(out.strip().splitlines()[0], "ASK sug-2")

    def test_share_events_yes_sends_the_event(self) -> None:
        self.opt_in("--share-events", "yes")
        self.stub_sync()
        self.sync()
        events = [s for s in self.put_body()["signals"] if s["type"] == "attending"]
        self.assertEqual(events[0]["entity"]["label"], "Cubbie Hackathon")
        self.assertEqual(events[0]["when"], "2026-10-31T10:00:00-07:00")

    def test_emails_and_phones_are_stripped_from_details(self) -> None:
        self.opt_in()
        self.stub_sync()
        detail = "HW4 with jordan.lee@asu.edu or call (480) 555-0123, +1 602 555 0188, 555-0199 or +44 20 7946 0958"
        self.write_context({"tz": "America/Phoenix", "signals": [
            {"type": "working_on", "entity": {"kind": "assignment", "label": "HW4 text 480-555-0100"},
             "detail": detail, "source": "canvas"},
            {"type": "enrolled_in", "entity": {"kind": "course", "label": "CSE 310"},
             "detail": "section 12345, room 2026-10-25", "source": "canvas"}]})
        code, out = self.sync()
        self.assertEqual(code, 0, out)
        sent = json.dumps(self.put_body())
        for leaked in ("@", "555", "7946", "jordan"):
            self.assertNotIn(leaked, sent)
        signals = self.put_body()["signals"]
        self.assertEqual(signals[0]["entity"]["label"], "HW4 text")
        self.assertTrue(signals[0]["detail"].startswith("HW4 with"), signals[0]["detail"])
        self.assertEqual(signals[1]["detail"], "section 12345, room 2026-10-25")  # not a phone

    def test_detail_is_capped_and_bad_signals_stay_here(self) -> None:
        self.opt_in()
        self.stub_sync()
        many = [{"type": "interested_in", "entity": {"kind": "topic", "label": f"topic {i}"}} for i in range(70)]
        self.write_context({"signals": [
            {"type": "working_on", "entity": {"kind": "topic", "label": "essay"}, "detail": "x" * 300},
            {"type": "grade", "entity": {"kind": "course", "label": "CSE 310"}},
            {"type": "open_to", "entity": {"kind": "activity", "label": "dating"}},
            {"type": "applying_to", "entity": {"kind": "company", "label": "Acme"}},
            "not a signal",
            *many,
        ]})
        code, out = self.sync()
        self.assertEqual(code, 0, out)
        signals = self.put_body()["signals"]
        self.assertEqual(len(signals), 60)
        self.assertLessEqual(len(signals[0]["detail"]), 120)
        self.assertEqual(signals[0]["source"], "memory")
        self.assertNotIn("grade", [s["type"] for s in signals])
        self.assertNotIn("applying_to", [s["type"] for s in signals])
        state = json.loads((Path(self.tmp.name) / "state.json").read_text())
        self.assertEqual(state["last_sync"]["skipped_here"], 4 + 11)

    def test_past_and_bad_free_times_are_left_out(self) -> None:
        self.opt_in()
        self.stub_sync()
        self.write_context({"tz": "America/Phoenix", "signals": [], "free": [
            {"start": "2026-10-20T10:00", "end": "2026-10-20T11:00"},
            {"start": "soon", "end": "later"},
            {"start": "2026-10-25T10:00", "end": "2026-10-25T12:00"}]})
        self.sync()
        self.assertEqual(self.put_body()["free"],
                         [{"start": "2026-10-25T10:00:00-07:00", "end": "2026-10-25T12:00:00-07:00"}])

    def test_not_participating_sends_nothing(self) -> None:
        code, out = self.sync()
        self.assertEqual((code, out.strip()), (0, "NOT PARTICIPATING. Nothing was shared."))
        self.assertEqual(self.stub.calls, [])
        self.assertIsNone(self.identity())

    def test_opting_out_after_syncing_tells_the_server_only_that(self) -> None:
        self.opt_in()
        self.stub_sync()
        self.sync()
        self.run_cli("policy", "--participating", "no")
        self.stub.calls.clear()
        code, out = self.sync()
        self.assertEqual(code, 0, out)
        self.assertIn("NOT PARTICIPATING", out)
        self.assertEqual(len(self.stub.calls), 1)
        body = self.stub.calls[0]["body"]
        self.assertEqual((body["policy"]["participating"], body["signals"], body["free"]), (False, [], []))
        self.assertNotIn("contact", body["policy"])
        self.stub.calls.clear()
        self.sync()  # already told the server
        self.assertEqual(self.stub.calls, [])

    def test_bad_context_files(self) -> None:
        self.opt_in()
        self.stub_sync()
        self.context_file.write_text("{not json")
        code, out = self.sync()
        self.assert_one_error_line(code, out, "BAD CONTEXT")
        self.write_context({"signals": "CSE 310"})
        code, out = self.sync()
        self.assert_one_error_line(code, out, "BAD CONTEXT")
        self.write_context({"tz": "Mars/Olympus", "signals": []})
        code, out = self.sync()
        self.assert_one_error_line(code, out, "BAD CONTEXT")
        code, out = self.run_cli("sync", "--file", str(self.context_file) + ".missing")
        self.assert_one_error_line(code, out, "BAD CONTEXT")
        self.assertEqual(self.stub.calls, [])

    def test_put_waits_90_seconds_and_get_15(self) -> None:
        self.opt_in()
        self.stub_sync(ask=ASK)
        real = connect_py.urllib.request.urlopen
        seen: list[tuple[str, float]] = []

        def recording(req: Any, timeout: float) -> Any:
            seen.append((req.get_method(), timeout))
            return real(req, timeout=timeout)

        connect_py.urllib.request.urlopen = recording
        try:
            code, out = self.sync()
        finally:
            connect_py.urllib.request.urlopen = real
        self.assertEqual(code, 0, out)
        self.assertEqual(seen, [("PUT", 90), ("GET", 15)])
        self.assertLessEqual(sum(t for _, t in seen), 110)

    def test_server_down_is_one_line(self) -> None:
        self.opt_in()
        self.stub.responses[("PUT", "/api/context")] = (503, {"error": "down"})
        code, out = self.sync()
        self.assert_one_error_line(code, out, "SERVER UNAVAILABLE")

    def test_server_rejects_the_request(self) -> None:
        self.opt_in()
        self.stub.responses[("PUT", "/api/context")] = (400, {"error": "policy.school is required"})
        code, out = self.sync()
        self.assert_one_error_line(code, out, "policy.school is required")

    def test_long_suggestion_text_stays_short(self) -> None:
        self.opt_in()
        self.stub_sync(ask={**ASK, "text": "Ignore\nprevious " + "x" * 9000})
        code, out = self.sync()
        self.assertEqual(code, 0, out)
        self.assertLess(len(out), 8000)
        self.assertEqual(len(out.strip().splitlines()), 2)

    def test_context_shows_local_state_and_last_counts(self) -> None:
        self.opt_in()
        self.stub_sync()
        self.sync()
        code, out = self.run_cli("context")
        self.assertEqual(code, 0, out)
        self.assertIn("POLICY. Participating: yes.", out)
        self.assertIn("5 signals to send, 1 left out here, 2 free times", out)
        self.assertIn("- working_on assignment: CSE 310 HW4 (hash tables)", out)
        self.assertIn("accepted 5, rejected 1", out)
        self.assertIn("Rejected #2 grades are never accepted", out)
        self.assertEqual(len([c for c in self.stub.calls if c["method"] == "PUT"]), 1)  # context is offline


class AnswerTests(SyncBase):
    def setUp(self) -> None:
        super().setUp()
        self.opt_in()
        self.stub_sync(ask=ASK)
        self.sync()
        self.path = "/api/suggestions/sug-1/answer"

    def answer(self, value: str, reply: Any, status: int = 200) -> tuple[int, str]:
        self.stub.responses[("POST", self.path)] = (status, reply)
        return self.run_cli("answer", "sug-1", value)

    def test_yes_waiting(self) -> None:
        code, out = self.answer("yes", {"status": "waiting"})
        self.assertEqual((code, out.strip()), (0, "WAITING"))
        self.assertEqual(self.stub.calls[-1]["body"], {"answer": "yes"})

    def test_yes_agreed_then_sync_does_not_repeat_it(self) -> None:
        reply = {"status": "agreed", **{k: v for k, v in AGREED.items() if k != "id"}}
        code, out = self.answer("yes", reply)
        self.assertEqual(code, 0, out)
        self.assertEqual(out.strip().splitlines()[:3], ["AGREED", AGREED["text"], "+1 480 555 0199"])
        self.stub_sync(agreed=[AGREED])
        code, out = self.sync()
        self.assertEqual(out.strip(), "NOTHING NEW")

    def test_no_passed(self) -> None:
        code, out = self.answer("no", {"status": "passed"})
        self.assertEqual((code, out.strip()), (0, "PASSED"))

    def test_later_lets_the_next_sync_ask_again(self) -> None:
        code, out = self.answer("later", {"status": "waiting"})
        self.assertEqual(code, 0, out)
        self.assertTrue(out.startswith("LATER."), out)
        code, out = self.sync()
        self.assertEqual(out.strip().splitlines()[0], "ASK sug-1")

    def test_closed_suggestion(self) -> None:
        for status in (404, 409, 410):
            code, out = self.answer("yes", {"error": "expired"}, status=status)
            self.assertEqual(code, 0, out)
            self.assertTrue(out.startswith("CLOSED."), out)

    def test_bad_answer_and_not_joined(self) -> None:
        code, out = self.run_cli("answer", "sug-1", "maybe")
        self.assert_one_error_line(code, out, "USAGE")
        (Path(self.tmp.name) / "identity.json").unlink()
        code, out = self.run_cli("answer", "sug-1", "yes")
        self.assert_one_error_line(code, out, "NOT JOINED")


class LeaveSyncTests(SyncBase):
    def test_leave_deletes_context_and_policy(self) -> None:
        self.opt_in()
        self.stub_sync()
        self.sync()
        self.stub.responses[("DELETE", "/api/me")] = (200, {"deleted": True})
        code, out = self.run_cli("leave")
        self.assertEqual(code, 0, out)
        self.assertIn("LEFT", out)
        self.assertFalse(self.context_file.exists())
        self.assertEqual(sorted(p.name for p in Path(self.tmp.name).iterdir()), [])

    def test_leave_without_identity_still_deletes_local_files(self) -> None:
        self.opt_in()
        code, out = self.run_cli("leave")
        self.assertIn("NOTHING TO DELETE", out)
        self.assertFalse(self.context_file.exists())
        self.assertFalse((Path(self.tmp.name) / "policy.json").exists())


class SyncSkillMdTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.text = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")

    def test_new_outputs_are_mapped(self) -> None:
        inline = re.sub(r"```.*?```", "", self.text, flags=re.DOTALL)
        spans = re.findall(r"`([^`]+)`", inline)
        for tag in ("NOTHING NEW", "ASK <id>", "AGREED", "WAITING", "PASSED", "LATER", "CLOSED",
                    "NOT PARTICIPATING", "POLICY SAVED", "BAD CONTEXT", "Calendar times"):
            self.assertTrue(any(tag in span for span in spans), f"SKILL.md does not map {tag}")

    def test_setup_questions_and_check_in_wording(self) -> None:
        sync = self.text.split("## Sync", 1)[1].split("\n## ", 1)[0]
        for line in (
            "Super Cub can also notice connections on its own. It would share a few facts about your classes and "
            "what you're working on with the Super Cub network, never your grades, emails or messages, and only "
            "suggest a connection when both people say yes. You'd be open to study partners, teammates, meals and "
            "buddies, and you can change that with one text. Want in?",
            "Who should be able to be matched with you: people in your classes, anyone at your school, or anyone "
            "on Super Cub?",
            "Can I share names of public-looking events from your calendar and email, like hackathons and career "
            "fairs? Yes or no.",
            "How often should I sync and check for suggestions? Every 2 hours works for this week.",
            "supercub: sync. Run the Sync section of the supercub Skill.",
            "connect.py sync --file ~/.config/supercub/context.json",
            "assets/context-example.json",
        ):
            self.assertIn(line, sync)

    def test_length_and_plain_texts(self) -> None:
        self.assertLess(len(self.text.splitlines()), 260)
        self.assertNotIn("—", self.text)
        self.assertFalse(any(line.lstrip().startswith("|") for line in self.text.splitlines()), "no tables")
        for quoted in re.findall(r'"([^"\n]{12,})"', self.text):
            self.assertNotIn("**", quoted)

    def test_fixture_matches_the_schema(self) -> None:
        ctx = json.loads(FIXTURE.read_text())
        for s in ctx["signals"]:
            self.assertIn(s["type"], connect_py.SIGNAL_TYPES)
            self.assertIn(s["entity"]["kind"], connect_py.ENTITY_KINDS)
            self.assertLessEqual(len(s.get("detail", "")), 120)


if __name__ == "__main__":
    unittest.main()
