#!/usr/bin/env python3 -I
"""Seed clearly-labelled demo students into the live Super Cub network using the real
connect.py client, so real phones can see the network effect during the hackathon.

Every demo student is named "Demo <Name>", uses a @supercub.test contact, and keeps its
own data dir under /tmp/supercub-demo/<name> so it can answer or leave later:

  python3 -I scripts/seed-demo-students.py seed          # create and sync all demo students
  python3 -I scripts/seed-demo-students.py sync          # re-sync all (pulls any asks)
  python3 -I scripts/seed-demo-students.py answer yes    # every demo student answers its open ask
  python3 -I scripts/seed-demo-students.py leave         # delete every demo student from the server

Demo students only. Never run this against real accounts.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONNECT = ROOT / "supercub" / "scripts" / "connect.py"
BASE = Path("/tmp/supercub-demo")
TZ = "America/Phoenix"
OFFSET = timezone(timedelta(hours=-7))

# Overlaps are chosen to touch the three real accounts seen tonight:
# Cubbie Hackathon + AI project (Apoorv), CSE 240 (Malaika), CSE 240 Project 1 / Adobe hackathon (Dhanush).
DEMO = [
    ("Demo Priya", "Building a voice AI study helper", [("attending", "event", "Cubbie Hackathon"), ("working_on", "topic", "AI project"),
                    ("interested_in", "topic", "voice AI"), ("looking_for", "topic", "frontend help"), ("open_to", "activity", "teammates")]),
    ("Demo Marcus", "Frontend dev, React and design systems", [("attending", "event", "Cubbie Hackathon"), ("interested_in", "topic", "frontend design"),
                     ("can_help_with", "topic", "React"), ("open_to", "activity", "teammates"), ("open_to", "activity", "collaboration")]),
    ("Demo Sofia", "CSE 240 student who likes debugging C", [("enrolled_in", "course", "CSE 240"), ("working_on", "topic", "CSE 240 Project 1"),
                    ("can_help_with", "topic", "pointers"), ("open_to", "activity", "study")]),
    ("Demo Wei", "CS junior, tutors recursion", [("enrolled_in", "course", "CSE 240"), ("enrolled_in", "course", "MAT 243"),
                  ("can_help_with", "topic", "recursion"), ("open_to", "activity", "study")]),
    ("Demo Aisha", "Product designer, Figma and UX research", [("attending", "event", "Adobe University Hackathon"), ("interested_in", "topic", "design"),
                    ("can_help_with", "topic", "UX research"), ("open_to", "activity", "teammates")]),
    ("Demo Leo", "Speech recognition research assistant", [("enrolled_in", "course", "CSE 110"), ("working_on", "topic", "AI project"),
                  ("interested_in", "topic", "speech recognition"), ("experienced_in", "topic", "machine learning"), ("open_to", "activity", "collaboration")]),
    ("Demo Nina", "Pre-med building a health app", [("working_on", "topic", "healthcare app"), ("looking_for", "topic", "technical cofounder"),
                   ("interested_in", "topic", "startups"), ("open_to", "activity", "collaboration")]),
    ("Demo Omar", "ASU alum, product manager at a fintech startup", [("experienced_in", "topic", "product management"), ("can_help_with", "topic", "APM interviews"),
                   ("interested_in", "topic", "startups"), ("open_to", "activity", "mentoring"), ("open_to", "activity", "advising")]),
    ("Demo Grace", "Runs the ASU AI club", [("interested_in", "topic", "machine learning"), ("attending", "event", "Cubbie Hackathon"),
                    ("can_help_with", "topic", "pitch decks"), ("open_to", "activity", "buddies")]),
    ("Demo Diego", "Looking for gym and study buddies", [("enrolled_in", "course", "MAT 243"), ("interested_in", "topic", "fitness"),
                    ("looking_for", "topic", "study group"), ("open_to", "activity", "study"), ("open_to", "activity", "buddies")]),
]


def free_windows() -> list[dict[str, str]]:
    now = datetime.now(OFFSET)
    out = []
    for d in range(1, 6):
        day = (now + timedelta(days=d)).replace(hour=14, minute=0, second=0, microsecond=0)
        out.append({"start": day.isoformat(timespec="minutes"), "end": (day + timedelta(hours=4)).isoformat(timespec="minutes")})
        eve = day.replace(hour=18)
        out.append({"start": eve.isoformat(timespec="minutes"), "end": (eve + timedelta(hours=3)).isoformat(timespec="minutes")})
    return out[:10]


def run(name: str, *args: str) -> str:
    env = dict(os.environ, SKILL_DATA_DIR=str(BASE / name.replace(" ", "_")))
    proc = subprocess.run([sys.executable, "-I", str(CONNECT), *args], env=env, capture_output=True, text=True, timeout=200)
    out = (proc.stdout + proc.stderr).strip()
    return out


def context_for(name: str, headline: str, sigs: list[tuple[str, str, str]]) -> Path:
    first = name.split()[1]
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    ctx = {
        "tz": TZ,
        "policy": {"first_name": name, "school": "ASU", "contact": f"demo-{first.lower()}@supercub.test",
                   "participating": True, "intro": "automatic", "discoverable": "school", "share_events": True,
                   "share_intro_profile": True, "intro_profile": {"name": name, "headline": headline}},
        "signals": [
            {"type": t, "entity": {"kind": k, "key": label, "label": label}, "source": "student", "observed_at": now,
             **({"confirmed_at": now} if t in ("looking_for", "can_help_with", "open_to") else {})}
            for t, k, label in sigs
        ],
        "free": free_windows(),
    }
    d = BASE / name.replace(" ", "_")
    d.mkdir(parents=True, exist_ok=True)
    p = d / "ctx.json"
    p.write_text(json.dumps(ctx))
    return p


def main() -> int:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "seed"
    for name, headline, sigs in DEMO:
        print(f"## {name}")
        if cmd == "seed":
            approved = datetime.now(timezone.utc).isoformat(timespec="seconds")
            print(run(name, "setup", "--file", str(context_for(name, headline, sigs)), "--approved-at", approved))
        elif cmd == "sync":
            print(run(name, "sync", "--file", str(context_for(name, headline, sigs))))
        elif cmd == "answer":
            ans = sys.argv[2] if len(sys.argv) > 2 else "yes"
            out = run(name, "sync", "--file", str(context_for(name, headline, sigs)))
            print(out)
            if out.startswith("ASK "):
                sid = out.split()[1]
                print(run(name, "answer", sid, ans))
        elif cmd == "leave":
            print(run(name, "leave"))
        else:
            print("unknown command", cmd)
            return 2
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
