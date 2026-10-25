# Continuity from university into alumni life

Use this with the Sync section of `SKILL.md`. This is an optional extension to existing participation, not an automatic change at graduation. Cubbie still needs supported interactions/check-ins to retrieve context and relay messages.

## Separate permission for alumni continuity

Ask once when someone requests alumni discovery or discusses continuing Super Cub after graduation:

"Would you like to keep finding connections through your university network after graduation? Super Cub would retain your chosen name/contact, approved school affiliations and sharing choices until you turn alumni continuity off or leave. Current requests and offers still expire. Every introduction needs both people's yes."

Confirm the school affiliations to retain, their current life stage, and their chosen contact. A personal email or phone can replace a university email; never assume either. School affiliation is self-reported, not verified by Super Cub. Do not infer graduation, credentials, experience, or a new sharing scope from an expired Canvas connection.

After explicit approval, for example:

```sh
python3 scripts/connect.py policy --alumni-network yes --discoverable alumni --life-stage alumni --affiliation "ASU"
```

Keep `--life-stage student` for a current student who opts into alumni connections. `--affiliation` replaces the entire approved list; repeat it for multiple approved schools (up to five). `--clear-affiliations` withdraws that list. `alumni` scope requires a shared approved affiliation and both people's alumni participation; network-wide discovery still needs a separate explicit choice. Alumni enrollment never turns `participating` on: confirm that separately if the person is paused or new.

Ask separately:

"May Super Cub remember that an introduction happened so it can suggest reconnecting for a new reason later? It stores dates, a count and a fingerprint of the reason, plus any outcome feedback you choose to give. It does not retain the other person's contact in that history."

Only after yes:

```sh
python3 scripts/connect.py policy --remember-connections yes
```

History is retained only when BOTH people opted into alumni continuity and remembering connections. Each history is capped at 200 relationships. New introductions still work when history is full. The history is used to avoid repeating the same reason, and a `not_useful` answer suppresses reconnection until the person resets it. It is not a contact directory or a verified friendship graph.

Refresh the full context snapshot and sync to apply these choices. Put the confirmed name/contact in the context file's `policy`; use an explicit empty `school` or `contact` to withdraw that field. Historical affiliations come from the policy command. `context` reports the local choices and last sync result; a saved policy alone has not changed the server.

## Changing work, goals and willingness

Use available approved memory and the person's current statements even when Canvas is unavailable. Keep current work (`working_on`), explicit requests (`looking_for`), approved experience subjects (`experienced_in`) and explicit offers (`can_help_with`) distinct. Experience never becomes an offer automatically.

Example: a current `looking_for` label "healthcare product advice" can align with an explicit `can_help_with` label "clinical workflow advice" tagged with approved `topics: ["healthcare"]`. The network recognizes a small set of conservative aliases and exact approved subject tags; it does not understand every profession or project semantically.

Requests, offers and approved activities in alumni mode must include `confirmed_at`, the actual time the person approved them. Preserve that time on later retrieval; never manufacture a new confirmation during a check-in. Requests expire after 30 days and offers/activities after 60. Their profile can last years while they are inactive, but expired willingness cannot generate an introduction. Resume by confirming current goals, offers and activities; do not carry a two-year-old offer forward.

Use `assets/alumni-context-example.json` only as a synthetic format example. Replace every example value with genuinely approved current facts. Do not copy its example timestamps as consent evidence.

## Reconnection and follow-through

The nudge can explain a prior connection when history exists and a new current reason qualifies. Show the current approved profile under `references/introductions.md`; private contact release needs both current permissions, from answers or scoped standing setup grants under `references/update-setup.md`. A prior connection never authorizes disclosure. Standing permission expires within a year, so a two-year return requires a new approval. Only the person's own Cubbie relays their message; acknowledge delivery as in Sync. Review old profile fields when their life stage changes or they return after a gap; do not invent updates.

`python3 scripts/connect.py connections` returns `CONNECTIONS`, anonymous connection ids, introduction dates/counts and the person's own feedback. Summarize it; do not paste ids or diagnostics unprompted. After an agreed introduction, a feedback check-in needs separate approval and a bounded schedule. Ask whether they met and whether it was useful separately; contact exchange or a calendar event is not proof of either.

```sh
python3 scripts/connect.py feedback <connection-id> met
python3 scripts/connect.py feedback <connection-id> useful
```

Other explicit outcomes: `did_not_meet`, `not_useful`, `reset`. Record only the person's answer. `FEEDBACK SAVED` means their private structured feedback was stored; it is not shared with the other person. Automated negotiation, booking, meeting verification and learned ranking are not implemented.

## Pause, withdraw or leave

- Pause discovery: `policy --participating no`, then `sync`, then cancel the approved check-in after successful sync. Alumni profile/history remain only under their existing separate permission.
- Forget history: `policy --remember-connections no`, then `sync`. This removes the shared retained relationship records from both sides.
- Stop long-term retention/alumni discovery: `policy --alumni-network no`, then `sync`. This removes the durable profile/history; ordinary context retention still applies. It also returns alumni scope to school scope. An alumnus is excluded from contextual discovery while alumni permission is off.
- Full leave: use the Leaving section. It removes identity, context, durable profile and relationship history from Super Cub and cleans up Cubbie-specific memory/check-ins separately. Forget alumni affiliations, confirmation times and outcome preferences too.

## Keep the same identity on a new device

The random UUID/token is independent of university accounts and is bound until full leave. Existing valid tokens are upgraded without rotation. A privately exported backup is necessary to transfer an identity; there is no email-based account recovery if both the device and backup are lost.

Only use a supported private file-transfer capability. Never read the backup into a chat message, print its contents, or ask the person to paste credentials.

```sh
python3 scripts/connect.py identity export --file /private/user-chosen-folder/supercub-backup.json
python3 scripts/connect.py identity import --file /private/user-chosen-folder/supercub-backup.json
```

Export requires a new file in an existing folder and writes it with owner-only permissions. `IDENTITY EXPORTED` confirms creation, not that it was transferred. Transfer it privately to a fresh device. Import verifies the token against the existing service, retrieves the current remote policy/context and refuses to replace a different local identity. `IDENTITY RESTORED` means those choices were recovered; review them before syncing and renew expired intent explicitly. Request any new check-in separately. If no supported private transfer exists, explain that limitation.

The backup remains a user-managed file outside managed client state. Full leave invalidates access to the deleted records, but does not erase separately exported backup files or provider backups.

Current clients attach a context version to each sync. An older device snapshot is rejected after another device updates the profile, so it cannot silently restore withdrawn participation or offers. On `CONTEXT CONFLICT`, run `python3 scripts/connect.py refresh` to replace local choices/signals with the current remote snapshot, then reapply only the person's current explicit request. Do not reconstruct a withdrawn offer from an old file. This is an optimistic stale-write check, not transactional synchronization; older clients without version support retain legacy behavior.
