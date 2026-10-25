# Student-to-alumni lifecycle

## Product slice

University provides the initial shared community. The useful moment can arrive years later: one person is building a healthcare product and another has explicitly offered advice. Explain the current intersection and obtain both people's valid permissions, from specific answers or bounded standing setup grants. Long gaps still need renewed permission and fresh willingness.

This checkout implements that slice with the existing registry, consent endpoints, client and Skill. It does not establish unattended Cubbie scheduling or native push, and has not been deployed as part of this work.

## State that lasts, state that expires

- Identity: an independent random UUID/token; hashed binding retained until leave. A valid old binding is upgraded in place. Optional private-file backup/import recovers the current remote profile on a new device. There is no recovery without the device or backup.
- Opt-in alumni profile: chosen name/contact, approved school affiliations, life stage, sharing policy and time zone. It lasts until alumni retention is withdrawn or the person leaves. Affiliations are self-reported, not verified.
- Current context: a replaceable snapshot, removed after 120 inactive days. Offers and activities expire 60 days after actual confirmation; requests after 30. An inactive alumnus can keep an affiliation while having no current discoverable intent.
- Optional retained relationship: dates, introduction count, a hash of the reason and private self-reported outcomes. Both people must consent; maximum 200 relationships per person. No peer contact or old project labels are stored in this history. A new introduction still works if history capacity is full.
- Reconnection: requires a new reason, fresh compatible intent, normal caps/cooldowns and both current permissions. Standing permission expires within a year; prior relationships and new sync timestamps do not renew it. Negative usefulness feedback suppresses reconnection until reset.

## Local acceptance scenarios

Run from `server/`:

```sh
pnpm exec vitest run test/continuity.test.ts test/contract.test.ts
```

Run the complete verification set before shipping:

```sh
pnpm typecheck
pnpm test
```

From the repository root:

```sh
python3 -m unittest discover -s tests -v
```

The suites use synthetic participants, temporary homes, localhost/in-memory handlers, mock model replies and a controlled clock. They exercise:

1. Two students opt into affiliation continuity; unrelated initial interests produce no introduction.
2. Advance two years. Their independent identities and opted-in affiliations survive; old offers, requests, activities and free windows do not.
3. They confirm alumni status and current intent. A healthcare request aligns with an explicitly offered clinical-workflow subject tagged healthcare, without requiring Canvas or university email.
4. Each receives a directional nudge with the other person's profile if they explicitly approved profile sharing. Legacy/unapproved profiles remain anonymous. A fetch without relay acknowledgment is offered again. Private phone/email remain hidden after the first yes and are released after the second.
5. If both approved relationship retention, save the minimal connection record. Two years later, the same reason is suppressed; a new matching subject can generate a reconnection with new consent.
6. A person reports whether they met and whether it was useful. Their feedback remains private; negative usefulness suppresses reconnection until reset.
7. Withdrawal of alumni/history permission removes durable continuity as documented. Full leave deletes identity, context, durable profile, shared relationship records and indexes.
8. Export an owner-only backup file, restore to an isolated device, verify against the same server, and recover the current remote choices. Reject wrong credentials, other servers and overwriting another identity.

Negative cases include missing affiliations, only one person approving alumni participation, mismatched activities, experience without an offer, expired confirmations, misleading word fragments, unsupported enrollment claims, unauthorized feedback and uncertain delivery.

## Real integration acceptance still required

With consenting test accounts and separate authorization for any hosted test:

1. Approve a bounded Cubbie check-in and a narrow sharing scope. Record actual schedule-creation confirmation.
2. State a new non-sensitive fact after setup, within the approved scope. Prepare a complementary explicitly approved offer on the other account.
3. Observe the check-in firing without a manual sync, retrieving the new fact, syncing only approved signals, receiving the nudge and relaying it.
4. Record relay acknowledgment separately from observed transport delivery. Obtain both real yeses and verify chosen-contact delivery.
5. Record a supported calendar action, actual meeting and usefulness separately; none follows automatically from contact exchange.

Evidence should identify participant type (real/synthetic), trigger, timestamps, retrieved source category, accepted/rejected counts and observed outcome. Do not store transcripts or inspect unrelated student records as diagnostics. Synthetic time travel cannot prove real long-term use.

## Current limits

Subject alignment uses a finite alias vocabulary and explicit approved tags; general semantic retrieval and learned ranking are absent. There is no native Cubbie push or independent confirmation that a relay was read. Cross-record updates are not transactional, full-network discovery scans remain, and general rate limiting, automated negotiation/booking and verified meeting outcomes are future work.
