# Super Cub loop contract (current local implementation, 2026-10-24)

Root `CLAUDE.md` is product authority. This file documents the implemented protocol and its limits; it is not a claim that production or Cubbie's scheduler has been retested. Preserve the legacy request/match API alongside contextual discovery.

## Platform and transport

Cubbie is closed-source and external. It retrieves available Canvas/calendar/email event context and memory during supported interactions/check-ins; the script cannot call those abilities or automatically read entire chat histories. No native push into Cubbie is demonstrated. The client posts permitted context and pulls suggestions over HTTPS.

All person endpoints retain the compatible `X-Student-Id: <uuid>` and `Authorization: Bearer <token>` headers. The Python client also sends legacy `X-Student-Token`, but the server authenticates Bearer. New token bindings persist until leave; a valid existing binding is upgraded without rotating its UUID/token. This supports alumni continuity and is not verified school identity. Private-file identity import verifies the token and recovers the current remote profile before saving local state.

## Signals and permissions

```json
{
  "type": "working_on",
  "entity": {"kind": "assignment", "label": "CSE 310 HW4"},
  "detail": "hash tables",
  "due": "2026-10-28T23:59:00-07:00",
  "source": "canvas",
  "observed_at": "2026-10-24T08:00:00-07:00"
}
```

Types: `enrolled_in`, `working_on`, `attending`, `interested_in`, `can_help_with`, `applying_to`, `open_to`, `looking_for`, `experienced_in`. Kinds: `course`, `assignment`, `event`, `topic`, `company`, `activity`. Sources: `canvas`, `calendar`, `email`, `memory`, `student`. Optional `when` is the event start. Labels/details are at most 120 characters server-side (the client further limits labels). The server derives entity keys from labels: lowercase, punctuation stripped, whitespace collapsed; course keys also remove spaces.

Never intentionally collect transcripts, message/email prose or subjects, private calendar titles, grades, files, third-party names or fine locations. Validation blocks common grade/contact/location patterns, URLs and overlong text, and strips contact-like text from details. It cannot comprehensively detect names, private prose, truth or consent; Cubbie must review approved facts before sending.

- `attending` and **any event-kind entity** need `share_events`, including memory/student sources. Calendar/email events must also look public; email supports attending only.
- `applying_to` and any company-kind entity need `share_applications`. The current client keeps applications off and exposes no CLI flag to enable them.
- `can_help_with` requires an explicit offer to help others; `open_to` requires explicit activity approval. Both require `memory` or `student` provenance in client/server validation. Declaring that source is not proof of consent; Cubbie must check it. Finished coursework is never an offer.
- `open_to` labels: `study`, `teammates`, `rides`, `mentoring`, `meals`, `buddies`, `advising`, `collaboration`. Both people must share an approved activity; there is no inferred-kind fallback.
- `looking_for` is an explicit current request; `experienced_in` is separately approved background, never willingness. Both require memory/student provenance. Subject-bearing signals may contain up to five approved `topics`, each at most 60 characters. These get the same heuristic text checks and cannot carry private prose.
- `confirmed_at` records actual approval time for requests, offers and activities. It is required on these signals in alumni mode, cannot be more than five minutes in the future, and controls expiry even when they are synced again. Missing timestamps remain compatible for older non-alumni clients; new Skill instructions always preserve confirmation time.
- Course detail is section only, never instructor. Free windows contain start/end only, not calendar titles.

Expiry: `working_on`: due +1 day or 21 days; `attending`: when +1 day or 30 days; interests/offers/activities: 60 days; courses: 120 days; applications: 45 days; requests: 30 days; experience: 365 days, subject to the 120-day inactive context-record lifetime. Requests/offers/activities use `confirmed_at` when supplied; others use sync time. Only the minimal opted-in profile survives context expiry, with no signals or free windows. Refresh only facts Cubbie can still substantiate.

## Policy

Fresh defaults on client and server: participating **false**, discoverable **school**, intro **ask**, events/applications **false**, cap **one/week**. The server cap can be explicitly configured with `SUPERCUB_MAX_PER_WEEK` (0–7); stored explicit choices persist. A new record without a participation flag must not join discovery. An explicit opt-in requires first name; the Skill also confirms school, contact and activity choices.

Additional defaults: `life_stage: "student"`, `alumni_network: false`, `remember_connections: false`, `affiliations: []`. Affiliations are up to five approved school labels, not verified credentials. Alumni opt-in persists the minimal policy/name/contact/affiliation/time-zone profile until withdrawn or leave; it never turns participation on. Relationship retention requires its own consent from both people.

Profile-led introductions use `share_intro_profile: true` only after the person approves the displayed profile once. The storage default is false, including existing participants. `policy.intro_profile` is a replacement object with required `name` (60 chars), optional `headline` (100), `about` (240), `photo_url`, and up to three `links: [{kind:"linkedin"|"github"|"website",url}]`. URLs are public HTTPS, max 400 characters, without credentials, query strings or fragments; LinkedIn links must be profile URLs. Unsupported fields are stripped; private contact text is rejected heuristically. This profile may reveal approved information beyond shared subjects. Disabling sharing removes it and closes open introductions; changing the profile also invalidates affected open asks. Alumni retention includes this approved profile while both retention and profile-sharing permissions remain on.

```json
{"participating": true, "discoverable": "school", "intro": "ask",
 "share_events": false, "share_applications": false, "max_suggestions_per_week": 1,
 "school": "ASU", "first_name": "Alex", "contact": "alex@example.edu"}
```

`section` requires the same school and course/section detail. `school` requires the same normalized school, or a shared approved affiliation when both enabled alumni participation. New `alumni` scope requires alumni participation on both sides and a shared school/affiliation. When either person is an alumnus, both must enable alumni participation regardless of scope. `network` is explicit wider scope. Turning alumni permission off resets alumni scope to school and disables retained history. `auto_study` remains legacy metadata with no automatic acceptance behavior.

New `intro: "automatic"` requires `automatic_intro_consent`: actual ISO `approved_at`, chosen `contact`, `discoverable`, `school`, `affiliations`, `alumni_network`, `share_events`, `share_applications`, approved `activities` and `max_suggestions_per_week`. The snapshot must match contact/scope and cannot permit a higher cap than approved. Permission lasts at most 365 days, never refreshes by sync, and covers only listed activities. Freshness/caps/scopes/cooldowns still apply. Contact/scope/cap expansion clears a stored grant and returns to ask-first unless a new matching approval is supplied. Future approval beyond five minutes is rejected. No old `auto_study` metadata is promoted to this permission.

## Endpoints

- `GET /api/capabilities`: public constant `skill_release` and feature list; no student data read or changed. One-time setup requires the matching `2026-10-profile-intros-v3` release. Setup PUTs include `client_release`; mismatches fail before mutation, and matching responses confirm release/intro mode. Older compatible calls without this field preserve their response shape.

- `PUT /api/context`: `{policy?, signals?, free?, tz?, replace_signals?}`; max 60 signals/call, 200 stored, 10 windows. Validates and upserts by type/key by default; `replace_signals: true` replaces the signal snapshot (the current client uses this to honor retracted offers/preferences). Replaces free windows when supplied. Drops expired/no-longer-permitted signals; opt-out clears signals/free and participant index. Permission restrictions/removals close open suggestions before rediscovery. Returns `{accepted, rejected:[{index,reason}], signals_total, open_suggestion}`. Repeated calls refresh facts without duplicating records.
- `GET /api/context`: authenticated current policy, fresh signals/free windows, time zone and last update; falls back to a retained alumni profile after context expiry. Used for identity restoration. Never returns another person's profile.
- `GET /api/suggestions`: `{ask: {id,text,kind,shared,expires_at}|null, agreed:[{id,first_name,contact,when,text}], nothing_new}`. At most one ask. The current client sends `X-Supercub-Delivery: acknowledged`; fetched messages remain pending until explicit acknowledgment. Headerless legacy clients retain fetch-as-delivered behavior for agreed outcomes. Open suggestions are rechecked against current scope, participation, approved activities and fresh evidence.
- `POST /api/suggestions/:id/delivered`: `{kind:"ask"|"agreed"}` after a successful relay. Only a member of that suggestion can acknowledge it. The acknowledgment is an assistant report, not an independent transport/read receipt. `later` clears ask delivery state so it can be relayed again.
- Approved profile asks additionally include `profile`, `other_accepted` and `you_accepted`. The server inserts the approved name into the anonymous stored relevance text at read time and uses "Want an intro?" or, after an actual first yes, "They've already said yes. Want the intro?" Phone/email are absent until mutual acceptance. `GET /api/suggestions?id=<uuid>` returns an owned, currently permitted open ask for follow-up questions without consuming delivery or accepting it; the client exposes this as `preview ID`.
- `POST /api/suggestions/:id/answer`: `{answer:"yes"|"no"|"later"}`. Returns waiting, agreed (+contact/time), passed, or later (+ask_again_at). Errors cover missing/closed/expired/already answered. Later re-asks after 24 hours once; a second later passes. No cools the pair for 30 days.
- `POST /api/discover`: optional bulk discovery; uses `X-Discover-Secret`, configured by `DISCOVER_SECRET`. Does not send notifications or wake Cubbie. No scheduled cron is established by the existence of this handler.
- `GET /api/connections`: the caller's retained anonymous connection ids, first/latest introduction dates, counts and own feedback; no peer identifiers, contacts or peer feedback.
- `POST /api/connections`: `{id, outcome:"met"|"did_not_meet"|"useful"|"not_useful"|"reset"}` for an owned retained connection. Explicit self-report only; `not_useful` suppresses reconnections until reset.
- Legacy `POST /api/requests`, `GET /api/matches`, `POST /api/respond`: direct request matching remains intact. Names/topics/offers appear under separate join consent; contacts only after both accept.
- `DELETE /api/me`: deletes contextual and legacy server records for the identity. Client leave additionally deletes its identity/state/policy/context. Cubbie separately cancels check-ins and forgets Super Cub-specific memory. No promise about all Cubbie history/backups or recalling released contacts.

Local policy edits reach the server only after a successful sync. A failed sync/deletion is not a successful revocation/deletion. Opt-out preserves the policy record and may retain historical suggestion outcomes; full leave removes those. Direct requests are independent of contextual participation.

Current clients send `context_version` on PUT (null for a new identity). Each successful context write returns a new opaque version to version-aware clients; GET context returns the current version for import/refresh. A stale version receives 409 before changes are applied. The opaque version is retained until leave, independently of signal expiry. `refresh` recovers the current remote snapshot before applying a person's current explicit request. Headerless/versionless older clients remain compatible. This read/check/write guard does not replace cross-record transactions or guarantee ordering of simultaneous writes.

Alumni profile/history retention is separate from a participation pause. Disabling alumni or history permission deletes the appropriate durable records; ordinary context/suggestion retention still applies. Full leave additionally deletes profile, relationship records and peer history indexes. No deletion promise covers separately exported identity backup files.

## Discovery and judging

Candidates must participate, satisfy both scope settings, share an approved activity and an entity/aligned subject, have no open suggestion/pair cooldown and remain under caps. Rules score (capped at 1): shared course +0.3; course-to-assignment link +0.3 in addition to course; shared work +0.5 and both due within 7 days +0.1; shared event +0.3 and upcoming within 14 days +0.1; shared interest +0.2; explicit offer/need overlap +0.6; shared activity +0.15; hour of overlapping free time +0.1. Minimum 0.5; up to three candidates go to the judge. A course embedded in an assignment title is a link, not proof of enrollment or ability.

`concepts.ts` aligns a finite set of subject aliases (such as voice AI/speech recognition) and exact approved topic tags. It does not infer arbitrary semantic similarity or willingness from experience. Directional `can_help_with` ↔ `looking_for`/`working_on`/`interested_in` evidence survives model-input filtering. The judge gets bounded shared views and structured evidence with optional relative deadline/event timing, never one-sided project labels.

Optional Anthropic/Bedrock judge receives restricted shared labels/types, not identity, contact, free-text details or raw source material. Model worth threshold is 0.6. Low-worth pairs cool for six hours; absent/failed model uses rules text. Text guards block common leaks and known one-sided entity labels but do not prove arbitrary paraphrases true. No unsupported expertise/enrollment assertions should be added. Defaults/model IDs are implementation configuration in `judge.ts`, not a guarantee of current provider availability.

A suggestion normally expires after 48 hours; later extends it. Both specific answers or currently covering standing permissions release chosen contacts and an optional >=60-minute overlapping window with >=30-minute lead. This is a proposed time, not a booking or proof of meeting. Cross-record concurrency is not transactional; one-open-suggestion and concurrent-answer guarantees have limits.

For new automatic mode, each side can supply a valid standing setup permission. Its snapshot in `side_*.standing_consent` is not a fabricated `answer: yes`. Two covering permissions can complete on discovery; mixed pairs ask the manual side. No/later before completion overrides standing permission for that suggestion. Agreement revalidates scopes/freshness/permission. Contact/intro/grant/cap changes close affected open suggestions. Agreed views include consent source, approved profile and connection reason, never a false claim of a match-specific yes. Unfetched automatic contacts are not served after standing permission is revoked or the current scope stops permitting them; already fetched/relayed/provider-queued information cannot be recalled. Legacy direct requests are unchanged.

If both consented to retained connections, agreement stores a relationship with dates/count, a hashed reason signature and private per-person feedback, capped at 200 relationships/person. No old signals or contacts are stored in that history. Rediscovery requires a different current reason signature, expired cooldown, fresh compatible intent and both people's current permissions. Resync timestamps and changing deadline offsets alone are not new reasons. A reconnection uses the same current profile-sharing permission as any other introduction; the prior connection never grants new disclosure rights automatically.

## Client and verification

`policy` saves local flags (including `--intro ask` revocation, alumni/history/stage/affiliations and `--max-per-week`); `sync [--file PATH]` posts context and pulls results; `answer ID yes|no|later` sends answers; `delivered ID ask|agreed` acknowledges relay. `connections`/`feedback` manage history. `identity export|import --file PATH` privately transfers identity and recovers current remote choices. `context` shows setup release, prepared introduction mode, local choices/signals and last counts; `leave` removes managed state after success. `check`/`status` remain direct-request commands. The client is standard-library-only with bounded output.

Use `supercub/SKILL.md` for the exact approved setup and relay flow. A requested two-hour check-in is an intended operating cadence, not a verified unattended integration.

`setup --file PATH --approved-at ISO` is the bundled update command, run only after the person approves the displayed summary. It verifies host metadata, preserves UUID/token, prepares the contact/scope/activity grant when requested, syncs, then records the completed release locally. The metadata timeout is five seconds so the setup remains inside the client's bounded script budget. An old host does not authorize new features; existing choices are unchanged when compatibility fails before sync. `SETUP COMPLETE` confirms this release/mode synced, not that every proposed fact was accepted or an actual message was delivered.

Local Vitest/unittest suites use synthetic students and stubs/in-memory handlers, including real Python-to-handler protocol tests and mocked judge calls. Prior notes report real install/HTTPS, three real account context uploads and one real-to-synthetic suggestion; hosted full loops used synthetic participants. Unattended memory+connected-data syncing and a true real-to-real introduction still need evidence. No live seeding or deployment without explicit approval.
