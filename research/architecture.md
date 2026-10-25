# Super Cub architecture and evidence (2026-10-24)

Read root `CLAUDE.md` for product authority; `loop-contract.md` describes the current wire contract. This document describes the local implementation, not a fresh verification of production deployments.

## Data flow

```
Student / alumnus → own Cubbie (closed-source, external)
            │ supported interaction or requested check-in
            │ retrieve available connected data / memory
            │ minimize to approved structured signals
            ▼
        Super Cub Skill / connect.py
            │ HTTPS: student UUID + Bearer token
            ▼
        Existing Vercel server ↔ Upstash Redis
            │ context + permission + freshness → discovery → relevance judge
            │ GET suggestions / POST answers or valid standing setup permissions
            ▼
        Own Cubbie relays nudge / chosen contact / possible shared slot
            │ acknowledges successful relay; asks before a supported calendar action
            ▼
        Optional self-reported outcome → retained relationship → new-reason reconnection
```

The network is standalone; the Skill is its Cubbie integration. No direct Cubbie-to-Cubbie messaging, native inbound push or continuous chat observation is established. Scripts cannot call Cubbie's abilities. Server discovery can run on context upload, or through a protected discovery endpoint; neither wakes a Cubbie. Retrieval and delivery depend on a Cubbie interaction/check-in and available tools.

## Existing components to keep

| Component | Responsibility |
|---|---|
| `supercub/SKILL.md` | Source retrieval/minimization instructions, explicit consent, relay, check-in requests and memory cleanup |
| `supercub/scripts/connect.py` | HTTPS client, durable local UUID/token, policy, context preparation, polling and answers |
| `server/src/signals.ts` | Typed schema, restrictive fresh policy defaults, permissions, validation and expiry |
| `server/src/discovery.ts` | Compatible scope, shared entities, prefilter, rules text and model text guard |
| `server/src/judge.ts` | Optional Anthropic/Bedrock relevance adapter; restricted shared label/type input, rules fallback |
| `server/src/loop.ts` | Context, participants, suggestion lifecycle, cooldown/caps, consent and contact release |
| `server/src/concepts.ts` | Conservative subject aliases and approved tags; no inference of willingness |
| `server/src/continuity.ts` | Opted-in long-lived alumni profile, relationship fingerprints and private outcomes |
| `server/src/service.ts`, `match.ts` | Existing direct-request registry, matching, identity and consent |
| `server/src/store.ts`, `handlers.ts`, `api/` | In-memory/Upstash stores, HTTP handlers and Vercel adapters |

Existing services remain `supercub-server.vercel.app` and `supercub-site.vercel.app`; repository `dkoyi/Cubs`, branch `main`. No replacement service, credential rotation or data migration is required by this correction.

## Storage and disclosure

- Cubbie-specific memory belongs to Cubbie; this repository cannot inspect or wipe its entire memory/history. The Skill asks Cubbie to remember only approved Super Cub preferences and forget them on leave.
- Client identity/policy/state use the existing `SKILL_DATA_DIR` or `~/.campus-connect/`; the context snapshot lives at `~/.config/supercub/context.json`. Existing identity locations are preserved. Optional owner-only private-file export/import transfers identity independently of university accounts; import loads current remote choices rather than an old backup policy.
- Redis contains context policy, permitted signals, free windows, requests, suggestions/matches and consent state. Contacts are stored server-side and released only under each person's explicit answer or a covering bounded setup permission. Unanswered suggestions are never silently marked yes.
- Contextual asks show an approved introduction profile before acceptance; valid standing setup permissions can complete a contextual intro without another ask. Unapproved/legacy profiles stay anonymous; direct request proposals retain their separate disclosure and two-answer contract. Profiles are read-time views, not stored in suggestion text or sent to the judge.
- Fresh participation is off; scope is school; events/applications off; introduction always asks; normal cap one/week. Section scope also requires the same school. Older explicit stored choices are not globally reset by these changes.
- Turning sharing off prunes corresponding stored context and closes affected open suggestions on the next successful sync. Full leave deletes client identity/policy/state/context and server records, while Cubbie separately cancels check-ins and forgets approved Super Cub memories. Previously released contacts cannot be recalled.
- Validators are heuristic. They do not prove arbitrary labels contain no names/private prose, nor verify the origin of a client-declared memory fact. Do not describe validation as comprehensive semantic privacy enforcement.
- `auth:{sid}` binds a hashed token until leave; valid older bindings become durable without rotation. `profile:{sid}` retains only opted-in alumni policy/name/contact/affiliations/time zone. Current signal snapshots still expire after 120 inactive days; returning after two years recovers affiliation but needs fresh intent.
- `relationship:{a}:{b}` plus indexes retain dates, count, a reason hash and private structured feedback only when both opted in. Each person can retain up to 200 relationships. Withdrawal removes shared history. Reconnection needs fresh compatible activities, alumni permission where applicable, cooldown/cap checks and both current intro permissions; a prior connection never establishes those.
- The current client sends `X-Supercub-Delivery: acknowledged`; delivery state changes after `POST .../delivered`. Headerless old clients keep their earlier behavior. This enables retries after interrupted fetches but still relies on the assistant to report relay honestly.

## Evidence and remaining blockers

Prior notes report installation/HTTPS on real Cubbie accounts, three real-account context syncs and a real-to-synthetic suggestion. Hosted complete loops used synthetic participants. These reports have not been independently reproduced in this local review.

Automated tests use synthetic students, localhost stubs, in-memory stores and mocked judge responses. They verify the client/server protocol, validation and consent paths; they do not exercise Cubbie's scheduler, memory retrieval or phone delivery.

`continuity.test.ts` simulates multi-year inactivity, graduation, new complementary goals, expiring willingness, privacy withdrawal and reconnections. The Python-to-handler contract additionally exercises alumni policy, private identity transfer, acknowledged relay and outcome feedback. These establish local protocol behavior, not real alumni adoption or unattended Cubbie operation. See `alumni-lifecycle.md` for acceptance scenarios.

Required integration evidence still missing:

1. A student approves a bounded check-in; it fires unattended and retrieves a newly stated fact plus available connected data.
2. Only the approved signal reaches the server; the next supported Cubbie run retrieves and relays a suggestion.
3. Two real students accept; each receives the other's chosen contact. Record whether a calendar action and actual meeting occurred separately.

Use consenting test accounts and inspect only their own evidence. No live seeding, production record access or publication is authorized by a local test run. General rate limiting, cross-record concurrency guarantees, coordinated negotiation, meeting verification and learned outcome ranking remain separate future work.
