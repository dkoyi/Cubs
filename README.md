# Super Cub

Your network is your net worth. Super Cub builds it while you study.

Super Cub is a Skill for [Cubbie](https://cubbie.ai), the AI assistant that lives in your iMessage. Cubbie already knows your classes, your deadlines, your calendar and your inbox. Super Cub is the first piece of a social layer on top of that: it notices when you could use another person, finds a student whose life overlaps yours, and introduces you once you both say yes.

Nobody fills out a profile. Nobody joins a pool. Two students in the same CSE 310 section are both staring at Assignment 4. Their Cubbies notice, check that both are open to it, and one text appears on each phone: "Someone in your CSE 310 class is working on the same assignment and is open to studying with classmates. Want me to see if you'd both like to connect?"

That is where this is going. Here is what it does today.

## Today

You can ask Cubbie directly, and it will also start noticing on its own if you let it.

Text Cubbie that you're stuck on hash tables, need a teammate for the hackathon, or want to split a ride to the airport. Super Cub finds another student who is free at the same time and has what you need. Say yes once to "noticing" and Cubbie also looks at Canvas, your calendar and your email events each night and asks at most one question, like "CSE 310 midterm Thursday. Want someone to review with Tuesday night?"

## Install it

1. Text this link to your Cubbie:

   https://github.com/dkoyi/Cubs/tree/main/supercub

2. Cubbie tells you what it is about to fetch and asks first. Say yes.
3. Text it something real:
   - "I'm stuck on hash tables in CSE 310"
   - "Need a frontend person for the Cubbie hackathon"
   - "Anyone going to PHX airport Friday?"
   - "Want to grab lunch with someone"

No account, no app, no key.

## What happens next

Cubbie asks what you can offer and when you're free, then shows you exactly what it will share before it shares anything. If someone fits, both of you get asked. Only after two yeses do you see each other's contact, and Cubbie offers to put the time on your calendar. If nobody fits yet, Cubbie checks back on a schedule you pick.

## What gets shared, and when

- Before you say yes: nothing leaves your Cubbie. Noticing reads your Canvas, calendar and email on your own Cubbie and only turns them into a question.
- After you say yes: your first name, what you need, what you can help with, and a few free windows go to the Super Cub server. Not your whole calendar, not your inbox.
- After you both say yes: your contact, the one you chose, goes to that one person.
- Never: grades, Canvas files, emails, or anything you didn't see in the consent message.

Text "leave super cub" and everything about you is deleted from the server and from Cubbie's memory. "stop noticing" turns off the nightly check without leaving.

## Why there is a server

Cubbie only talks to its own student. Your Cubbie cannot message a classmate's Cubbie, and we tested that. So a small server is where two students' permitted signals can meet. Each student says yes inside their own Cubbie, and the server releases contacts only after both have.

## Where this is going

The product is a proactive social intelligence layer for personal AI agents, starting with college campuses. Each student's Cubbie keeps an evolving picture of what that student is doing. A shared layer looks for meaningful intersections between those pictures, decides when one is worth a suggestion, and asks both people. Beyond classmates: the hackathon you're both attending, the company one of you just got an offer from, the robotics project that needs the computer vision you're already studying. Matching and scheduling are what happens after the layer finds something worth acting on. See `research/agent-network-audit.md` for the architecture and what is built so far.

## For developers

- `supercub/` is the Skill: `SKILL.md` plus `scripts/connect.py`, Python standard library only.
- `server/` is the coordination server: TypeScript on Vercel Functions with Upstash Redis. It needs no secret from the client. Each student's Cubbie makes its own random id and token on first use, and the server only accepts that token for that id afterward.
- `parked/` is a prototype of gallery search for a later skill router. Not part of the Skill.

Deploy your own server: import the repo in Vercel with Root Directory set to `server`, add Upstash Redis from Storage (it sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`), deploy, then set `SERVER_URL` in `supercub/scripts/connect.py` to your host.

Run the tests:

```
cd server && pnpm install && pnpm typecheck && pnpm test
python3 -m unittest discover -s tests -v
```

Known limit: two students joining at the same moment can both be matched to the same third student. Accepted for the demo.

Built for the Cubbie Hackathon, Track 1.
