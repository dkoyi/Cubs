"""Local client lifecycle tests; all HTTP is handled by the localhost stub."""
import json
import os
from pathlib import Path

from test_connect_py import connect_py
from test_sync_py import SyncBase


class AlumniClientTests(SyncBase):
    def test_stale_sync_preserves_state_until_refresh_recovers_remote_choices(self) -> None:
        self.opt_in()
        self.stub_sync()
        self.stub.responses[("PUT", "/api/context")] = (200, {"accepted": 5, "context_version": "v1"})
        self.sync()
        self.assertEqual(self.stub.calls[0]["body"]["context_version"], None)
        self.stub.responses[("PUT", "/api/context")] = (409, {"error": "CONTEXT CONFLICT. stale device"})
        code, out = self.sync()
        self.assert_one_error_line(code, out, "CONTEXT CONFLICT")
        self.assertEqual(connect_py.load_state()["context_version"], "v1")
        self.stub.responses[("GET", "/api/context")] = (200, {
            "policy": {**connect_py.POLICY_DEFAULTS, "participating": False}, "signals": [], "free": [], "context_version": "v2"})
        self.assertEqual(self.run_cli("refresh")[0], 0)
        self.assertFalse(connect_py.load_policy()["participating"])
        self.assertEqual(json.loads(self.context_file.read_text())["signals"], [])
        self.assertEqual(connect_py.load_state()["context_version"], "v2")

    def test_alumni_policy_is_explicit_and_can_be_revoked_while_paused(self) -> None:
        self.assertFalse(connect_py.load_policy()["alumni_network"])
        code, out = self.run_cli("policy", "--discoverable", "alumni")
        self.assert_one_error_line(code, out, "USAGE")
        code, out = self.run_cli("policy", "--alumni-network", "yes", "--remember-connections", "yes",
                                 "--life-stage", "alumni", "--discoverable", "alumni", "--affiliation", "ASU")
        self.assertEqual(code, 0, out)
        connect_py.load_identity(create=True)
        self.stub_sync()
        self.assertEqual(self.run_cli("sync")[0], 0)  # paused, file-free sync
        self.stub.calls.clear()
        self.run_cli("policy", "--alumni-network", "no")
        self.assertEqual(self.run_cli("sync")[0], 0)
        policy = self.put_body()["policy"]
        self.assertFalse(policy["alumni_network"])
        self.assertFalse(policy["remember_connections"])
        self.assertEqual(policy["discoverable"], "school")

    def test_stale_offers_are_not_renewed_and_current_topics_reach_the_server(self) -> None:
        self.opt_in("--alumni-network", "yes")
        self.stub_sync()
        self.write_context({"signals": [
            {"type": "can_help_with", "entity": {"kind": "topic", "label": "React"}, "source": "memory",
             "confirmed_at": "2025-10-24T16:00:00Z"},
            {"type": "open_to", "entity": {"kind": "activity", "label": "advising"}, "source": "memory"},
            {"type": "looking_for", "entity": {"kind": "topic", "label": "clinical workflow advice"}, "source": "student",
             "topics": ["healthcare"], "confirmed_at": "2026-10-24T16:00:00Z"},
        ]})
        self.assertEqual(self.sync()[0], 0)
        signals = self.put_body()["signals"]
        self.assertEqual(len(signals), 1)
        self.assertEqual(signals[0]["topics"], ["healthcare"])
        self.assertEqual(signals[0]["confirmed_at"], "2026-10-24T16:00:00+00:00")

    def test_stop_without_context_file_reaches_server(self) -> None:
        connect_py.load_identity(create=True)
        self.context_file.unlink()
        self.stub_sync()
        code, out = self.run_cli("sync")
        self.assertEqual(code, 0, out)
        self.assertFalse(self.put_body()["policy"]["participating"])

    def test_failed_acknowledgment_does_not_suppress_a_message(self) -> None:
        self.opt_in()
        self.stub_sync(ask={"id": "sug-1", "text": "Someone can help with your project. Want to connect?"})
        self.sync()
        self.stub.responses[("POST", "/api/suggestions/sug-1/delivered")] = (503, {})
        self.assertEqual(self.run_cli("delivered", "sug-1", "ask")[0], 1)
        self.assertIn("ASK sug-1", self.sync()[1])

    def test_outcomes_send_only_the_explicit_structured_feedback(self) -> None:
        connect_py.load_identity(create=True)
        self.stub.responses[("POST", "/api/connections")] = (200, {"saved": True})
        code, out = self.run_cli("feedback", "connection-1", "not_useful")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.stub.calls[-1]["body"], {"id": "connection-1", "outcome": "not_useful"})


class IdentityPortabilityTests(SyncBase):
    def test_private_backup_and_restore_recover_current_remote_policy(self) -> None:
        identity = connect_py.load_identity(create=True)
        backup = Path(self.tmp.name) / "private-backup.json"
        code, out = self.run_cli("identity", "export", "--file", str(backup))
        self.assertEqual(code, 0, out)
        self.assertNotIn(identity["token"], out)
        self.assertEqual(os.stat(backup).st_mode & 0o777, 0o600)
        self.assertEqual(self.run_cli("identity", "export", "--file", str(backup))[0], 1)
        self.assertEqual(json.loads(backup.read_text())["identity"], identity)

        (Path(self.tmp.name) / "identity.json").unlink()
        self.context_file.unlink()
        remote_policy = {**connect_py.POLICY_DEFAULTS, "participating": True, "alumni_network": True,
                         "remember_connections": True, "life_stage": "alumni", "discoverable": "alumni",
                         "affiliations": ["ASU"], "first_name": "Alex", "contact": "alex@example.edu"}
        self.stub.responses[("GET", "/api/context")] = (200, {"policy": remote_policy, "signals": [], "free": []})
        code, out = self.run_cli("identity", "import", "--file", str(backup))
        self.assertEqual(code, 0, out)
        self.assertEqual(self.identity(), identity)
        self.assertEqual(connect_py.load_policy()["discoverable"], "alumni")
        self.assertEqual(connect_py.load_policy()["affiliations"], ["ASU"])
        self.assertNotIn(identity["token"], out)

    def test_failed_restore_preserves_local_files(self) -> None:
        identity = connect_py.load_identity(create=True)
        backup = Path(self.tmp.name) / "backup.json"
        self.run_cli("identity", "export", "--file", str(backup))
        original = self.context_file.read_text()
        self.stub.responses[("GET", "/api/context")] = (401, {"error": "wrong token"})
        code, out = self.run_cli("identity", "import", "--file", str(backup))
        self.assertEqual(code, 1, out)
        self.assertEqual(self.identity(), identity)
        self.assertEqual(self.context_file.read_text(), original)

    def test_restore_cannot_replace_another_identity_or_choose_another_host(self) -> None:
        identity = connect_py.load_identity(create=True)
        backup = Path(self.tmp.name) / "backup.json"
        self.run_cli("identity", "export", "--file", str(backup))
        value = json.loads(backup.read_text())
        value["server"] = "https://another.example"
        backup.write_text(json.dumps(value))
        self.assertEqual(self.run_cli("identity", "import", "--file", str(backup))[0], 1)
        self.assertEqual(self.stub.calls, [])
        self.assertEqual(self.identity(), identity)
