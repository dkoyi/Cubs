# Super Cub product audit (2026-10-24, reconciled)

Authority: root `CLAUDE.md`. Current protocol: `loop-contract.md`. This replaces the obsolete pre-context build assessment; historical implementation decisions remain in `TECHNIQUES.md`.

## Product

Super Cub is a standalone consent-based contextual intelligence network integrated with closed-source Cubbie. Cubbie understands one student's evolving life; the network discovers meaningful intersections across permitted structured signals, nudges each student through supported Cubbie interactions/check-ins, obtains mutual consent, and aims to coordinate follow-through.

University is the starting community. The local alumni extension supports separately approved continuity after graduation: a durable identity/affiliation profile, current requests and offers, complementary subject alignment, and relationship-aware reconnection years later. A retained affiliation never implies current availability or renewed consent.

Caddy inspires proactive assistance, Instinct execution, Boardy contextual connections. They are inspirations, not integrations or evidence of implemented execution. Matching supports discovery and remains a direct-request fallback. Students need not submit a request for the contextual path.

## Code versus evidence

| Need | Local implementation | Evidence / gap |
|---|---|---|
| Evolving context | Typed signals with sources, expiry, policy and repeated sync | Prior notes report Canvas/memory syncs from three real accounts; ongoing unattended capture remains unverified |
| Contextual discovery | Shared entities, scoring, rules/model judging, caps, cooldowns | Covered with synthetic local tests; prior notes report one real-to-synthetic suggestion |
| Proactive delivery | Client pulls during a Cubbie interaction/check-in | No demonstrated native push; unattended scheduler/retrieval/relay still needs real-account evidence |
| Consent and identity | UUID/token registry, two-sided answers and scoped standing setup grants | Local mixed/automatic loops are synthetic; hosted standing permissions and real-to-real outcomes remain unverified |
| Restrictive sharing | Opt-in, school scope, events/applications off, explicit offers/activity approval | Client and server guard common errors; Cubbie still must verify permission and minimize text |
| Follow-through | Contacts and possible shared slot; calendar offer; private self-reported meeting/usefulness feedback for retained connections | Automated negotiation, meeting verification and learned ranking absent |
| Alumni continuity | Durable opt-in profile, identity backup/import, expiring confirmed intent, optional relationship history | Simulated multi-year local lifecycle; real alumni deployment/adoption unverified |
| Complementary discovery | Explicit requests/offers survive model filtering; conservative aliases and approved subject tags | Finite vocabulary, not general semantic retrieval; relevance needs human evaluation |
| Relay reliability | New client acknowledges successful relay; unacknowledged messages can be fetched again | Assistant acknowledgment is not an independent transport/read receipt |

The old claim that the discovery path did not exist was outdated. The opposite claim that a two-hour sync instruction proves unattended real Cubbie operation is also unsupported.

## Privacy decisions

- Approval to install, a chat mention and retrieved memory are not approval to publish. Participation starts off; show the sharing scope and get a yes.
- Default discovery is school-only. Section matching additionally needs matching school and section evidence. Missing information never broadens the scope.
- Event sharing is off regardless of whether the source is calendar, email, memory or student text. Applications remain off in the current client.
- Courses and completed work do not establish willingness to tutor. Only an explicit offer supports `can_help_with`; only approved activities support `open_to`.
- Cubbie accesses only what its supported abilities actually retrieve; Super Cub does not automatically read whole chat histories. No transcripts, email prose, grades, private calendar titles or third-party names belong in context.
- Contextual asks can show an approved profile before acceptance. Private phone/email needs both people's current permission: an answer or bounded standing setup grant. Existing people explicitly approve automation once; old `auto_study` flags never establish it. Public profile links may provide a contact route; anonymous intros remain available. Legacy direct requests are unchanged.
- Parsing and pattern guards do not guarantee arbitrary text is safe. A model receives restricted labels/types; it is not a trusted privacy validator.

## Next acceptance check

With consenting test students, request a bounded check-in, then tell Cubbie a new non-sensitive fact after initial setup. Observe whether the check-in fires without a manual sync, retrieves the new context, posts only approved signals and relays a suggestion. Then establish a true two-real-student consent/contact loop. Save the trigger, timestamps, participant type and observed outcome; distinguish contact exchange, calendar action and actual meeting.

The alumni acceptance slice is documented in `alumni-lifecycle.md`: separate continuity/history choices, graduation without scope expansion, no stale-offer revival, and a new current need meeting a confirmed complementary offer. Local time travel does not establish a real two-year outcome.

Do not expand to a new matching product, self-improving Skill, router or replacement backend to work around an unverified platform boundary. Preserve the current registry, matching, identity, context and consent infrastructure. Do not publish local fixes without explicit user approval.
