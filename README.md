# Super Cub

**Cubbie notices when you could use another student, finds one whose week overlaps yours, and introduces you once you both say yes.**

A [Cubbie](https://cubbie.ai) Skill for students. Built for the Cubbie Hackathon, **Track 1**.

---

## The problem

Every student is surrounded by people who could help them this week: the classmate who just figured out Assignment 4, the person at the hackathon who needs a designer, someone else heading to PHX airport on Friday. You never find out, because finding them means posting in a group chat, filling out a profile, or asking around.

Your Cubbie already knows your classes, your deadlines and your calendar. **The missing piece is another student's Cubbie knowing the same about them, and a safe way for the two to meet.**

## What it does

Super Cub lives in iMessage, inside Cubbie. Ask it for someone, or let it notice for you.

| Step | What happens |
|------|--------------|
| **1. Ask or get asked** | Text "I'm stuck on hash tables in CSE 310". Or, if you turned on noticing, Cubbie checks Canvas, your calendar and email events each night and asks at most one question, like "CSE 310 midterm Thursday. Want someone to review with Tuesday night?" |
| **2. Fill in the gaps** | Cubbie asks what you can help with and when you're free, reading your calendar if it's connected. |
| **3. Consent** | Cubbie shows you exactly what it will share. Nothing leaves before you say yes. |
| **4. Match** | The Super Cub server looks for another student who is free at the same time and has what you need. If nobody fits yet, Cubbie checks back on a schedule you pick. |
| **5. Two yeses** | You both see why you were matched and one proposed time. Only after both say yes do you get each other's contact. |
| **6. Meet** | Cubbie offers to put the time on your calendar. |

It covers study partners, project and hackathon teammates, ride shares, meals, and a buddy for the gym or an event.

## Try it

1. Text this link to your Cubbie:

   https://github.com/dkoyi/Cubs/tree/main/supercub

2. Cubbie tells you what it is about to fetch and asks first. Say yes.
3. Text it something real:
   - "I'm stuck on hash tables in CSE 310"
   - "Need a frontend person for the Cubbie hackathon"
   - "Anyone going to PHX airport Friday?"
   - "Want to grab lunch with someone"

No account, no app, no key.

## What gets shared, and when

- **Before you say yes:** nothing leaves your Cubbie. Noticing reads Canvas, your calendar and email on your own Cubbie and only turns them into a question.
- **After you say yes:** your first name, what you need, what you can help with, and a few free windows go to the Super Cub server. Not your whole calendar, not your inbox.
- **After you both say yes:** the contact you chose goes to that one person.
- **Never:** grades, Canvas files, emails, or anything you didn't see in the consent message.

Text "leave super cub" and everything about you is deleted from the server and from Cubbie's memory. Text "stop noticing" to turn off the nightly check without leaving.

## Why there is a server

Cubbie only talks to its own student. Your Cubbie cannot message a classmate's Cubbie; we tested that. So a small server is where two students' permitted signals meet. Each student says yes inside their own Cubbie, and the server releases contacts only after both have.

## Where this is going

Today you can still ask. Over time the asking fades and the noticing does the work. Super Cub is the first piece of a social layer for personal AI agents, starting on campus: each Cubbie keeps a picture of what its student is doing, and the layer spots the overlaps worth a suggestion, like the hackathon you're both attending or the robotics project that needs the computer vision you're already studying. See [`research/agent-network-audit.md`](research/agent-network-audit.md) for the architecture and what is built so far.

## For developers

- `supercub/` is the Skill: `SKILL.md` plus `scripts/connect.py`, Python standard library only.
- `server/` is the coordination server: TypeScript on Vercel Functions with Upstash Redis. It needs no secret from the client. Each student's Cubbie makes its own random id and token on first use, and the server only accepts that token for that id afterward.

Deploy your own server: import the repo in Vercel with Root Directory set to `server`, add Upstash Redis from Storage (it sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`), deploy, then set `SERVER_URL` in `supercub/scripts/connect.py` to your host.

Run the tests:

```
cd server && pnpm install && pnpm typecheck && pnpm test
python3 -m unittest discover -s tests -v
```

Known limit: two students joining at the same moment can both be matched to the same third student. Accepted for the demo.
