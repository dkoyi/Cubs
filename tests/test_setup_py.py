"""The bundled Skill setup uses a localhost stub and invented participants only."""
import json
from pathlib import Path

from test_connect_py import connect_py
from test_sync_py import SyncBase

AT = "2026-10-24T16:00:00Z"


class BundledSetupTests(SyncBase):
    def setup_file(self, intro="automatic") -> None:
        self.write_context({"tz": "America/Phoenix", "policy": {"participating": True, "first_name": "Alex", "school": "ASU",
            "contact": "alex@example.test", "intro": intro, "share_intro_profile": True,
            "intro_profile": {"name": "Alex Example", "headline": "Example builder", "links": []}},
            "signals": [{"type": "working_on", "entity": {"kind": "topic", "label": "healthcare"}, "source": "student"},
                        {"type": "open_to", "entity": {"kind": "activity", "label": "advising"}, "source": "student", "confirmed_at": AT}], "free": []})

    def compatible_server(self, intro="automatic") -> None:
        self.stub.responses[("GET", "/api/capabilities")] = (200, {"skill_release": connect_py.SKILL_RELEASE, "capabilities": list(connect_py.SETUP_CAPABILITIES)})
        self.stub_sync()
        self.stub.responses[("PUT", "/api/context")] = (200, {"accepted": 2, "rejected": [], "signals_total": 2,
            "skill_release": connect_py.SKILL_RELEASE, "intro_mode": intro, "context_version": "setup-v1"})

    def run_setup(self):
        return self.run_cli("setup", "--file", str(self.context_file), "--approved-at", AT)

    def test_one_approved_run_preserves_identity_and_records_the_actual_permission(self) -> None:
        identity = connect_py.load_identity(create=True)
        self.setup_file(); self.compatible_server()
        code, out = self.run_setup()
        self.assertEqual(code, 0, out)
        self.assertTrue(out.startswith("SETUP COMPLETE."))
        self.assertEqual(self.identity(), identity)
        policy = self.put_body()["policy"]
        self.assertEqual(policy["intro"], "automatic")
        self.assertEqual(policy["automatic_intro_consent"]["approved_at"], "2026-10-24T16:00:00+00:00")
        self.assertEqual(policy["automatic_intro_consent"]["activities"], ["advising"])
        self.assertEqual(connect_py.load_state()["setup_release"], connect_py.SKILL_RELEASE)

    def test_old_server_does_not_change_previous_choices_or_send_context(self) -> None:
        self.opt_in("--discoverable", "network")
        before = (Path(self.tmp.name) / "policy.json").read_text()
        self.setup_file()
        self.stub.responses[("GET", "/api/capabilities")] = (404, {"error": "not found"})
        code, out = self.run_setup()
        self.assert_one_error_line(code, out, "UPDATE REQUIRED")
        self.assertEqual((Path(self.tmp.name) / "policy.json").read_text(), before)
        self.assertFalse(any(call["method"] == "PUT" for call in self.stub.calls))

    def test_ask_first_setup_has_no_standing_grant_and_local_revoke_is_not_a_remote_change(self) -> None:
        self.setup_file("ask"); self.compatible_server("ask")
        self.assertEqual(self.run_setup()[0], 0)
        self.assertNotIn("automatic_intro_consent", self.put_body()["policy"])
        self.setup_file(); self.compatible_server()
        self.assertEqual(self.run_setup()[0], 0)
        self.stub.calls.clear()
        self.assertEqual(self.run_cli("policy", "--intro", "ask")[0], 0)
        self.assertEqual(self.stub.calls, [])
        self.assertEqual(connect_py.load_policy()["intro"], "ask")
        self.assertNotIn("automatic_intro_consent", connect_py.load_policy())

    def test_no_scope_activity_or_time_guessing_before_setup(self) -> None:
        self.setup_file()
        ctx = json.loads(self.context_file.read_text())
        ctx["signals"] = []
        self.write_context(ctx)
        code, out = self.run_setup()
        self.assert_one_error_line(code, out, "BAD CONTEXT")
        self.assertEqual(self.stub.calls, [])

    def test_expired_or_changed_contact_prepares_ask_first_instead_of_reusing_grant(self) -> None:
        self.setup_file(); self.compatible_server(); self.run_setup()
        ctx = json.loads(self.context_file.read_text()); ctx["policy"]["contact"] = "changed@example.test"
        body, _ = connect_py.build_context(ctx, connect_py.load_policy(), connect_py.utc_now())
        self.assertEqual(body["policy"]["intro"], "ask")
        self.assertNotIn("automatic_intro_consent", body["policy"])
