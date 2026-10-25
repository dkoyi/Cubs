"""Profile-first relay and one-time sharing choices, using only the local HTTP stub."""
from test_connect_py import connect_py
from test_sync_py import ASK, SyncBase

PROFILE = {
    "name": "Jordan Shah", "headline": "Healthcare product builder", "about": "Building tools for clinical teams.",
    "links": [{"kind": "linkedin", "url": "https://www.linkedin.com/in/jordan-example"}],
    "photo_url": "https://images.example.edu/jordan.jpg",
}


class IntroProfileClientTests(SyncBase):
    def test_profile_is_sent_only_after_explicit_setup_approval(self) -> None:
        self.opt_in()
        self.write_context({"policy": {"first_name": "Jordan", "intro_profile": PROFILE}, "signals": []})
        self.stub_sync()
        self.sync()
        self.assertNotIn("intro_profile", self.put_body()["policy"])
        self.stub.calls.clear()
        self.assertEqual(self.run_cli("policy", "--share-profile", "yes")[0], 0)
        self.assertEqual(self.sync()[0], 0)
        self.assertEqual(self.put_body()["policy"]["intro_profile"], PROFILE)
        self.assertIn("Share intro profile: yes", self.run_cli("context")[1])
        self.assertIn("Jordan Shah", self.run_cli("context")[1])

    def test_profile_relay_contains_name_reason_links_and_current_acceptance(self) -> None:
        self.opt_in()
        text = "Jordan Shah has offered to help with healthcare. They've already said yes. Want the intro?"
        self.stub_sync(ask={**ASK, "text": text, "profile": PROFILE, "other_accepted": True})
        code, out = self.sync()
        self.assertEqual(code, 0, out)
        self.assertEqual(out.splitlines()[1], text)
        self.assertIn("Profile: Jordan Shah", out)
        self.assertIn("Headline: Healthcare product builder", out)
        self.assertIn("LinkedIn: https://www.linkedin.com/in/jordan-example", out)
        self.assertIn("Their answer: yes", out)
        self.assertNotIn("jordan@example.edu", out)

    def test_preview_answers_a_followup_without_syncing_or_consuming_delivery(self) -> None:
        connect_py.load_identity(create=True)
        self.stub.responses[("GET", "/api/suggestions?id=sug-1")] = (200, {"ask": {**ASK, "profile": PROFILE}})
        code, out = self.run_cli("preview", "sug-1")
        self.assertEqual(code, 0, out)
        self.assertIn("Jordan Shah", out)
        self.assertEqual([(c["method"], c["path"]) for c in self.stub.calls], [("GET", "/api/suggestions?id=sug-1")])
        self.assertNotIn("sug-1", connect_py.load_state().get("suggestions", {}))

    def test_private_profile_links_and_contact_text_fail_before_upload(self) -> None:
        self.opt_in("--share-profile", "yes")
        for extra in ({"about": "Email jordan@example.edu"}, {"links": [{"kind": "website", "url": "https://example.edu/?token=private"}]}):
            self.write_context({"policy": {"intro_profile": {**PROFILE, **extra}}, "signals": []})
            code, out = self.sync()
            self.assert_one_error_line(code, out, "BAD CONTEXT")
        self.assertEqual(self.stub.calls, [])
