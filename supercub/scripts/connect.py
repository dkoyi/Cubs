#!/usr/bin/env python3
"""campus-connect client. Talks to the campus-connect server for one student.

Subcommands:
  join     add or update the student's request (study, project teammate, ride, buddy or food)
  check    report only what is new since the last check (for scheduled check-ins)
  respond  answer a proposed match with --accept or --decline
  leave    delete all of the student's data from the server and this device
  status   show everything: requests and matches

Standard library only. Output is short plain text that Cubbie can relay. Every line that
starts with a word in capitals (NEW MATCH, ERROR. SERVER UNAVAILABLE., ...) is mapped to a
student-facing text in SKILL.md. The script never shows a stack trace: any failure prints
one line starting with ERROR. and exits nonzero.
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import re
import secrets
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone, tzinfo
from pathlib import Path
from typing import Any, NoReturn, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# Set this to the deployed server, for example "https://<your-project>.vercel.app".
# It is empty on purpose: the script must never send a student's name and contact
# to a server we do not run, so it refuses to send anything until this is set.
SERVER_URL = "https://supercub-server.vercel.app"
TIMEOUT_SECONDS = 15
MAX_OUTPUT_CHARS = 7000  # Cubbie reads at most 8,000 characters of output
MAX_REPLY_BYTES = 256 * 1024
MAX_WINDOWS = 10
MAX_WINDOW_DAYS = 14
LOCAL_HOSTS = {"localhost", "127.0.0.1"}
EXAMPLE_WINDOW = "2026-10-25T14:00-07:00/2026-10-25T16:00-07:00"

JsonDict = dict[str, Any]

KINDS = ("study", "project", "ride", "buddy", "food")
KIND_ALIASES = {
    "study partner": "study",
    "studying": "study",
    "teammate": "project",
    "team": "project",
    "project teammate": "project",
    "rideshare": "ride",
    "ride share": "ride",
    "carpool": "ride",
    "friend": "buddy",
    "meal": "food",
    "food buddy": "food",
    "eat": "food",
}
KIND_LABEL = {
    "study": "study partner",
    "project": "project teammate",
    "ride": "ride share",
    "buddy": "buddy",
    "food": "meal buddy",
}
TOPIC_LABEL = {
    "study": "They are working on",
    "project": "Their project",
    "ride": "Going to",
    "buddy": "They want to",
    "food": "They feel like",
}
HELP_LABEL = {
    "study": "They can help with",
    "project": "Their skills",
    "ride": "They offer",
    "buddy": "They offer",
    "food": "They offer",
}
GROUP_TYPES = ("course", "campus", "event")


class ConnectError(Exception):
    """An error whose message is safe to show the student. `tag` is a stable prefix SKILL.md maps."""

    def __init__(self, message: str, tag: str = "", http_status: Optional[int] = None,
                 payload: Optional[JsonDict] = None) -> None:
        super().__init__(message)
        self.tag = tag
        self.http_status = http_status
        self.payload = payload or {}

    def line(self) -> str:
        prefix = f"ERROR. {self.tag}. " if self.tag else "ERROR. "
        return prefix + str(self)


class ServerUnavailable(ConnectError):
    """Unreachable, timed out, 5xx, or a reply that is not JSON. Worth retrying later."""

    def __init__(self, reason: str) -> None:
        super().__init__(
            f"Could not reach the campus-connect server ({reason}). Try again at the next check-in.",
            tag="SERVER UNAVAILABLE",
        )


class UsageError(Exception):
    """The command line was wrong."""


# ---------- text ----------


def clean(value: object, limit: int = 200) -> str:
    """One line of printable text. Other students' text goes through here before it is printed."""
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return ""
    text = "".join(ch if unicodedata.category(ch)[0] != "C" else " " for ch in str(value))
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 3].rstrip() + "..."


def _dicts(value: object) -> list[JsonDict]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _strings(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [text for text in (clean(item, 80) for item in value) if text]


# ---------- local files ----------


def data_dir() -> Path:
    """Folder under HOME that persists between runs for this student."""
    base = os.environ.get("SKILL_DATA_DIR") or str(Path.home() / ".campus-connect")
    path = Path(base)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _read_json(path: Path) -> Optional[JsonDict]:
    """The file's JSON object, or None if it is missing or damaged."""
    try:
        with path.open(encoding="utf-8") as f:
            value = json.load(f)
    except FileNotFoundError:
        return None
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None  # a damaged file is treated as missing and rewritten
    except OSError as e:
        raise ConnectError(f"Could not read {path.name} on this device ({e.strerror or 'read error'}).") from e
    return value if isinstance(value, dict) else None


def _write_json(path: Path, value: JsonDict) -> None:
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=2)
    os.replace(tmp, path)


def load_identity(create: bool) -> Optional[JsonDict]:
    """Return {student_id, token}. Creates a fresh one on first use if `create` is true."""
    path = data_dir() / "identity.json"
    identity = _read_json(path)
    if identity and isinstance(identity.get("student_id"), str) and isinstance(identity.get("token"), str):
        return identity
    if not create:
        return None
    identity = {"student_id": str(uuid.uuid4()), "token": secrets.token_urlsafe(32)}
    _write_json(path, identity)
    return identity


def load_state() -> JsonDict:
    state = _read_json(data_dir() / "state.json") or {}
    if not isinstance(state.get("seen"), dict):
        state["seen"] = {}
    return state


def save_state(state: JsonDict) -> None:
    _write_json(data_dir() / "state.json", state)


# ---------- server ----------


def server_url() -> str:
    url = (os.environ.get("CAMPUS_CONNECT_URL") or SERVER_URL).rstrip("/")
    if not url:
        raise ConnectError("The campus-connect server address is not set up yet, so nothing was sent.", tag="NOT SET UP")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme == "https":
        return url
    if parsed.scheme == "http" and parsed.hostname in LOCAL_HOSTS:
        return url  # local testing only
    raise ConnectError("CAMPUS_CONNECT_URL must use https.", tag="NOT SET UP")


def _error_payload(e: urllib.error.HTTPError) -> JsonDict:
    try:
        payload = json.loads(e.read(MAX_REPLY_BYTES).decode("utf-8"))
    except (OSError, ValueError, http.client.HTTPException):
        return {}
    return payload if isinstance(payload, dict) else {}


def _reason(e: BaseException) -> str:
    """'timed out' or 'no connection', never the raw exception text."""
    cause = e.reason if isinstance(e, urllib.error.URLError) and isinstance(e.reason, BaseException) else e
    return "timed out" if isinstance(cause, TimeoutError) or "timed out" in str(cause).lower() else "no connection"


def api(method: str, path: str, identity: JsonDict, body: Optional[JsonDict] = None) -> JsonDict:
    """Call the server and return its JSON body. Raises ConnectError on any failure."""
    url = server_url() + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {identity['token']}",
            "X-Student-Id": identity["student_id"],
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "campus-connect-skill/1",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as res:
            raw = res.read(MAX_REPLY_BYTES + 1)
    except urllib.error.HTTPError as e:
        payload = _error_payload(e)
        if e.code >= 500:
            raise ServerUnavailable(f"HTTP {e.code}") from None
        message = clean(payload.get("error"), 300) or f"HTTP {e.code}"
        if e.code == 401:
            raise ConnectError(f"The campus-connect server did not accept this device ({message}).",
                               tag="NOT RECOGNIZED", http_status=401, payload=payload) from None
        raise ConnectError(f"The campus-connect server said: {message}", http_status=e.code, payload=payload) from None
    except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException, ValueError) as e:
        raise ServerUnavailable(_reason(e)) from None
    if len(raw) > MAX_REPLY_BYTES:
        raise ServerUnavailable("reply too large")
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except ValueError:
        raise ServerUnavailable("unreadable reply") from None
    if not isinstance(parsed, dict):
        raise ServerUnavailable("unreadable reply")
    return parsed


# ---------- times ----------


_OFFSET_RE = re.compile(r"(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?")


def utc_now() -> datetime:
    """The current time. CAMPUS_CONNECT_NOW (ISO 8601) overrides it, for tests only."""
    override = os.environ.get("CAMPUS_CONNECT_NOW")
    if override:
        return _parse_aware(override, None, override)
    return datetime.now(timezone.utc)


def parse_tz(value: str) -> tzinfo:
    """A time zone name like America/Phoenix, or an offset like -07:00."""
    text = value.strip()
    if text.upper() in ("Z", "UTC", "GMT"):
        return timezone.utc
    match = _OFFSET_RE.fullmatch(text.upper())
    if match:
        sign, hours, minutes = match.group(1), int(match.group(2)), int(match.group(3) or 0)
        if hours <= 14 and minutes < 60:
            delta = timedelta(hours=hours, minutes=minutes)
            return timezone(-delta if sign == "-" else delta)
    try:
        return ZoneInfo(text)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        raise ConnectError(
            f"I don't know the time zone '{clean(value, 60)}'. "
            "Fix: use a name like America/Phoenix or an offset like -07:00.",
            tag="NEED TIME ZONE",
        ) from None


def _parse_aware(text: str, tz: Optional[tzinfo], window: str) -> datetime:
    cleaned = text.strip()
    if cleaned.endswith(("Z", "z")):
        cleaned = cleaned[:-1] + "+00:00"
    try:
        moment = datetime.fromisoformat(cleaned)
    except ValueError:
        raise ConnectError(
            f"Free time '{clean(window, 80)}' has a time I can't read ('{clean(text, 40)}'). "
            f"Fix: write it like {EXAMPLE_WINDOW}.",
            tag="BAD FREE TIME",
        ) from None
    if moment.tzinfo is None:
        if tz is None:
            raise ConnectError(
                f"Free time '{clean(window, 80)}' has no time zone. "
                "Fix: pass --tz with the student's time zone (like America/Phoenix), or ask them for it.",
                tag="NEED TIME ZONE",
            )
        moment = moment.replace(tzinfo=tz)
    return moment


def parse_window(value: str, tz: Optional[tzinfo], now: datetime) -> tuple[datetime, datetime]:
    """Parse START/END in ISO 8601. Times without a zone use `tz`. Rejects past and out-of-order windows."""
    parts = value.split("/")
    if len(parts) != 2 or not parts[0].strip() or not parts[1].strip():
        raise ConnectError(
            f"Free time '{clean(value, 80)}' is not START/END. Fix: write it like {EXAMPLE_WINDOW}.",
            tag="BAD FREE TIME",
        )
    start = _parse_aware(parts[0], tz, value)
    end = _parse_aware(parts[1], tz, value)
    if end <= start:
        raise ConnectError(
            f"Free time '{clean(value, 80)}' ends before it starts. Fix: put the earlier time first.",
            tag="BAD FREE TIME",
        )
    if end <= now:
        raise ConnectError(
            f"Free time '{clean(value, 80)}' is already over. Fix: use free times later than now.",
            tag="BAD FREE TIME",
        )
    if end > now + timedelta(days=MAX_WINDOW_DAYS):
        raise ConnectError(
            f"Free time '{clean(value, 80)}' is more than {MAX_WINDOW_DAYS} days away. "
            f"Fix: use times in the next {MAX_WINDOW_DAYS} days.",
            tag="BAD FREE TIME",
        )
    return start, end


def _student_tz(state: JsonDict) -> tzinfo:
    name = state.get("tz")
    if isinstance(name, str):
        try:
            return parse_tz(name)
        except ConnectError:
            pass
    minutes = state.get("tz_offset_minutes")
    if isinstance(minutes, int) and -16 * 60 <= minutes <= 16 * 60:
        return timezone(timedelta(minutes=minutes))
    return timezone.utc


def _moment(value: object) -> Optional[datetime]:
    """A server timestamp, or None if it is missing or unreadable."""
    if not isinstance(value, str):
        return None
    try:
        moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo is not None else None


def _clock(moment: datetime) -> str:
    return moment.strftime("%I:%M %p").lstrip("0")


def describe_time(window: object, tz: tzinfo) -> str:
    """'Sat Oct 25, 2:00 PM to 3:00 PM' in the student's time zone."""
    w = window if isinstance(window, dict) else {}
    start, end = _moment(w.get("start")), _moment(w.get("end"))
    if start is None or end is None:
        return "time not given"
    start, end = start.astimezone(tz), end.astimezone(tz)
    return f"{start.strftime('%a %b')} {start.day}, {_clock(start)} to {_clock(end)}"


def describe_moment(value: object, tz: tzinfo) -> Optional[str]:
    """'Sat Oct 25, 2:00 PM' in the student's time zone, or None if unreadable."""
    moment = _moment(value)
    if moment is None:
        return None
    moment = moment.astimezone(tz)
    return f"{moment.strftime('%a %b')} {moment.day}, {_clock(moment)}"


def iso_range(window: object, tz: tzinfo) -> str:
    w = window if isinstance(window, dict) else {}
    start, end = _moment(w.get("start")), _moment(w.get("end"))
    if start is None or end is None:
        return "time not given"
    return f"{start.astimezone(tz).isoformat(timespec='minutes')} to {end.astimezone(tz).isoformat(timespec='minutes')}"


# ---------- formatting ----------


def _kind(m: JsonDict) -> str:
    kind = m.get("kind")
    return kind if isinstance(kind, str) and kind in KINDS else "study"


def _group_type(m: JsonDict) -> str:
    value = m.get("group_type")
    if isinstance(value, str) and value in GROUP_TYPES:
        return value
    return "course" if _kind(m) == "study" else "campus"


def _where(m: JsonDict) -> str:
    """'CSE 310', 'ASU Tempe' or 'Cubbie Hackathon'."""
    return clean(m.get("group"), 60) or "your group"


def _what(m: JsonDict) -> str:
    """'study partner for CSE 310', 'ride share from ASU Tempe', 'project teammate at Cubbie Hackathon'."""
    kind = _kind(m)
    if _group_type(m) == "course":
        joiner = "for"
    else:
        joiner = "from" if kind == "ride" else "at"
    return f"{KIND_LABEL[kind]} {joiner} {_where(m)}"


def _other(m: JsonDict) -> JsonDict:
    other = m.get("other")
    return other if isinstance(other, dict) else {}


def _name(m: JsonDict, default: str = "the other student") -> str:
    return clean(_other(m).get("first_name"), 40) or default


def describe_match(m: JsonDict, tz: tzinfo) -> list[str]:
    kind = _kind(m)
    other = _other(m)
    lines = [
        f"Match id: {clean(m.get('id'), 60)}",
        f"Looking for: {KIND_LABEL[kind]}",
        f"Name: {_name(m, 'A student')}",
        f"{_group_type(m).capitalize()}: {_where(m)}",
        f"{TOPIC_LABEL[kind]}: {clean(other.get('topic'))}",
    ]
    shared = _strings(m.get("shared_words"))
    if shared:
        lines.append(f"You both mentioned: {', '.join(shared)}")
    can_help = _strings(other.get("can_help"))
    if can_help:
        lines.append(f"{HELP_LABEL[kind]}: {', '.join(can_help)}")
    lines.append(f"Proposed time: {describe_time(m.get('time'), tz)}")
    return lines


def report_match(m: JsonDict, tz: tzinfo) -> list[str]:
    """Text for one match, based on its status for this student."""
    status = m.get("status")
    name = _name(m)
    what = _what(m)
    if status == "needs_your_answer":
        lines = ["NEW MATCH. Ask the student yes or no."]
        reason = clean(m.get("reason"), 240)
        if reason:
            # The student's offer covers the other student's need: lead with that.
            lead = "Someone needs your help: " if m.get("you_can_help") is True else ""
            lines.append(f"Why: {lead}{reason}")
        return [*lines, *describe_match(m, tz)]
    if status == "waiting_for_other":
        return [f"WAITING. You said yes to {name} ({what}). Waiting for them to answer."]
    if status == "confirmed":
        return [
            f"CONFIRMED. You and {name} both said yes.",
            f"Looking for: {what}",
            f"Time: {describe_time(m.get('time'), tz)}",
            f"Calendar times: {iso_range(m.get('time'), tz)}",
            f"{name}'s contact: {clean(_other(m).get('contact'), 100) or 'not given'}",
            "Reach out to them yourself to say hi and pick a place.",
        ]
    if status == "declined":
        if m.get("you_said") == "no":
            return [f"PASSED. You passed on {name} ({what})."]
        return [f"NOT THIS TIME. The match with {name} ({what}) did not work out. Still looking."]
    if status == "expired":
        return [f"EXPIRED. The proposed time with {name} ({what}) has passed. Still looking."]
    return [f"Match {clean(m.get('id'), 60)}: {clean(status, 40)}"]


def emit(lines: list[str]) -> None:
    text = "\n".join(lines).strip()
    if len(text) > MAX_OUTPUT_CHARS:
        text = text[:MAX_OUTPUT_CHARS] + "\n(more not shown)"
    print(text)


def _split_list(values: list[str]) -> list[str]:
    out: list[str] = []
    for value in values:
        out.extend(part.strip() for part in value.split(",") if part.strip())
    return out


def _seen_entry(m: JsonDict) -> JsonDict:
    return {"status": m.get("status"), "name": _name(m), "what": _what(m)}


# ---------- commands ----------


def parse_kind(value: Optional[str]) -> str:
    text = " ".join((value or "").lower().replace("-", " ").split())
    kind = text if text in KINDS else KIND_ALIASES.get(text)
    if kind is None:
        shown = f"'{clean(value, 30)}' is not a kind I know" if text else "No kind given"
        raise ConnectError(f"{shown}. Fix: pass --kind study, project, ride, buddy or food.", tag="UNKNOWN KIND")
    return kind


def cmd_join(args: argparse.Namespace) -> list[str]:
    kind = parse_kind(args.kind)
    # An event (like a hackathon) works for any kind and is open to students from any school.
    if clean(args.event, 60):
        group_type, group = "event", clean(args.event, 60)
    elif kind == "study":
        group_type, group = "course", clean(args.course, 60)
        if not group:
            raise ConnectError("A study partner needs a course or an event. "
                               "Fix: pass --course, like \"CSE 310\", or --event.", tag="MISSING INFO")
    else:
        group_type, group = "campus", clean(args.campus, 60)
        if not group:
            raise ConnectError(f"A {KIND_LABEL[kind]} needs a campus or an event. "
                               "Fix: pass --campus, like \"ASU Tempe\", or --event, like \"Cubbie Hackathon\".",
                               tag="MISSING INFO")
    topic = clean(args.topic)
    if not topic:
        need = {"ride": "a destination", "buddy": "an activity", "project": "a project",
                "food": "what they feel like eating (\"anything\" is fine)"}.get(kind, "a topic")
        raise ConnectError(f"This needs {need}. Fix: pass --topic.", tag="MISSING INFO")

    tz = parse_tz(args.tz) if args.tz else None
    now = utc_now()
    if not args.free:
        raise ConnectError(f"No free times given. Fix: add --free START/END for each one, like {EXAMPLE_WINDOW}.",
                           tag="BAD FREE TIME")
    if len(args.free) > MAX_WINDOWS:
        raise ConnectError(f"{len(args.free)} free times is too many. Fix: send at most {MAX_WINDOWS}.",
                           tag="BAD FREE TIME")
    windows = [parse_window(v, tz, now) for v in args.free]
    can_help = _split_list(args.can_help or [])

    state = load_state()
    if args.tz:
        state["tz"] = args.tz.strip()
    else:
        offset = windows[0][0].utcoffset()
        if offset is not None:
            state.pop("tz", None)
            state["tz_offset_minutes"] = int(offset.total_seconds() // 60)
    shown_tz = _student_tz(state)

    body: JsonDict = {
        "first_name": args.name,
        "contact": args.contact,
        "kind": kind,
        "group_type": group_type,
        "group": group,
        "topic": topic,
        "can_help": can_help,
        "free": [
            {"start": s.isoformat(timespec="seconds"), "end": e.isoformat(timespec="seconds")}
            for s, e in windows
        ],
    }
    identity = load_identity(create=True)
    if identity is None:
        raise ConnectError("Could not create a campus-connect identity on this device.")
    result = api("POST", "/api/requests", identity, body)

    request = result.get("request") if isinstance(result.get("request"), dict) else {}
    what = _what({"kind": kind, "group_type": group_type, "group": request.get("group") or group})
    if result.get("updated") is True:
        lines = [f"UPDATED. Your {what} request now has these details. No double entry."]
    else:
        lines = [f"JOINED. You're in the pool: {what}."]
    until = describe_moment(request.get("expires_at"), shown_tz)
    if until:
        lines.append(f"Your request stays open until {until}.")
    match = result.get("match")
    if isinstance(match, dict):
        lines.append("")
        lines.extend(report_match(match, shown_tz))
        state["seen"][clean(match.get("id"), 60)] = _seen_entry(match)
    elif request.get("status") == "matched":
        lines.append("ALREADY MATCHED. You already have a match here waiting for answers. Run status to see it.")
    else:
        lines.append("No match yet. I'll check back.")
    save_state(state)
    return lines


def cmd_check(_args: argparse.Namespace) -> list[str]:
    identity = load_identity(create=False)
    if identity is None:
        return ["NOT JOINED. The student has not joined campus-connect yet."]
    state = load_state()
    tz = _student_tz(state)
    result = api("GET", "/api/matches", identity)
    seen: JsonDict = state["seen"]
    lines: list[str] = []

    current_ids: set[str] = set()
    for m in _dicts(result.get("matches")):
        mid = clean(m.get("id"), 60)
        current_ids.add(mid)
        status = m.get("status")
        previous = seen.get(mid) if isinstance(seen.get(mid), dict) else {}
        if previous.get("status") != status:
            # Waiting on the other student and the student's own "no" are not news.
            if status != "waiting_for_other" and not (status == "declined" and m.get("you_said") == "no"):
                lines.extend(report_match(m, tz))
                lines.append("")
            seen[mid] = _seen_entry(m)

    # A pending match that vanished means the other student left campus-connect.
    for mid in list(seen.keys()):
        entry = seen[mid]
        if mid.startswith("req:") or mid in current_ids or not isinstance(entry, dict):
            continue
        if entry.get("status") in ("needs_your_answer", "waiting_for_other"):
            lines.append(
                f"CANCELLED. {clean(entry.get('name'), 40) or 'The other student'} left campus-connect, "
                f"so that match ({clean(entry.get('what'), 80)}) is off. Still looking."
            )
            lines.append("")
        del seen[mid]

    for r in _dicts(result.get("requests")):
        if r.get("status") != "expired":
            continue
        what = _what(r)
        key = f"req:{_kind(r)}:{_group_type(r)}:{clean(r.get('group'), 60)}:{clean(r.get('expires_at'), 40)}"
        if key not in seen:
            lines.append(
                f"REQUEST EXPIRED. Your {what} request ended. "
                "Join again with new free times if you still want a match."
            )
            lines.append("")
            seen[key] = {"status": "expired"}

    save_state(state)
    if not lines:
        return ["NOTHING NEW. Stay silent."]
    return lines


def cmd_respond(args: argparse.Namespace) -> list[str]:
    identity = load_identity(create=False)
    if identity is None:
        raise ConnectError("The student has not joined campus-connect yet.", tag="NOT JOINED")
    state = load_state()
    tz = _student_tz(state)
    mid = clean(args.match, 60)
    seen: JsonDict = state["seen"]
    try:
        result = api("POST", "/api/respond", identity, {"match_id": mid, "accept": bool(args.accept)})
    except ServerUnavailable:
        raise
    except ConnectError as e:
        lines = _respond_closed(e, mid, seen)
        if lines is None:
            raise
        save_state(state)
        return lines
    match = result.get("match")
    if not isinstance(match, dict):
        raise ServerUnavailable("unreadable reply")
    seen[clean(match.get("id"), 60)] = _seen_entry(match)
    save_state(state)
    if match.get("status") == "declined":
        return ["PASSED. Got it, you passed on this one. You're still in the pool."]
    return report_match(match, tz)


def _respond_closed(e: ConnectError, mid: str, seen: JsonDict) -> Optional[list[str]]:
    """Lines for a match that can no longer be answered, or None if this is some other error."""
    previous = seen.get(mid) if isinstance(seen.get(mid), dict) else {}
    name = clean(previous.get("name"), 40) or "the other student"
    if e.http_status == 409:
        status = e.payload.get("status")
        if status == "expired":
            seen[mid] = {**previous, "status": "expired"}
            return [f"EXPIRED. The proposed time with {name} has passed, so that match is off. Still looking."]
        if status == "declined":
            seen[mid] = {**previous, "status": "declined"}
            return [f"NOT THIS TIME. The match with {name} did not work out. Still looking."]
        if status == "confirmed":
            return ["ALREADY CONFIRMED. You both said yes already. Run status to see their contact."]
        return None
    if e.http_status in (404, 410):
        seen.pop(mid, None)
        return [f"CANCELLED. The match with {name} is no longer open, likely because they left. Still looking."]
    return None


def cmd_leave(_args: argparse.Namespace) -> list[str]:
    identity = load_identity(create=False)
    if identity is None:
        return ["NOTHING TO DELETE. This student has no campus-connect data on this device."]
    api("DELETE", "/api/me", identity)
    for name in ("identity.json", "state.json"):
        try:
            (data_dir() / name).unlink()
        except FileNotFoundError:
            pass
    return ["LEFT. All of your campus-connect data is deleted from the server and this device."]


def cmd_status(_args: argparse.Namespace) -> list[str]:
    identity = load_identity(create=False)
    if identity is None:
        return ["NOT JOINED. The student has not joined campus-connect yet."]
    state = load_state()
    tz = _student_tz(state)
    result = api("GET", "/api/matches", identity)
    lines: list[str] = []
    requests = _dicts(result.get("requests"))
    if not requests:
        lines.append("No open requests.")
    for r in requests:
        until = describe_moment(r.get("expires_at"), tz) or "unknown"
        lines.append(f"Request: {_what(r)}, '{clean(r.get('topic'))}', {clean(r.get('status'), 20)}, until {until}")
    matches = _dicts(result.get("matches"))
    for m in matches:
        lines.append("")
        lines.extend(report_match(m, tz))
    if not matches:
        lines.append("No matches yet.")
    return lines


# ---------- entry point ----------


class Parser(argparse.ArgumentParser):
    """Turns argparse's multi-line usage errors into one ERROR line."""

    def error(self, message: str) -> NoReturn:
        raise UsageError(message)


def build_parser() -> argparse.ArgumentParser:
    parser = Parser(prog="connect.py", description="campus-connect client")
    sub = parser.add_subparsers(dest="command", required=True)

    join = sub.add_parser("join", help="add or update a request")
    join.add_argument("--kind", help="study, project, ride, buddy or food")
    join.add_argument("--name", required=True, help="student's first name")
    join.add_argument("--contact", required=True, help="phone or email to share after a mutual yes")
    join.add_argument("--course", help='course, for study, like "CSE 310"')
    join.add_argument("--campus", help='campus, for project, ride, buddy and food, like "ASU Tempe"')
    join.add_argument("--event", help='event, for any kind, like "Cubbie Hackathon"; open to any school')
    join.add_argument("--topic", help="what to study, the project, the ride's destination, or the activity")
    join.add_argument("--can-help", action="append", default=[], help="what they can help with or offer (repeat or comma list)")
    join.add_argument("--free", action="append", default=[], help="free time START/END in ISO 8601 (repeatable)")
    join.add_argument("--tz", help="the student's time zone, used for free times written without one")
    join.set_defaults(run=cmd_join)

    check = sub.add_parser("check", help="report only what is new")
    check.set_defaults(run=cmd_check)

    respond = sub.add_parser("respond", help="answer a proposed match")
    respond.add_argument("--match", required=True, help="match id from check")
    answer = respond.add_mutually_exclusive_group(required=True)
    answer.add_argument("--accept", action="store_true")
    answer.add_argument("--decline", action="store_true")
    respond.set_defaults(run=cmd_respond)

    leave = sub.add_parser("leave", help="delete all of the student's data")
    leave.set_defaults(run=cmd_leave)

    status = sub.add_parser("status", help="show requests and matches")
    status.set_defaults(run=cmd_status)
    return parser


def _print_error(line: str) -> None:
    print(clean(line, 600))


def main(argv: Optional[list[str]] = None) -> int:
    try:
        args = build_parser().parse_args(argv)
        emit(args.run(args))
    except UsageError as e:
        _print_error(f"ERROR. USAGE. {e}. Fix the command and run it again.")
        return 2
    except ConnectError as e:
        _print_error(e.line())
        return 1
    except Exception as e:  # last resort, so a student never sees a stack trace
        _print_error(f"ERROR. Something unexpected went wrong in campus-connect ({type(e).__name__}). Try again later.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
