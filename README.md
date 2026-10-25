# Super Cub

**Cubbie understands your evolving life. Super Cub discovers when it becomes relevant to someone else's, at university and beyond, using only approved structured signals.**

Super Cub is a standalone, consent-based contextual intelligence network, integrated with closed-source [Cubbie](https://cubbie.ai) through a Skill. Built for the Cubbie Hackathon. Root [`CLAUDE.md`](CLAUDE.md) is the authoritative product and development guidance.

## The product

A student's projects, interests, deadlines and goals change. When Cubbie can retrieve relevant context, it can turn approved facts into short signals. Super Cub compares those signals across participating students, judges whether an intersection matters, and returns a nudge for each student's Cubbie to relay. Contacts require each person's explicit permission: an introduction answer or a valid standing setup grant for automatic contextual introductions. A possible shared time is not a booking.

A shared assignment, a project and an explicit offer to help, or an approved event can be a starting point. Direct requests for study partners, teammates, rides, meals and buddies remain supported. Proactive contextual discovery is the main direction; request matching is a fallback.

Caddy inspires proactive assistance, Instinct execution, and Boardy contextual connections. Coordinated follow-through is the goal; the Skill offers a calendar action after mutual consent.

University is the starting community. With separate opt-in, a minimal alumni profile and identity can persist for years while requests, offers and availability expire. A graduate building a healthcare product can later connect with someone from their university who has explicitly offered relevant advice. Both approve the introduction, even if they connected before.

The local alumni implementation includes independent UUID/token identity with private-file transfer, approved school affiliations, explicit current requests and experience subjects, subject aliases/tags for complementary discovery, and optional relationship history. A remembered connection is proposed again only for a new reason and current permission; private self-reported meeting/usefulness feedback can suppress unwanted reconnections. Automated negotiation, booking, meeting verification and learned ranking remain future work.

## Context and consent

Super Cub has no automatic access to entire Cubbie chat histories. During supported interactions or check-ins, Cubbie retrieves whatever connected data and memory it can actually access, and prepares approved signals. The Python client cannot read Canvas, Google integrations or Cubbie memory itself.

- Participation starts **off**. After an explicit yes, defaults are **school-only discovery**, **ask for each introduction**, **events off**, **applications off**, **alumni continuity/history off**, and **one suggestion per week**. A student can explicitly choose broader discovery or event sharing.
- Setup describes courses/sections, assignment titles and due dates, short approved memory facts and free windows. It confirms activity preferences and the contact to store for release after mutual consent. A chat mention, install approval or assumed phone number is not sharing permission.
- `can_help_with` means the student explicitly offered to help others. Course completion, grades and inferred expertise never establish willingness to tutor.
- A shared approved activity is required. Alumni requests expire 30 days after their actual confirmation; offers and activity preferences expire after 60. Syncing alone does not renew them. Both people must approve alumni participation when either is an alumnus; missing affiliation evidence does not broaden discovery.
- No transcripts, messages, email bodies/subjects, private calendar titles, grades, Canvas files or third-party names belong in signals. Public event labels require event permission even if Cubbie remembers them from a conversation.
- Validation limits types and lengths, blocks common grade/contact/location patterns and strips contact-like text from details. These are heuristic guards; the server cannot reliably recognize arbitrary names, private prose, or whether Cubbie truly obtained consent. Cubbie must minimize and review signals before sending them.

Introductions are profile-led: show an approved display name, headline, short bio and public profile links and explain why the connection fits. Ask-first people answer "Want an intro?"; people who expressly approve automatic contact sharing can receive an introduction without another prompt when both permissions cover it. Optional public photo URLs can be relayed through supported messaging capabilities. Existing participants are not silently opted into expanded disclosure. Anonymous introductions remain available when profile sharing is off; public links can provide a public contact route.

The bundled local release `2026-10-profile-intros-v3` adds a one-time catch-up setup: show the current choices, obtain the person's actual approval, verify server compatibility and sync without rotating identity. Automatic permission covers the exact contact, scope and listed activities for at most 365 days; syncing never renews it. Contact/scope changes or `policy --intro ask` revoke it after successful sync. Help offers and context still need to be fresh. See [`supercub/references/update-setup.md`](supercub/references/update-setup.md). Neither the release nor standing permissions have been deployed in this work.

Profiles are composed from the current approved data when the suggestion is read, rather than copied into stored model text. Profile withdrawal removes that data and closes affected open introductions. A "Who is it?" or "Link?" follow-up retrieves current details without restarting a search. The legacy direct-request path still shows first name/topic/offers under its separate join consent. A configured model judge receives restricted shared evidence, not names, profile prose, private contact details or transcripts.

## What exists and what has been proven

| Evidence | Status as of October 24, 2026 |
|---|---|
| Local implementation | Context intake, policy, expiry, complementary discovery, mutual consent, acknowledged relay, durable opt-in alumni profiles, identity transfer, retained connections/feedback, deletion, and legacy matching. |
| Recorded real Cubbie results | Prior project notes report install from GitHub after consent, HTTPS access, three real accounts syncing Canvas/memory signals, and a real student receiving a suggestion against a synthetic participant. Not independently rerun in this review. |
| Recorded hosted smoke tests | Full two-yes contact-release loops used synthetic participants on the live server. They do not establish a real-to-real introduction. |
| Local automated tests | Synthetic students, stub HTTP services and in-memory handlers; model API calls are mocked. Includes simulated multi-year alumni lifecycles and the real Python client against local server handlers. |
| Unverified integration | An unattended scheduled check-in retrieves newly learned conversational context plus connected data, syncs, and relays a suggestion without manual prompting. |
| Unverified human outcome | Two real students both accept, receive contacts and coordinate a meeting. |

There is no demonstrated native push into Cubbie. Suggestions are pulled during supported student interactions or check-ins. A server discovery run alone cannot wake Cubbie, and setting a two-hour schedule does not prove that it fires or has the required retrieval abilities.

The current client acknowledges a message after Cubbie reports a successful relay, so an interrupted fetch can be retried. This is not an independent transport/read receipt. The alumni and bundled automatic-introduction additions are local and unpublished; see [`research/alumni-lifecycle.md`](research/alumni-lifecycle.md) for the lifecycle and acceptance checks.

## Try the existing hosted version

Text this link to your Cubbie: https://github.com/dkoyi/Cubs/tree/main/supercub

Approve installation, then review the separate sharing/setup question. A student can request a sync or ask directly, for example: “I'm working on hash tables in CSE 310.” A check-in can be requested if Cubbie supports it, but unattended syncing remains unverified. Local corrections in this checkout will not reach installed Skills or hosted services until separately approved and published.

Text “leave super cub” to ask Cubbie to delete Super Cub server records and client state, cancel check-ins and forget Super Cub-specific memory. Deletion requires a successful server response; it does not erase Cubbie's entire conversation history or establish a provider backup-retention guarantee. Turning participation off stops contextual discovery after a successful sync; direct requests require full leave to remove.

## For developers

The new [`agents/`](agents/README.md) runtime adds persistent private memory boxes, source/temporal retrieval, bounded wall-clock check-ins, optional AI replies, approved projections into the same network engine, and a LoopMessage iMessage connector. Run `SUPERCUB_AGENT_SEED=100 node agents/run.mjs` for the local console at `http://127.0.0.1:4318`. Live messaging, cloud storage, Gmail account access and AI source processing require explicit configuration; no real provider delivery or deployment is claimed.

An isolated Messages-inspired demo is available in [`demo/`](demo/README.md). Run `node demo/run.mjs` and open `http://127.0.0.1:4317`. It uses the actual discovery/consent engine with simulated personal assistants, clearly separates sourced ASU backgrounds from fictional intent, and makes no production writes or real messaging calls.

- `supercub/`: Skill instructions and Python standard-library client.
- `server/`: existing TypeScript Vercel Functions and Upstash store; optional Anthropic/Bedrock relevance judge with rules fallback.
- `site/`: install page. Existing hosts: `supercub-server.vercel.app` and `supercub-site.vercel.app`.
- [`research/loop-contract.md`](research/loop-contract.md): wire contract and privacy boundaries.
- [`research/architecture.md`](research/architecture.md): data flow and integration blockers.
- [`research/agent-network-audit.md`](research/agent-network-audit.md): product gaps and acceptance evidence.
- `TECHNIQUES.md`: historical work log; older plans are superseded by current guidance.

From `server/`, run `pnpm typecheck` and `pnpm test`. From the root, run `python3 -m unittest discover -s tests -v`. Dependencies are pinned in `server/pnpm-lock.yaml`.

Preserve the deployed registry, identities, matching and consent infrastructure. Known limits include concurrent pairing/answer races without a transaction across records, heuristic text validation, a finite alias vocabulary, no general rate limit, and no learned outcome ranking. No commit, push or deployment without explicit user approval.
