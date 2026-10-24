# Audit, second pass: what we built vs the product we are actually building

Written 2026-10-24, replacing the first audit. The first audit put negotiation at the center. That was wrong. This one is centered on contextual discovery, per Apoorv's product statement of the same day.

VERIFIED means read in the code, the kit, or tested on Apoorv's real Cubbie account today. ASSUMPTION means reasoning not yet checked.

## The product, in one sentence

A proactive social intelligence layer for personal AI agents, starting with college campuses.

Each student's Cubbie keeps an evolving picture of what that student is doing: courses, professors, assignments, projects, hackathons, job applications, interests, problems, strengths. A shared layer looks for meaningful intersections between those pictures, judges when one is worth a suggestion, asks both people, and helps the connection happen. Nobody submits a request. Opportunities emerge from what students are already doing.

Matching and negotiation are supporting steps that run after discovery finds something. They are not the product.

Network effect: every new agent brings new context, relationships and opportunities that create value for every other agent. Not merely more profiles to match against.

## What exists today (VERIFIED)

Super Cub Skill (`supercub/`):
- Fires when a student asks for a person: study, project, ride, buddy, food. Collects need, offers, free windows, contact choice. Consent text, then yes.
- Memory of name, needs, offers, contact choice, campus, groups.
- Noticing: a nightly check-in reads Canvas, calendar and email events on the student's own Cubbie, picks one need, asks one question. Inward-looking only: it knows nothing about other students. Written today, not yet run on a real night.
- Scheduled check-ins poll the server. Leave deletes everything.

Server (`server/`, Vercel + Upstash Redis):
- Request records: kind, group, topic, offers, free windows, hidden contact.
- Matcher: same group, 60+ minute overlap within 72 hours, one shared word. Proposes a slot and a reason line.
- Two-sided consent, contacts released after two yeses, delete, trust-on-first-use identity.
- Live. One real two-fake-student run passed.

## Scored against the product

| What the product needs | What exists | Gap |
|---|---|---|
| Evolving personal context per student | memory of a few fields, written only when the student asks | no ongoing picture; nothing updates between requests |
| Permitted signals flowing from Cubbie to the layer over time | signals sent once, at join, after a yes | no stream of small context updates; no student controls beyond yes/no per request |
| Relationships between people, courses, professors, assignments, events, interests | flat request records grouped by a string | no entities, no relations, no time |
| Discovery of meaningful intersections | keyword + time overlap inside one group | finds "same word, same hour", not "same assignment, same professor, same week, both open" |
| A relevance bar so it does not spam | none; every overlap is a proposal | no scoring of worth, no cooldowns, no learning from declines |
| Proactive suggestion | noticing asks about the student's own need; the pool only answers requests | no suggestion ever originates from another student's context |
| Consent on both sides, minimal disclosure | yes | keep |
| Introduction and follow-through | contact swap, one calendar event | no intro message, no "did it happen", no feedback loop |
| Learning from outcomes | none | nothing changes based on what worked |

Honest summary: we built the request-and-match path, which is the fallback for when a student asks. The product's main path, where nobody asks, does not exist yet. Noticing is the seed of it, but it only looks at one student.

## What is reusable

Keep:
- Identity: id + token per Cubbie. Becomes the agent's identity in the network.
- Consent gate and contact release. Becomes the final step of every suggestion.
- The server and store, deploy, test harness.
- The Skill's patterns: consent text, relay of script output as friendly texts, check-ins as the only inbound channel, delete-all, "nothing leaves until yes".
- The matcher, demoted to one scorer among several inside discovery.
- Noticing, promoted: it becomes the moment each night when the Cubbie posts permitted context updates and pulls suggestions.

Change:
- Request records become a per-student context record that updates over time.
- "Group" strings become entities (course section, professor, assignment, event, company, topic) that many students can point at.
- The matcher becomes a discovery job that runs over the whole graph, not per request.
- Accept/decline becomes a suggestion lifecycle: proposed, asked A, asked B, both yes, introduced, happened, feedback.

## The constraint that shapes the design (VERIFIED)

A Cubbie wakes only when its student texts or a scheduled check-in fires. It runs for seconds. Nothing can push into it. It cannot message another Cubbie. Scripts can make outbound HTTPS and read their own saved state, but cannot call Cubbie's abilities; Cubbie fetches Canvas, calendar and memory itself and hands results to the script.

Consequences:
1. The layer cannot read anyone's inbox. It learns a student only through small, permitted updates posted at check-in time. That is a feature: the design is minimal-disclosure by construction.
2. Discovery runs on the server, always on, over whatever signals students have allowed.
3. A suggestion reaches a student at their next check-in, so latency is hours, not seconds. For "same assignment this week" that is fine.
4. Each Cubbie is the only thing that ever sees raw context. The server sees signals.

## Architecture, discovery-first

```
 per student, on their own Cubbie                        shared, on our server (always on)
 ┌─────────────────────────────────────┐                 ┌──────────────────────────────────────────┐
 │ Cubbie                               │                 │ 1. Signal intake                          │
 │  Canvas, Calendar, Gmail, memory,    │   nightly       │    accepts only allowed signal types,     │
 │  conversations                       │   check-in      │    per student policy                     │
 │                                      │  ──────────►    │                                           │
 │ Super Cub skill                      │  POST signals   │ 2. Living campus graph                    │
 │  - context understanding: turn raw   │                 │    people ── enrolled_in ── course section │
 │    context into permitted signals    │                 │    people ── working_on ── assignment      │
 │    (course section, assignment id,   │                 │    people ── attending ── event            │
 │    due date, event, interest, open   │                 │    people ── applying_to ── company        │
 │    flags). Raw context never leaves  │                 │    people ── interested_in ── topic        │
 │  - policy: participation on/off,     │                 │    people ── can_help_with ── topic        │
 │    discoverable to whom, intro rules │                 │    edges carry time and freshness          │
 │  - relay suggestions as one question │  ◄──────────    │                                           │
 │  - consent, introduction, follow-up  │  GET suggestions│ 3. Opportunity discovery                   │
 └─────────────────────────────────────┘  POST answers    │    patterns over the graph: same section + │
                                                           │    same assignment + due in 7 days + both  │
                                                           │    open + time overlap → candidate         │
                                                           │                                           │
                                                           │ 4. Relevance gate                          │
                                                           │    score, cooldowns, max 1 per student per │
                                                           │    week, learn from yes/no/ignored         │
                                                           │                                           │
                                                           │ 5. Coordination                            │
                                                           │    ask both, two yeses, intro text,        │
                                                           │    (later) agents negotiate time, follow up│
                                                           └──────────────────────────────────────────┘
```

Where the intelligence lives:
- Context understanding runs on the Cubbie, because that is the only place raw context is allowed. It is instructions in SKILL.md: "from tonight's Canvas and calendar, list the signals the student has allowed, as structured lines". Cubbie's own model does this.
- Discovery and relevance run on the server over signals. Rules first, a model later for judging "would these two benefit" and for writing the suggestion text.
- Coordination reuses today's consent and contact logic.

## Signals and permissions

Signal types, each a small structured fact with a time, never free text from an email:

| Type | Example | Default |
|---|---|---|
| enrolled_in | CSE 310, section 12345, Prof. Ortiz, Fall 2026 | shared if participating |
| working_on | assignment 98765 "HW4 hash tables", due Oct 28 | shared if participating |
| attending | Cubbie Hackathon, Oct 24 to 26 | shared if participating |
| interested_in | computer vision | asks once |
| can_help_with | recursion | asks once |
| applying_to | company name, stage | off by default |
| open_to | study with classmates, teammates, mentoring | asks once per kind |
| free_windows | up to 10 windows, next 7 days | shared only inside a suggestion the student said yes to |

Never a signal: grades, email bodies, calendar titles, names of other people, locations finer than campus.

Student controls, set once and changeable by text:
- Participation: on or off. Off means no signals leave and nothing is suggested.
- Discoverability: who may be matched with me. Same section, same school, same event, anyone on the network.
- Introductions: ask me every time (default), or auto-yes for a kind (for example "always yes to study partners in my sections").
- Cooldown: at most one suggestion a week by default.

Server-side rule that keeps it honest: a suggestion text may mention only signals both students have shared. "Someone in your CSE 310 section is working on HW4" is allowed because both posted enrolled_in and working_on. It may never mention a signal only one side shared.

## The smallest convincing demo of proactive discovery

Two students, neither asks for anything.

Setup: both have Super Cub installed and said yes to participation. Both have CSE 310 in Canvas with HW4 due in five days (seeded on two real or test Canvas accounts, or two fake students posting the same signals in the test harness). Both have free time Thursday evening. Both have open_to study.

Night 1, each Cubbie's check-in posts its signals: enrolled_in CSE 310 section 12345, working_on HW4 due Oct 28, open_to study, free Thu 6 to 9.

Server: discovery finds the intersection, relevance gate scores it high (same section, same assignment, due soon, both open, overlap), creates a suggestion.

Night 2, each Cubbie's check-in pulls the suggestion and texts: "Someone in your CSE 310 section is working on HW4 too and is open to studying with classmates. Want me to see if you'd both like to connect?"

Both say yes. The server confirms, releases first names and contacts, and each Cubbie writes a short intro: "You're on. Jordan, Thu 7 to 8. Here's their number." Calendar hold offered.

What this proves: nobody asked; context came from Canvas, not a form; the layer found the intersection; the suggestion text used only shared signals; consent on both sides; an introduction happened. That is the product in miniature.

For the video, run night 1 and night 2 minutes apart by setting the check-ins close together on the demo accounts.

## Build list for that demo (no code yet, for sizing)

Server:
1. Student context record with a list of typed signals, each with time and source, replacing the request record. Policy fields on the record.
2. Entity keys for course section, assignment, event, topic, so two students' signals point at the same thing.
3. Discovery job: for each pair sharing an entity, compute candidate with features (same section, same assignment, days to due, both open, overlap hours, freshness).
4. Relevance gate: threshold, one per student per week, skip pairs already suggested or declined in 30 days.
5. Suggestion lifecycle: proposed, asked, yes/no per side, introduced, feedback. Reuse consent and contact release.
6. Suggestion text builder that uses only mutually shared signals.

Skill:
7. Noticing becomes the nightly context post: Cubbie lists allowed signals from Canvas, calendar and email events as structured lines and runs `connect.py signals`. Then runs `connect.py suggestions` and relays at most one.
8. Participation, discoverability and introduction settings as remembered answers, asked once.
9. Keep the direct "I need a person" path as it is; it posts the same signal types with an explicit need.

Not in the smallest demo: negotiation between agents, non-student participants, learning from outcomes beyond yes/no counts, Track 3.

## Track 2 and Track 3 placement

Track 2 is this layer: agents for different students exchanging permitted information and working toward a shared outcome. The demo above satisfies "what they share" and "when they ask their students". Conflict handling (the brief asks for it) comes next: once a suggestion has two yeses and free windows disagree, the agents pick a time and escalate only on conflict. That is where the first audit's negotiation work slots in, as step 5, after discovery.

Track 3 is the same layer with a group as a participant: a group chat assistant on Discord or another platform (Cubbie has no group chats, VERIFIED) that posts the group's shared signals and receives suggestions for the group. Not started.

## Decisions before code

1. The signal types and defaults above, especially which are on by default when a student joins.
2. Rules-only discovery for the demo, or a model judging relevance and writing suggestion text from the start.
3. Whether the demo uses two real Canvas accounts with a seeded course, or the test harness with two fake students posting identical signals. Real is more convincing on video; fake is faster and certain.
