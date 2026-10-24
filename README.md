# Super Cub

Your network is your net worth. Super Cub builds it while you study.

Super Cub is a Skill for [Cubbie](https://cubbie.ai), the AI assistant that lives in your iMessage. Cubbie already knows your classes, your calendar and your deadlines. Super Cub gives it the one thing it was missing: other people.

Text Cubbie that you're stuck on hash tables, need a teammate for the hackathon, or want to split a ride to the airport. Super Cub finds another student who is free at the same time and has what you need, and connects you once you both say yes. Over time it learns what you need and what you're good at, so it stops asking and starts suggesting.

## Install it

1. Text this link to your Cubbie:

   https://github.com/dkoyi/Cubs/tree/main/supercub

2. Cubbie tells you what it is about to fetch and asks first. Say yes.
3. Text it something real:
   - "I'm stuck on hash tables in CSE 310"
   - "Need a frontend person for the Cubbie hackathon"
   - "Anyone going to PHX airport Friday?"
   - "Want to grab lunch with someone"

That's it. No account, no app, no key.

## What happens next

Cubbie asks what you can offer and when you're free, then shows you exactly what it will share before it shares anything. If someone fits, both of you get asked. Only after two yeses do you see each other's contact, and Cubbie offers to put the time on your calendar.

If nobody fits yet, you're in the pool and Cubbie checks back on a schedule you pick.

Say yes once to "noticing" and Cubbie also looks at Canvas, your calendar and your email events each night and asks at most one question, like "CSE 310 midterm Thursday. Want someone to review with Tuesday night?" Text "stop noticing" to turn that off.

## What gets shared, and when

- Before you say yes: nothing leaves your Cubbie.
- After you say yes: your first name, what you need, what you can help with, and a few free windows go to the Super Cub server. Not your whole calendar.
- After you both say yes: your contact, the one you chose, is shared with that one person.
- Never: grades, Canvas files, emails, or anything you didn't see in the consent message.

Text "leave super cub" and everything about you is deleted from the server and from Cubbie's memory.

## Why there is a server

Cubbie only talks to its own student. Your Cubbie cannot message a classmate's Cubbie, and we tested that. So a small server holds requests and passes match proposals between students. Each student says yes inside their own Cubbie, and the server releases contacts only after both have.

## For developers

- `supercub/` is the Skill: `SKILL.md` plus `scripts/connect.py`, Python standard library only.
- `server/` is the matching server: TypeScript on Vercel Functions with Upstash Redis. It needs no secret from the client. Each student's Cubbie makes its own random id and token on first use, and the server only accepts that token for that id afterward.
- `parked/` is a prototype of gallery search for a later skill router. Not part of the Skill.

Deploy your own server: import the repo in Vercel with Root Directory set to `server`, add Upstash Redis from Storage (it sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`), deploy, then set `SERVER_URL` in `supercub/scripts/connect.py` to your host.

Run the tests:

```
cd server && pnpm install && pnpm typecheck && pnpm test
python3 -m unittest discover -s tests -v
```

Known limit: two students joining at the same moment can both be matched to the same third student. Accepted for the demo.

## Next

- Helper-first consent: the person who can help says yes first, so the one who asked hears "Maya already said yes, want the intro?"
- A match card with a link preview in the thread, like Boardy's "someone you should meet," with no contacts on it.
- A skill router: when you ask for something Cubbie can't do, it checks its own abilities, then your installed Skills, then the Cubbie Hackathon gallery, and installs another team's Skill only after you say yes.

Built for the Cubbie Hackathon, Track 1.
