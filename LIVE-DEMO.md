# Live demo script (Oct 25, 12 to 2)

Setup, once per real account: text Cubbie "update Super Cub", reply "Yes, join" to the summary, wait for SETUP COMPLETE.

All seeded people (Priya, Marcus, Sofia, Wei, Aisha, Leo, Nina, Omar, Grace, Diego) are synthetic sample profiles (contact @supercub.test). Each scenario below was rehearsed in production with a throwaway synthetic person on Oct 25 and matched in one sync (~8 s server time).

1. **DevHacks email (Malaika).** Send her an email: subject "DevHacks Saturday", body "See you at DevHacks this Saturday!". She texts Cubbie: "Can you check my latest email?" Cubbie should ask if she's going and offer to see who else is. She replies "Yes". Expected: "4 others on Super Cub are going too" + an intro to Marcus Lee, Priya Shah, Leo Park or Grace Kim with contact.
2. **Frontend help (Apoorv).** "I need frontend help for my AI project. Anyone on Super Cub?" Expected: Marcus Lee (React, frontend design).
3. **Stuck on a class (Dhanush).** "I'm stuck on CSE 240 Project 1, pointers are killing me." Expected: Sofia Ramirez (same project, helps with pointers).
4. **Career help.** "I'm prepping for APM interviews, know anyone who could help?" Expected: Omar Haddad (ASU alum PM, helps with APM interviews).
5. **Startup idea.** "I want to build a health app and I'm into startups." Expected: Nina Patel (pre-med building a healthcare app, wants a technical cofounder).

Important: the same real person + same Demo person + same reason will not match again for a day. If you rehearse a scenario on an account before 12, ask Claude to reset that pair before the demo, or run it on a different account.

Re-seed demo people: `python3 -I scripts/seed-demo-students.py seed`. Remove them all: `python3 -I scripts/seed-demo-students.py leave`.
