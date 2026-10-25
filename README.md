# Super Cub

**Your Cubbie understands your life as it changes. Super Cub looks across many lives like that and finds the moments where two of them should meet.**

A [Cubbie](https://cubbie.ai) Skill for students. Built for the Cubbie Hackathon, **Track 1**.

---

## The idea

Every student already has a personal assistant that knows them well. Cubbie sees their Canvas courses and deadlines, their calendar, event emails, and, most importantly, what the student tells it over time: what they are learning, what they are building, what they are stuck on, what they are into, what they are trying to get to, and where another person would help.

That last source is the one that matters most. Courses and deadlines put two students in the same room. Conversations are where it becomes clear that one of them is building a robotics project that needs computer vision and the other has been talking about computer vision for weeks.

Super Cub is a shared layer that sits above many Cubbies. Each Cubbie contributes a small set of approved signals about its student. The layer looks for meaningful intersections between those lives, decides whether one is worth an introduction, asks both people, and connects them once both say yes. Nobody fills out a profile or posts a request. Opportunities come out of what students are already doing and saying.

## Context, not messages

There is a big difference between **using what conversations reveal** and **sharing the conversations**. Super Cub does the first and never the second.

- Super Cub never stores chat histories and never sends a message anyone wrote to the server or to another student.
- At each sync, the student's own Cubbie turns what it already remembers into short typed signals: what they are working on, interested in, can help with, attending, and open to. A signal is a label like "machine learning" or "CSE 240 Project 1" with an optional short detail.
- The same rule applies to email and calendar. Only public-looking event names (a hackathon, a career fair) and free time windows leave. Never an email body or subject, never a private calendar title.
- The server refuses anything that looks like a grade, a score, an email, a phone number, another person's name, or free text over 120 characters.
- Super Cub claims only what the student actually said. If a student told Cubbie they can help with recursion, that is a signal. Super Cub never infers that someone did well on an assignment from grades or any other source, and never presents a guess as a fact.

## What it does today

| Step | What happens |
|------|--------------|
| **1. Install** | Text the GitHub link to Cubbie. It asks before fetching anything. Say yes. |
| **2. One question** | Cubbie states the defaults in one message: who can be matched with you, whether public events count, what kinds of connection you are open to, how often it syncs, and which contact is shared after a mutual yes. Say yes or change anything. |
| **3. Sync** | On a schedule (every 2 hours by default), Cubbie gathers typed signals from Canvas, calendar, email events and its own memory of your conversations, and posts them to the Super Cub server. |
| **4. Discover** | The server finds students whose signals intersect: same assignment this week, the same hackathon, a project that needs what the other knows. A model judges whether the intersection is worth an introduction and writes the suggestion using only facts both sides shared. |
| **5. Two yeses** | Each student gets one short ask explaining why. Only after both say yes does the contact each chose go to the other person. |
| **6. Meet** | Cubbie offers to put a time on the calendar. |

You can still ask directly: "Stuck on hash tables in CSE 310" or "need a frontend person for the hackathon" starts a search right away. Over time the asking fades and the noticing does the work.

## What is verified and what is intended

Verified on real Cubbie accounts (October 24, 2026):

- Cubbie installs the Skill from a GitHub link after the student says yes.
- Cubbie's sandbox reaches the Super Cub server over HTTPS.
- Cubbie cannot message another student's Cubbie and has no group chats, which is why a server exists.
- Three real Cubbie accounts synced context to the server, including signals drawn from Canvas and from Cubbie's memory.
- A real student's Cubbie received a suggestion from the server, with the other side being a synthetic participant. The suggestion text was written by the model from shared facts only.
- The full loop, signals in to contacts released after two yeses, ran end to end on the live server with test participants.

Intended behavior, written in the Skill but not yet confirmed:

- A real-to-real introduction: two real students both saying yes and receiving each other's contact.
- A scheduled check-in that runs on its own, picks up context the student told Cubbie since the last sync, and sends it without anyone asking for a sync.

## Try it

1. Text this link to your Cubbie:

   https://github.com/dkoyi/Cubs/tree/main/supercub

2. Cubbie tells you what it is about to fetch and asks first. Say yes.
3. Answer the one setup question, or just say yes to the defaults.
4. Live your week. Text it something real if you want a search now:
   - "I'm stuck on hash tables in CSE 310"
   - "Need a frontend person for the Cubbie hackathon"
   - "Anyone going to PHX airport Friday?"

No account, no app, no key.

## What leaves your Cubbie, and when

- **Before you say yes:** nothing.
- **On each sync, after you opted in:** your first name, school, course codes and sections, assignment titles and due dates, short signals for what you are working on, interested in, can help with and open to, a few free windows, and public event names if you allowed them.
- **Other students see:** only what the two of you have in common, in one suggestion. No name or contact until both say yes.
- **After you both say yes:** the contact you chose goes to that one person.
- **Never:** grades, Canvas files, emails, messages, private calendar titles, or anything you did not see described in the setup message.

Text "leave super cub" and everything about you is deleted from the server and from Cubbie's memory.

## Why there is a server

Cubbie only talks to its own student. Your Cubbie cannot message a classmate's Cubbie; we tested that. So a small server is where many students' permitted signals meet. Each student says yes inside their own Cubbie, and the server releases contacts only after both have. Every new student adds context and opportunities for everyone already there, not just one more profile.

See [`research/agent-network-audit.md`](research/agent-network-audit.md) for the product reasoning and [`research/loop-contract.md`](research/loop-contract.md) for the signal contract.

## For developers

- `supercub/` is the Skill: `SKILL.md` plus `scripts/connect.py`, Python standard library only.
- `server/` is the coordination server: TypeScript on Vercel Functions with Upstash Redis, with Claude on Bedrock judging relevance and writing suggestions. It needs no secret from the client. Each student's Cubbie makes its own random id and token on first use, and the server only accepts that token for that id afterward.

Deploy your own server: import the repo in Vercel with Root Directory set to `server`, add Upstash Redis from Storage (it sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`), deploy, then set `SERVER_URL` in `supercub/scripts/connect.py` to your host.

Run the tests:

```
cd server && pnpm install && pnpm typecheck && pnpm test
python3 -m unittest discover -s tests -v
```

Known limit: two students joining at the same moment can both be matched to the same third student. Accepted for the demo.
