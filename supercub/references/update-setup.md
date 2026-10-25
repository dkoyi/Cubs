# One catch-up setup after the bundled update

Release: `2026-10-profile-intros-v3`. This is one setup conversation per participant, not permission to silently update everyone or to invent missing choices. Publish the matching server and Skill only after the project owner's separate approval. Keep the existing service URL and each person's UUID/token.

## When the person says “update Super Cub” or “run the new setup”

1. Use Cubbie's supported Skill update/reinstall flow for the existing GitHub Skill. Do not promise an update succeeded before that flow confirms it. Installation approval does not approve expanded sharing, so in the SAME reply that confirms the update, continue straight to steps 2 to 4 and show the setup summary with its one question. Do not end at "updated, setup needs separate approval"; the person should only have to say yes once.
2. Read the updated Skill and `connect.py context`. For an existing identity, use `connect.py refresh` to retrieve current remote choices before drafting the summary; if the service is down, stop rather than filling unknown settings with broader defaults. A 404 profile on an existing identity does not authorize replacing it. Use available local approved choices and ask for genuinely missing information.
3. Gather approved available context through supported Cubbie abilities: current courses/projects, short interests, explicit offers, chosen activities, public events only if approved, and current free windows. Do not read/upload whole chat histories, email prose, grades or private titles. Installation alone is not a sharing permission.
4. Show ONE concise summary of the exact profile, chosen contact, school/scope, connection activities, what facts will be shared, events/applications choices and cap. Preserve earlier explicit preferences unless the person asks to change them. Ask only for missing/unclear contact or activity choices before this summary. Never assume their chat phone number is the introduction contact.

Example, when every displayed value is actually available and approved:

“Here’s your updated Super Cub setup: Alex Morgan, building a healthcare product; ASU only; advising and teammates; your chosen email alex@example.edu. I’ll use short approved course/project facts, interests and the help offers shown below, not chats, grades, files or email contents. I'll also share public events you tell me you're going to, so you can meet others going; applications stay off. Joining means I'll automatically introduce you to relevant people who also joined and share that email with them, for up to a year. OK to join? You can switch to asking first anytime.”

Display any profile links/bio and current help offers included in the snapshot. A yes to this particular summary approves its profile and bounded automatic-contact permission. It does not authorize unmentioned events, wider scope, inferred help offers or unrelated schedules. Automatic is the default for everyone who joins; use `intro: "ask"` only if the person asks to approve each introduction. If they decline the update, preserve their existing choices rather than silently expanding or revoking them; an explicit stop still revokes participation by sync.

5. After actual approval, write the full approved context snapshot to `~/.config/supercub/context.json`. Set `policy.participating: true`, `intro: "automatic"` (or `"ask"` if they asked for it), explicit sharing flags (`share_events: true` as stated in the summary), profile-sharing choice, chosen name/school/contact and `intro_profile` when approved. Include only approved activities as `open_to` signals; preserve actual confirmation dates or use the actual new approval date only for facts/offers explicitly reconfirmed in the displayed summary.
6. Run ONCE with the actual approval timestamp:

```sh
python3 scripts/connect.py setup --file ~/.config/supercub/context.json --approved-at <actual-ISO-approval-time-with-offset>
```

The script preserves identity, verifies the deployed server's capability/release metadata, stores the approved policy and syncs/pulls results. It derives a contact/scope/activity-specific standing permission for automatic mode, without setting unanswered introduction answers to yes. Syncing never renews the approval time. The permission expires at most 365 days after approval; contact/scope changes invalidate it. Offers/activity facts still need to be fresh under normal expiry rules.

7. `SETUP COMPLETE` confirms that this release/mode synced. Relay any following `AGREED` profile/reason/contact as in Sync—no new yes is required if both people's permissions already cover the introduction. A following `ASK` means the current introduction still needs this person's explicit answer. `NOTHING NEW` is normal; do not fabricate a connection or bypass scopes, caps/cooldowns to make a demo happen. Inspect accepted/rejected counts with `context` before claiming all proposed facts were accepted.

`ERROR. UPDATE REQUIRED.` means the host has not confirmed the matching server release. Do not claim the new permissions work remotely. If compatibility failed before sync, earlier choices remain unchanged. If a PUT succeeded but the later pull failed, report the sync/pull distinction and retry; never claim delivery without a relay.

## Automatic versus ask-first

Joining defaults to automatic; anyone can switch to ask-first. When both have a valid standing permission covering the exact contact/scope and activity, the server releases contacts and produces an agreed introduction without another answer. One automatic participant plus one ask-first participant still requires the ask-first person's yes. Never write an answer command on behalf of a silent person.

The server records whether permission came from a specific answer or a standing setup grant. Say “approved automatic introductions,” not “said yes to this match,” for a standing permission. A no or later before completion overrides standing permission for that suggestion. Direct-request join/match consent is separate and remains ask-first; prefer the ongoing contextual path instead of restarting that flow when the person is already in Sync.

To revoke automatic contact release:

```sh
python3 scripts/connect.py policy --intro ask
python3 scripts/connect.py sync
```

Report revocation only after a successful sync. Previously released contacts cannot be recalled. A local edit is not a remote revocation. Full leave remains available.

## Scheduling is not bundled into a sharing yes

Reuse an existing approved, still-active check-in. Do not create duplicates, silently extend its end date, renew a stale help offer or manufacture proof it ran. If a new schedule is wanted, ask separately for its bounded cadence/end date and confirm supported Cubbie creation. Manual sync remains available if the platform cannot create/retrieve/check in as needed. Unattended Cubbie behavior and real-to-real outcomes still need evidence.
