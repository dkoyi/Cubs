# Super Cub loop contract (v1, 2026-10-24)

The one loop we are proving: extract context → preserve it → discover relationships → proactively nudge → coordinate an outcome. Two builders work from this file: one on `server/`, one on `supercub/` + `tests/`. Neither edits the other's folder. This file is the only shared truth; if it is wrong, change it here first.

## Verified platform boundaries that shape this

- A Skill runs only when the student texts something that triggers it or when a scheduled check-in it created fires. Nothing can push into Cubbie.
- During a run, Cubbie (not the script) reads Canvas, Calendar, email events and its own memory, then hands results to the script as arguments or a file. Scripts cannot call Cubbie abilities.
- Scripts can make outbound HTTPS to any host and keep files under HOME.
- Cubbie cannot message another student or another Cubbie. The server is the only meeting point.
- Conversations the student has with Cubbie outside our Skill are not observable. The legitimate bridge is Cubbie's own memory: at sync time Cubbie lists what it remembers the student is working on, interested in, can help with, attending and (if allowed) applying to.

## Identity and auth (unchanged, reuse)

Headers `X-Student-Id` (uuid) and `X-Student-Token` as today. Trust on first use, token bound to id. All new endpoints require them. `DELETE /api/me` must now also wipe context, suggestions and answers for the student.

## Signal schema

```json
{
  "type": "enrolled_in | working_on | attending | interested_in | can_help_with | applying_to | open_to",
  "entity": { "kind": "course | assignment | event | topic | company | activity", "key": "<server normalizes; client sends label>", "label": "CSE 310" },
  "detail": "optional short free text, max 120 chars, e.g. 'HW4 hash tables' or 'section 12345, Prof. Ortiz'",
  "when": "optional ISO start for events",
  "due": "optional ISO due date for assignments",
  "source": "canvas | calendar | email | memory | student",
  "observed_at": "ISO"
}
```

`open_to` entities are activities: `study`, `teammates`, `rides`, `mentoring`, `meals`, `buddies`.

Never accepted by the server (reject with reason, never store): grades, scores, email bodies or subjects, calendar titles that are not public-looking events, names of other people, locations finer than campus, free text over 120 chars. The server strips anything that looks like an email address or phone number from `detail`.

Freshness: `working_on` expires at `due` + 1 day or 21 days; `attending` at `when` + 1 day or 30 days; `interested_in`, `can_help_with`, `open_to` 60 days, refreshed on each sync; `enrolled_in` 120 days; `applying_to` 45 days. Re-sending the same (type, entity.key) refreshes `observed_at`.

Entity key normalization on the server: lowercase, collapse spaces, strip punctuation; course codes also strip spaces ("CSE 310" and "cse310" are one key); events keep words; topics singularize nothing, just lowercase.

## Policy (per student, stored with context)

```json
{
  "participating": true,
  "discoverable": "section | school | network",
  "intro": "ask | auto_study",
  "share_events": false,
  "share_applications": false,
  "max_suggestions_per_week": 1,
  "school": "ASU",
  "first_name": "Apoorv",
  "contact": "optional; same tiers as today, released only after both yes"
}
```

Defaults: participating true once the student said yes in chat, discoverable `school`, intro `ask`, share_events false, share_applications false, one suggestion a week.

## Endpoints (new) — Builder A

### PUT /api/context
Body: `{ "policy": {...}, "signals": [ ... up to 60 ... ], "free": [ {start,end} up to 10, ISO with offset ] , "tz": "America/Phoenix" }`
Behavior: validate, normalize, merge into the student's context record (upsert by type+entity.key, refresh observed_at, drop expired), store policy, store free windows (replace), then run discovery for this student against all other participating students (see below). Respond `200 { "accepted": n, "rejected": [{ "index": i, "reason": "..." }], "signals_total": n, "open_suggestion": true|false }`.
Idempotent. 60 signals max per call, 200 stored per student.

### GET /api/suggestions
Returns at most ONE suggestion to relay now, plus any agreed outcomes:
```json
{ "ask": { "id": "...", "text": "Someone in your CSE 310 section is working on HW4 too and is open to studying with classmates. Want me to see if you'd both like to connect?", "kind": "study", "shared": ["enrolled_in:cse310", "working_on:hw4"], "expires_at": "ISO" } | null,
  "agreed": [ { "id": "...", "first_name": "Jordan", "contact": "+1 ...", "when": {start,end} | null, "text": "You're on. Jordan said yes too. Thu 7 to 8 pm." } ],
  "nothing_new": true|false }
```
Marking a suggestion as asked happens here (status proposed → asked_a / asked_b). A suggestion already asked and unanswered is returned again only if `expires_at` has not passed (48 h), otherwise expired.

### POST /api/suggestions/:id/answer
Body `{ "answer": "yes" | "no" | "later" }`. Responses: `{ "status": "waiting" }` (other side not yet answered), `{ "status": "agreed", "first_name", "contact", "when", "text" }`, `{ "status": "passed" }`. "later" re-asks after 24 h once. On "no", both sides are cooled down for that pair for 30 days.

### POST /api/discover (optional, for a Vercel cron hourly)
Runs discovery across all participating students. Protected by `DISCOVER_SECRET` header. Not required for the demo; discovery already runs on each PUT /api/context.

## Discovery — Builder A

1. Candidate pairs: students who both participate, discoverability compatible (`section` requires a shared enrolled_in with the same detail/section; `school` requires same `school`; `network` anything), share at least one entity key, no open suggestion for either, no suggestion between them in the last 30 days, each under their weekly cap.
2. Rules prefilter score (0 to 1): same course +0.3; same assignment due within 7 days +0.3; same event within 14 days +0.3; one's `can_help_with` matches other's `working_on`/`interested_in` topic +0.3; both `open_to` a compatible activity +0.2; free windows overlap ≥ 60 min in next 7 days +0.1. Keep pairs ≥ 0.5, top 3 per student.
3. Relevance judge: if `ANTHROPIC_API_KEY` or AWS Bedrock credentials are present, call a model with BOTH students' signals that are mutually allowed (both have shared that signal type) and ask for JSON `{ "worth": 0..1, "why": "...", "text_for_a": "...", "text_for_b": "..." }`. Hard rule in the prompt and enforced in code: the texts may mention only entities present in both students' signals; never names; never contacts. Threshold 0.6. Model via env `SUPERCUB_MODEL` (default `claude-opus-5-5` on Bedrock, `us-east-1`; Anthropic API if `ANTHROPIC_API_KEY` set). Without credentials, fall back to a template text built from the shared entities, and log `judge: rules`.
4. Create one `suggestion` record `{ id, a, b, kind, shared, text_a, text_b, why, score, status: proposed, created_at, expires_at }`. One open suggestion per student at a time.
5. On both yes: pick a meeting window from the intersection of both free lists (≥ 60 min, ≥ 30 min lead), release first names and contacts to each other, status `agreed`. Reuse today's contact release code path.

Logging: every judge call stores `why` and `score` on the suggestion so the demo can show the reasoning.

## Skill — Builder B

Add a `## Sync` section to `supercub/SKILL.md` and new `connect.py` subcommands. Keep every existing flow (direct asks, matching, noticing, leave) working.

### First-time setup (asked once, remembered in Cubbie memory)
1. "Super Cub can also notice connections on its own. It would share a few facts about your classes and what you're working on with the Super Cub network, never your grades, emails or messages, and only suggest a connection when both people say yes. Want in?" → participating.
2. If yes: "Who should be able to be matched with you: people in your classes, anyone at your school, or anyone on Super Cub?" default school.
3. "Can I share names of public-looking events from your calendar and email, like hackathons and career fairs? Yes or no." → share_events, default no.
4. "How often should I sync and check for suggestions? Every 2 hours works for this week." Create ONE scheduled check-in named so it stands alone later: "supercub: sync. Run the Sync section of the supercub Skill." Student picks interval; default every 2 hours. This check-in replaces the separate noticing and matching check-ins when participating (one check-in does all three).

### Sync steps (what Cubbie does each run)
1. Gather, using Cubbie's own abilities: Canvas courses (code, name, section, instructor), assignments due in the next 14 days (title, due); Calendar free blocks ≥ 60 min in the next 7 days during 8 am to 11 pm; if `share_events`, event names in calendar and email events that look like public events (hackathon, career fair, club, talk, workshop); from memory: what the student is working on, interested in, can help with, and is open to; applying_to only if `share_applications`.
2. Write them as JSON to `~/.config/supercub/context.json` matching the signal schema. No grades, no email subjects, no people's names, no private calendar titles.
3. Run `python3 scripts/connect.py sync --file ~/.config/supercub/context.json`. The script PUTs context, then GETs suggestions, then prints ONE of: `NOTHING NEW`, `ASK <id>\n<text>`, `AGREED\n<text>\n<contact>`, or `ERROR. ...`.
4. If `ASK`: text the student exactly the text, then on their reply run `python3 scripts/connect.py answer <id> yes|no|later` and relay (`WAITING` → "I'll let you know what they say.", `AGREED` → the text plus contact, offer calendar, `PASSED` → "No problem.").
5. If `NOTHING NEW`: say nothing during a scheduled run.
6. Also run the existing `check` for direct requests in the same sync and combine into one message if both have something.

### New connect.py commands
`sync --file PATH` (PUT context then GET suggestions, prints as above), `answer ID yes|no|later`, `policy --participating yes|no --discoverable section|school|network --share-events yes|no` (stores locally and sends with next sync), `context` (prints what is currently stored locally and the last server `accepted`/`rejected` counts, for debugging), `leave` extended to also delete `context.json`.

Script constraints: Python 3.12 standard library only, no network except SERVER_URL, HTTPS only, output under 8,000 chars, every error path prints a one-line `ERROR.` code that SKILL.md maps to a friendly sentence. Strip emails and phone numbers from any `detail` before sending as a second guard.

## Tests

- Builder A: vitest unit tests for normalization, freshness, reject list, prefilter scoring, judge fallback, suggestion lifecycle, answer paths, delete wipes everything. An in-process two-student scenario: both PUT identical course + assignment signals, GET returns one ask each, both answer yes, both GET agreed with contact. Plus the model judge mocked.
- Builder B: unittest for `sync`, `answer`, `policy` against a stub HTTP server; a fixture `context.json`; a guard test that a signal containing an email or phone is stripped; validator run on `supercub/` passes.
- Integration (after both land): the existing pattern of running the real `connect.py` against in-process handlers, extended with the sync scenario.

## Experiment plan (five real accounts)

1. Push the updated Skill. Each friend texts "update supercub" (or installs), answers the four setup questions, picks every 2 hours.
2. Over the evening their Cubbies sync Canvas, calendar, memory. Server discovers shared course/assignment/event. Next sync delivers one ask to each side. Both yes → agreed, contacts, time.
3. We watch `why` and `score` on the server to show reasoning in the video.
4. Fallback if the model judge has no credentials: rules text; still proves the loop.

## Open items for Apoorv (not blockers for building)

- Model credentials for the judge on Vercel: either `ANTHROPIC_API_KEY`, or AWS keys from the sandbox2025 account with Bedrock invoke rights (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION=us-east-1`). Without them the server uses rules text.
- Real-account checks tonight (run in the Opus chat): can a scheduled check-in read memory + Canvas and write a file the script reads; will Cubbie accept a 2-hour check-in; does "what do you remember about me" return useful working_on / interested_in facts.
