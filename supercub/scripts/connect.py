#!/usr/bin/env python3
"""campus-connect client. Talks to the campus-connect server for one student.

Subcommands:
  join     add or update the student's request (study, project teammate, ride, buddy or food)
  check    report only what is new since the last check (for scheduled check-ins)
  respond  answer a proposed match with --accept or --decline
  leave    delete all of the student's data from the server and this device
  status   show everything: requests and matches
  sync     share the student's context file with the server, then report at most one suggestion
  answer   answer a suggestion from sync with yes, no or later
  policy   save who can be matched with the student and what they share (sent on the next sync)
  context  show what is stored on this device and the last sync's accepted and rejected counts
  delivered acknowledge a successfully relayed suggestion or contact message
  connections / feedback  inspect retained connections and record an explicit outcome
  identity export|import  privately back up or restore the same identity on another device

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
# This is the existing Super Cub host. Keep it stable; only send after the student's consent.
SERVER_URL = "https://supercub-server.vercel.app"
TIMEOUT_SECONDS = 15
# PUT /api/context can take about 60 s when the server's model judge runs. 90 s for that PUT plus
# 15 s for the GET that follows keeps a whole sync at 105 s, under Cubbie's 2-minute script limit.
SYNC_PUT_TIMEOUT_SECONDS = 90
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

# Sync (see research/loop-contract.md, "Signal schema" and "Policy").
SIGNAL_TYPES = ("enrolled_in", "working_on", "attending", "interested_in", "can_help_with", "applying_to", "open_to", "looking_for", "experienced_in")
ENTITY_KINDS = ("course", "assignment", "event", "topic", "company", "activity")
SOURCES = ("canvas", "calendar", "email", "memory", "student")
OPEN_TO = ("study", "teammates", "rides", "mentoring", "meals", "buddies", "advising", "collaboration")
DISCOVERABLE = ("section", "school", "network", "alumni")
MAX_SIGNALS = 60
MAX_DETAIL_CHARS = 120
MAX_LABEL_CHARS = 80
MAX_CONTEXT_BYTES = 512 * 1024
SKILL_RELEASE = "2026-10-profile-intros-v3"
SETUP_CAPABILITIES = ("context_snapshot", "profile_introductions", "automatic_introductions_v1", "delivery_ack", "context_versions")
POLICY_DEFAULTS: JsonDict = {
    "participating": False,  # only `policy --participating yes` turns this on: that is the student's yes
    "discoverable": "school",
    "intro": "ask",
    "share_events": False,
    "share_applications": False,
    "max_suggestions_per_week": 1,
    "life_stage": "student",
    "alumni_network": False,
    "remember_connections": False,
    "affiliations": [],
    "share_intro_profile": False,
}
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")
PHONE_RE = re.compile(
    r"(?<!\w)(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\w)"  # +1 (480) 555-0123
    r"|(?<!\w)\+\d[\d\s.-]{7,}\d(?!\w)"  # +44 20 7946 0958
    r"|(?<![\w-])\d{3}[.-]\d{4}(?![\w-])"  # 555-0123
)


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


def api(method: str, path: str, identity: JsonDict, body: Optional[JsonDict] = None,
        timeout: Optional[float] = None) -> JsonDict:
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
            "X-Student-Token": identity["token"],
            "X-Supercub-Delivery": "acknowledged",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "campus-connect-skill/1",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout if timeout is not None else TIMEOUT_SECONDS) as res:
            raw = res.read(MAX_REPLY_BYTES + 1)
    except urllib.error.HTTPError as e:
        payload = _error_payload(e)
        if e.code >= 500:
            raise ServerUnavailable(f"HTTP {e.code}") from None
        message = clean(payload.get("error"), 300) or f"HTTP {e.code}"
        if e.code == 401:
            raise ConnectError(f"The campus-connect server did not accept this device ({message}).",
                                tag="NOT RECOGNIZED", http_status=401, payload=payload) from None
        if e.code == 409 and message.startswith("CONTEXT CONFLICT."):
            raise ConnectError("Another device changed your profile. Run refresh, then review current choices before syncing.",
                               tag="CONTEXT CONFLICT", http_status=409) from None
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


def _unlink(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def cmd_leave(_args: argparse.Namespace) -> list[str]:
    identity = load_identity(create=False)
    if identity is None:
        _unlink(data_dir() / "policy.json")
        _unlink(context_path())
        return ["NOTHING TO DELETE. This student has no campus-connect data on this device."]
    api("DELETE", "/api/me", identity)
    for name in ("identity.json", "state.json", "policy.json"):
        _unlink(data_dir() / name)
    _unlink(context_path())
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


# ---------- sync ----------


def context_path() -> Path:
    """Where Cubbie writes the student's context for a sync."""
    return Path.home() / ".config" / "supercub" / "context.json"


def strip_contacts(text: str) -> str:
    """Remove anything that looks like an email address or a phone number."""
    text = PHONE_RE.sub(" ", EMAIL_RE.sub(" ", text))
    return " ".join(text.split()).strip(" ,;:-")


def _safe_text(value: object, limit: int) -> str:
    text = strip_contacts(clean(value, 1000))
    return clean(text, limit)


def load_policy() -> JsonDict:
    stored = _read_json(data_dir() / "policy.json") or {}
    policy = dict(POLICY_DEFAULTS)
    if isinstance(stored.get("participating"), bool):
        policy["participating"] = stored["participating"]
    if stored.get("intro") in ("ask", "automatic", "auto_study"):
        policy["intro"] = stored["intro"]
    if policy["intro"] == "automatic" and isinstance(stored.get("automatic_intro_consent"), dict):
        policy["automatic_intro_consent"] = stored["automatic_intro_consent"]
    if stored.get("discoverable") in DISCOVERABLE:
        policy["discoverable"] = stored["discoverable"]
    for flag in ("share_events", "alumni_network", "remember_connections", "share_intro_profile"):
        if isinstance(stored.get(flag), bool):
            policy[flag] = stored[flag]
    if stored.get("life_stage") in ("student", "alumni"):
        policy["life_stage"] = stored["life_stage"]
    policy["affiliations"] = _strings(stored.get("affiliations"))[:5]
    cap = stored.get("max_suggestions_per_week")
    if type(cap) is int and 0 <= cap <= 7:
        policy["max_suggestions_per_week"] = cap
    if not policy["alumni_network"]:
        policy["remember_connections"] = False
        if policy["discoverable"] == "alumni":
            policy["discoverable"] = "school"
    return policy


def _yes(value: str) -> bool:
    return value == "yes"


def describe_policy(policy: JsonDict) -> str:
    who = {"section": "people in your classes", "school": "anyone at your school",
           "network": "anyone on Super Cub", "alumni": "your approved university and alumni networks"}[policy["discoverable"]]
    return (f"Participating: {'yes' if policy['participating'] else 'no'}. Matched with: {who}. "
             f"Share events: {'yes' if policy['share_events'] else 'no'}. "
             f"Life stage: {policy['life_stage']}. Alumni network: {'yes' if policy['alumni_network'] else 'no'}. "
             f"Remember connections: {'yes' if policy['remember_connections'] else 'no'}. "
             f"Share intro profile: {'yes' if policy['share_intro_profile'] else 'no'}. Introductions: {policy['intro']}.")


def cmd_policy(args: argparse.Namespace) -> list[str]:
    fields = ("participating", "discoverable", "share_events", "alumni_network", "remember_connections", "life_stage", "affiliation", "max_per_week", "share_profile", "intro")
    if all(getattr(args, field) is None for field in fields) and not args.clear_affiliations:
        raise UsageError("give at least one policy flag, such as --participating or --alumni-network")
    stored = _read_json(data_dir() / "policy.json") or {}
    if args.intro == "ask" or args.participating == "no" or any(getattr(args, flag) is not None for flag in ("discoverable", "alumni_network", "share_events", "affiliation", "max_per_week")) or args.clear_affiliations:
        if stored.get("intro") == "automatic":
            stored["intro"] = "ask"
        stored.pop("automatic_intro_consent", None)
    if args.intro == "ask":
        stored["intro"] = "ask"
    if args.participating is not None:
        stored["participating"] = _yes(args.participating)
    if args.discoverable is not None:
        stored["discoverable"] = args.discoverable
    if args.share_events is not None:
        stored["share_events"] = _yes(args.share_events)
    if args.share_profile is not None:
        stored["share_intro_profile"] = _yes(args.share_profile)
    for flag in ("alumni_network", "remember_connections"):
        if getattr(args, flag) is not None:
            stored[flag] = _yes(getattr(args, flag))
    if args.life_stage is not None:
        stored["life_stage"] = args.life_stage
    if args.clear_affiliations:
        stored["affiliations"] = []
    if args.affiliation is not None:
        if len(args.affiliation) > 5 or any(not item.strip() or len(item) > 60 for item in args.affiliation):
            raise UsageError("give at most 5 short school affiliations")
        stored["affiliations"] = list(dict.fromkeys(args.affiliation))
    if args.max_per_week is not None:
        stored["max_suggestions_per_week"] = args.max_per_week
    if args.alumni_network == "no":
        stored["remember_connections"] = False
        if stored.get("discoverable") == "alumni":
            stored["discoverable"] = "school"
    if (stored.get("discoverable") == "alumni" or stored.get("remember_connections")) and not stored.get("alumni_network"):
        raise UsageError("alumni scope and retained connections require --alumni-network yes after explicit consent")
    _write_json(data_dir() / "policy.json", stored)
    state = load_state()
    state.pop("opt_out_sent", None)  # changed permissions must sync even while paused
    save_state(state)
    return [f"POLICY SAVED. {describe_policy(load_policy())} It goes to the server on the next sync."]


def read_context(path: Path) -> JsonDict:
    """The context file Cubbie wrote. Raises BAD CONTEXT if it is missing or not a JSON object."""
    try:
        with path.open("rb") as f:
            raw = f.read(MAX_CONTEXT_BYTES + 1)
    except FileNotFoundError:
        raise ConnectError(f"There is no context file at {path}. Fix: write it first, then sync.",
                           tag="BAD CONTEXT") from None
    except OSError as e:
        raise ConnectError(f"Could not read {path.name} ({e.strerror or 'read error'}).", tag="BAD CONTEXT") from None
    if len(raw) > MAX_CONTEXT_BYTES:
        raise ConnectError(f"{path.name} is too large. Fix: send at most {MAX_SIGNALS} signals.", tag="BAD CONTEXT")
    try:
        value = json.loads(raw.decode("utf-8"))
    except ValueError:
        raise ConnectError(f"{path.name} is not valid JSON. Fix: write it again in the shape of "
                           "assets/context-example.json.", tag="BAD CONTEXT") from None
    if not isinstance(value, dict):
        raise ConnectError(f"{path.name} must be a JSON object. Fix: write it in the shape of "
                           "assets/context-example.json.", tag="BAD CONTEXT")
    if "signals" in value and not isinstance(value["signals"], list):
        raise ConnectError(f"{path.name} has 'signals' that is not a list. Fix: make it a list.", tag="BAD CONTEXT")
    return value


def _iso(value: object, tz: Optional[tzinfo]) -> Optional[str]:
    """An ISO timestamp with an offset, or None if it is missing or unreadable."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        if tz is None:
            return None
        moment = moment.replace(tzinfo=tz)
    return moment.isoformat(timespec="seconds")


def clean_signal(raw: object, policy: JsonDict, tz: Optional[tzinfo], now: datetime) -> Optional[JsonDict]:
    """One signal ready to send, or None if it is malformed or the student's policy keeps it here."""
    if not isinstance(raw, dict):
        return None
    kind_of = raw.get("type")
    entity = raw.get("entity") if isinstance(raw.get("entity"), dict) else {}
    entity_kind = entity.get("kind")
    if kind_of not in SIGNAL_TYPES or entity_kind not in ENTITY_KINDS:
        return None
    # Mentioning something in chat does not grant permission to publish it.
    if not policy["share_events"] and (kind_of == "attending" or entity_kind == "event"):
        return None
    if not policy["share_applications"] and (kind_of == "applying_to" or entity_kind == "company"):
        return None
    if kind_of in ("can_help_with", "open_to", "looking_for", "experienced_in") and raw.get("source") not in ("memory", "student"):
        return None
    label = _safe_text(entity.get("label") or entity.get("key"), MAX_LABEL_CHARS)
    if not label:
        return None
    if kind_of == "open_to" and label.lower() not in OPEN_TO:
        return None
    confirmed = _iso(raw.get("confirmed_at"), tz)
    if policy["alumni_network"] and kind_of in ("can_help_with", "open_to", "looking_for") and confirmed is None:
        return None
    if confirmed is not None:
        moment = datetime.fromisoformat(confirmed)
        if moment > now + timedelta(minutes=5):
            return None
        days = 30 if kind_of == "looking_for" else 60
        if kind_of in ("can_help_with", "open_to", "looking_for") and moment + timedelta(days=days) <= now:
            return None
    signal: JsonDict = {
        "type": kind_of,
        "entity": {"kind": entity_kind, "key": label, "label": label},
        "source": raw.get("source") if raw.get("source") in SOURCES else "memory",
        "observed_at": _iso(raw.get("observed_at"), tz) or now.isoformat(timespec="seconds"),
    }
    detail = _safe_text(raw.get("detail"), MAX_DETAIL_CHARS)
    if detail:
        signal["detail"] = detail
    if confirmed is not None:
        signal["confirmed_at"] = confirmed
    if "topics" in raw:
        if not isinstance(raw["topics"], list) or len(raw["topics"]) > 5:
            return None
        topics = [_safe_text(item, 60) for item in raw["topics"]]
        if any(not topic for topic in topics):
            return None
        signal["topics"] = topics
    for field in ("when", "due"):
        moment = _iso(raw.get(field), tz)
        if moment:
            signal[field] = moment
    return signal


def _free_windows(raw: object, tz: Optional[tzinfo], now: datetime) -> list[JsonDict]:
    out: list[JsonDict] = []
    for item in _dicts(raw):
        start, end = item.get("start"), item.get("end")
        if not isinstance(start, str) or not isinstance(end, str):
            continue
        try:
            s, e = parse_window(f"{start}/{end}", tz, now)
        except ConnectError:
            continue  # past, malformed or too far away: leave it out rather than fail a scheduled run
        out.append({"start": s.isoformat(timespec="seconds"), "end": e.isoformat(timespec="seconds")})
        if len(out) == MAX_WINDOWS:
            break
    return out


def build_context(ctx: JsonDict, policy: JsonDict, now: datetime) -> tuple[JsonDict, int]:
    """The PUT /api/context body and how many signals were left out on this device."""
    tz_name = clean(ctx.get("tz"), 60)
    tz: Optional[tzinfo] = None
    if tz_name:
        try:
            tz = parse_tz(tz_name)
        except ConnectError:
            raise ConnectError(f"The context file's time zone '{tz_name}' is unknown. "
                               "Fix: use a name like America/Phoenix.", tag="BAD CONTEXT") from None
    given = ctx.get("policy") if isinstance(ctx.get("policy"), dict) else {}
    full_policy = dict(policy)
    if policy["share_intro_profile"]:
        full_policy["intro_profile"] = clean_intro_profile(given.get("intro_profile"))
    for field, limit in (("first_name", 40), ("school", 60), ("contact", 100)):
        value = clean(given.get(field), limit)
        if value:
            full_policy[field] = value
        elif field in ("school", "contact") and given.get(field) == "":
            full_policy[field] = ""  # explicit withdrawal must reach the server
    if full_policy["intro"] == "automatic":
        consent = full_policy.get("automatic_intro_consent")
        normalize = lambda value: re.sub(r"[^\w\s]", "", str(value).lower()).strip()
        valid = isinstance(consent, dict) and consent.get("contact") == full_policy.get("contact")
        if valid:
            valid = all(consent.get(flag) == full_policy.get(flag) for flag in ("discoverable", "alumni_network", "share_events", "share_applications"))
            valid = valid and normalize(consent.get("school", "")) == normalize(full_policy.get("school", ""))
            valid = valid and sorted(map(normalize, consent.get("affiliations", []))) == sorted(map(normalize, full_policy.get("affiliations", [])))
            valid = valid and type(consent.get("max_suggestions_per_week")) is int and full_policy["max_suggestions_per_week"] <= consent["max_suggestions_per_week"]
            approved = _moment(consent.get("approved_at"))
            valid = valid and approved is not None and approved <= now + timedelta(minutes=5) and approved + timedelta(days=365) > now
        if not valid:
            full_policy["intro"] = "ask"
            full_policy.pop("automatic_intro_consent", None)
    raw_signals = ctx.get("signals") if isinstance(ctx.get("signals"), list) else []
    signals = [s for s in (clean_signal(r, policy, tz, now) for r in raw_signals) if s is not None]
    skipped = len(raw_signals) - len(signals)
    if len(signals) > MAX_SIGNALS:
        skipped += len(signals) - MAX_SIGNALS
        signals = signals[:MAX_SIGNALS]
    body: JsonDict = {"policy": full_policy, "signals": signals, "replace_signals": True,
                      "free": _free_windows(ctx.get("free"), tz, now)}
    if tz_name:
        body["tz"] = tz_name
    return body, skipped


def _profile_url(value: object, kind: str = "website") -> str:
    if not isinstance(value, str) or len(value) > 400 or any(c.isspace() for c in value):
        return ""
    try:
        url = urllib.parse.urlsplit(value)
        host = (url.hostname or "").lower()
        if (url.scheme != "https" or url.username or url.password or url.port or url.query or url.fragment
                or "." not in host or re.fullmatch(r"[\d.]+", host) or ":" in host
                or re.search(r"(?:^|\.)(?:localhost|local|internal)$", host)):
            return ""
        if kind == "linkedin" and (host not in ("linkedin.com", "www.linkedin.com") or not re.fullmatch(r"/in/[^/]+/?", url.path)):
            return ""
        if kind == "github" and host not in ("github.com", "www.github.com"):
            return ""
        return value
    except ValueError:
        return ""


def clean_intro_profile(raw: object) -> JsonDict:
    if not isinstance(raw, dict):
        raise ConnectError("Add the approved intro profile to policy.intro_profile before sharing it.", tag="BAD CONTEXT")
    profile: JsonDict = {"links": []}
    for field, limit in (("name", 60), ("headline", 100), ("about", 240)):
        value = raw.get(field)
        if field != "name" and value in (None, ""):
            continue
        if (not isinstance(value, str) or not value.strip() or len(value) > limit or
                EMAIL_RE.search(value) or PHONE_RE.search(value) or re.search(r"[<>`@]", value)):
            raise ConnectError(f"The approved profile {field} is missing, too long or contains contact details.", tag="BAD CONTEXT")
        profile[field] = clean(value, limit)
    links = raw.get("links", [])
    if not isinstance(links, list) or len(links) > 3:
        raise ConnectError("An intro profile can contain up to three public links.", tag="BAD CONTEXT")
    for link in links:
        if not isinstance(link, dict) or link.get("kind") not in ("linkedin", "github", "website"):
            raise ConnectError("Use linkedin, github or website profile links.", tag="BAD CONTEXT")
        url = _profile_url(link.get("url"), link["kind"])
        if not url:
            raise ConnectError("Use public HTTPS profile links without private queries or credentials.", tag="BAD CONTEXT")
        profile["links"].append({"kind": link["kind"], "url": url})
    if raw.get("photo_url"):
        url = _profile_url(raw["photo_url"])
        if not url:
            raise ConnectError("Use an approved public HTTPS photo URL.", tag="BAD CONTEXT")
        profile["photo_url"] = url
    return profile


def _ask_lines(ask: JsonDict) -> list[str]:
    lines = [f"ASK {clean(ask.get('id'), 60)}", clean(ask.get("text"), 400)]
    raw = ask.get("profile")
    if not isinstance(raw, dict):
        return lines
    try:
        profile = clean_intro_profile(raw)
    except ConnectError:
        return lines
    lines.append(f"Profile: {profile['name']}")
    for field in ("headline", "about"):
        if profile.get(field):
            lines.append(f"{field.title()}: {profile[field]}")
    for link in profile["links"]:
        label = {"linkedin": "LinkedIn", "github": "GitHub", "website": "Website"}[link["kind"]]
        lines.append(f"{label}: {link['url']}")
    if profile.get("photo_url"):
        lines.append(f"Photo: {profile['photo_url']}")
    lines.append("Their permission: automatic introductions" if ask.get("other_consent") == "standing" else f"Their answer: {'yes' if ask.get('other_accepted') else 'pending'}")
    lines.append(f"Your answer: {'yes' if ask.get('you_accepted') else 'pending'}")
    return lines


def cmd_preview(args: argparse.Namespace) -> list[str]:
    identity = load_identity(create=False)
    if identity is None:
        raise ConnectError("Super Cub isn't set up on this device.", tag="NOT JOINED")
    try:
        result = api("GET", f"/api/suggestions?id={urllib.parse.quote(args.id, safe='')}", identity)
    except ConnectError as error:
        if error.http_status in (404, 410):
            return ["CLOSED. That introduction is no longer open."]
        raise
    ask = result.get("ask")
    return _ask_lines(ask) if isinstance(ask, dict) else ["CLOSED. That introduction is no longer open."]


def _agreed_lines(item: JsonDict, tz: tzinfo) -> list[str]:
    name = clean(item.get("first_name"), 40) or "The other student"
    lines = [
        f"AGREED {clean(item.get('id'), 60)}".rstrip(),
        clean(item.get("text"), 400) or f"You're on. {name} said yes too.",
        clean(item.get("contact"), 100) or "No contact given.",
    ]
    if isinstance(item.get("when"), dict):
        lines.append(f"Calendar times: {iso_range(item['when'], tz)}")
    reason = clean(item.get("reason"), 350)
    if reason and reason.rstrip(".") not in lines[1]:
        lines.append(f"Connection reason: {reason}")
    raw_profile = item.get("profile")
    if isinstance(raw_profile, dict):
        try:
            profile = clean_intro_profile(raw_profile)
        except ConnectError:
            pass
        else:
            lines.append(f"Profile: {profile['name']}")
            if profile.get("headline"):
                lines.append(f"Headline: {profile['headline']}")
            if profile.get("about"):
                lines.append(f"About: {profile['about']}")
            for link in profile["links"]:
                lines.append(f"{link['kind'].title()}: {link['url']}")
    return lines


def _remember_suggestion(state: JsonDict, sid: str, status: str) -> None:
    seen = state.get("suggestions") if isinstance(state.get("suggestions"), dict) else {}
    seen.pop(sid, None)
    seen[sid] = status
    while len(seen) > 100:
        del seen[next(iter(seen))]
    state["suggestions"] = seen


def cmd_sync(args: argparse.Namespace) -> list[str]:
    policy = load_policy()
    state = load_state()
    if not policy["participating"]:
        identity = load_identity(create=False)
        if identity is not None and state.get("opt_out_sent") is not True:
            # A timed-out PUT may have reached the server without saving last_sync locally.
            # Revoke once whenever an existing identity might have published context.
            revoked = {**policy, "intro": "ask"}
            revoked.pop("automatic_intro_consent", None)
            result = api("PUT", "/api/context", identity,
                         {"policy": revoked, "signals": [], "free": [], "context_version": state.get("context_version")},
                         timeout=SYNC_PUT_TIMEOUT_SECONDS)
            if isinstance(result.get("context_version"), str):
                state["context_version"] = result["context_version"]
            state.pop("last_sync", None)
            state["opt_out_sent"] = True
            save_state(state)
        return ["NOT PARTICIPATING. Nothing was shared."]

    ctx = read_context(Path(args.file).expanduser())
    now = utc_now()
    body, skipped = build_context(ctx, policy, now)
    body["context_version"] = state.get("context_version")
    release = getattr(args, "client_release", None) or (SKILL_RELEASE if policy["intro"] == "automatic" else None)
    if release:
        body["client_release"] = release
    if body.get("tz"):
        state["tz"] = body["tz"]
    identity = load_identity(create=True)
    if identity is None:
        raise ConnectError("Could not create a campus-connect identity on this device.")
    state.pop("opt_out_sent", None)
    save_state(state)  # persist the need to revoke even if the PUT response is lost
    result = api("PUT", "/api/context", identity, body, timeout=SYNC_PUT_TIMEOUT_SECONDS)
    if release and (result.get("skill_release") != release or result.get("intro_mode") != body["policy"]["intro"]):
        raise ConnectError("The server did not confirm this release and introduction mode. Do not claim setup succeeded.", tag="UPDATE REQUIRED")
    if isinstance(result.get("context_version"), str):
        state["context_version"] = result["context_version"]
    rejected = [
        f"#{clean(r.get('index'), 5)} {clean(r.get('reason'), 120)}" for r in _dicts(result.get("rejected"))
    ]
    state["last_sync"] = {
        "at": now.isoformat(timespec="seconds"),
        "sent": len(body["signals"]),
        "accepted": result.get("accepted") if isinstance(result.get("accepted"), int) else 0,
        "rejected": rejected[:10],
        "rejected_count": len(rejected),
        "skipped_here": skipped,
        "signals_total": result.get("signals_total") if isinstance(result.get("signals_total"), int) else None,
    }
    save_state(state)

    found = api("GET", "/api/suggestions", identity)
    seen = state.get("suggestions") if isinstance(state.get("suggestions"), dict) else {}
    tz = _student_tz(state)
    lines = ["NOTHING NEW"]
    for item in _dicts(found.get("agreed")):
        sid = clean(item.get("id"), 60) or clean(item.get("text"), 60)
        if sid and seen.get(sid) != "agreed":
            lines = _agreed_lines(item, tz)
            break
    else:
        ask = found.get("ask") if isinstance(found.get("ask"), dict) else {}
        sid, text = clean(ask.get("id"), 60), clean(ask.get("text"), 400)
        if sid and text and sid not in seen:
            lines = _ask_lines(ask)
    save_state(state)
    return lines


def cmd_answer(args: argparse.Namespace) -> list[str]:
    identity = load_identity(create=False)
    if identity is None:
        raise ConnectError("The student has not joined Super Cub yet.", tag="NOT JOINED")
    state = load_state()
    sid = clean(args.id, 60)
    if not sid:
        raise UsageError("the suggestion id is empty")
    path = f"/api/suggestions/{urllib.parse.quote(sid, safe='')}/answer"
    try:
        result = api("POST", path, identity, {"answer": args.answer})
    except ServerUnavailable:
        raise
    except ConnectError as e:
        if e.http_status in (404, 409, 410):
            return ["CLOSED. That suggestion is no longer open."]
        raise
    status = result.get("status")
    if status == "agreed":
        return _agreed_lines({**result, "id": sid}, _student_tz(state))
    if status == "passed":
        return ["PASSED"]
    if args.answer == "later":
        # The server asks again after 24 hours; let the next sync show it.
        seen = state.get("suggestions") if isinstance(state.get("suggestions"), dict) else {}
        seen.pop(sid, None)
        state["suggestions"] = seen
        save_state(state)
        return ["LATER. The server will ask again in about a day."]
    if status == "waiting":
        return ["WAITING"]
    raise ServerUnavailable("unreadable reply")


def cmd_delivered(args: argparse.Namespace) -> list[str]:
    identity = load_identity(create=False)
    if identity is None:
        raise ConnectError("Super Cub isn't set up on this device.", tag="NOT JOINED")
    sid = clean(args.id, 60)
    api("POST", f"/api/suggestions/{urllib.parse.quote(sid, safe='')}/delivered", identity, {"kind": args.kind})
    state = load_state()
    _remember_suggestion(state, sid, "agreed" if args.kind == "agreed" else "asked")
    save_state(state)
    return ["DELIVERED. Relay acknowledgment saved."]


def cmd_connections(args: argparse.Namespace) -> list[str]:
    identity = load_identity(create=False)
    if identity is None:
        raise ConnectError("Super Cub isn't set up on this device.", tag="NOT JOINED")
    if args.command == "feedback":
        api("POST", "/api/connections", identity, {"id": args.id, "outcome": args.outcome})
        return ["FEEDBACK SAVED. Your outcome stays private."]
    result = api("GET", "/api/connections", identity)
    lines = ["CONNECTIONS. Retained introductions, with your own feedback only."]
    for item in _dicts(result.get("connections"))[:50]:
        feedback = item.get("feedback") if isinstance(item.get("feedback"), dict) else {}
        lines.append(f"Connection id: {clean(item.get('id'), 60)}. Last connected: {clean(item.get('last_connected_at'), 30)}. "
                     f"Introductions: {clean(item.get('introductions'), 8)}. "
                     f"Met: {feedback.get('met')}. Useful: {feedback.get('useful')}.")
    if len(lines) == 1:
        lines.append("No retained connections.")
    return lines


def cmd_identity(args: argparse.Namespace) -> list[str]:
    path = Path(args.file).expanduser()
    if args.action == "export":
        identity = load_identity(create=False)
        if identity is None:
            raise ConnectError("No identity to back up.", tag="NOT JOINED")
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"version": 1, "server": server_url(), "identity": identity}, f)
        except OSError:
            raise ConnectError("Choose a new private backup file in an existing folder.", tag="BAD IDENTITY") from None
        return ["IDENTITY EXPORTED. Keep the backup private; it grants access to your Super Cub account. Never paste it into chat."]
    backup = read_context(path)
    identity = backup.get("identity")
    if not isinstance(identity, dict) or not isinstance(identity.get("token"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,200}", identity["token"]):
        raise ConnectError("This is not a valid identity backup.", tag="BAD IDENTITY")
    try:
        uuid.UUID(identity.get("student_id", ""))
    except (ValueError, TypeError, AttributeError):
        raise ConnectError("This is not a valid identity backup.", tag="BAD IDENTITY") from None
    if backup.get("version") != 1 or backup.get("server") != server_url():
        raise ConnectError("The backup belongs to a different service or version.", tag="BAD IDENTITY")
    existing = load_identity(create=False)
    if existing is not None and existing != identity:
        raise ConnectError("This device already has another identity. Restore on a fresh device.", tag="BAD IDENTITY")
    if context_path().exists() and existing is None:
        raise ConnectError("This device already has a context file. Restore on a fresh device.", tag="BAD IDENTITY")
    # Verify the token and load current remote choices before writing any credentials locally.
    context = api("GET", "/api/context", identity)
    if not isinstance(context.get("policy"), dict):
        raise ServerUnavailable("profile could not be read")
    context_path().parent.mkdir(parents=True, exist_ok=True)
    _write_json(context_path(), context)
    _write_json(data_dir() / "policy.json", context["policy"])
    _write_json(data_dir() / "identity.json", identity)
    save_state({"context_version": context.get("context_version")})
    return ["IDENTITY RESTORED. Your current sharing choices were recovered. Review them before your next sync."]


def cmd_refresh(_args: argparse.Namespace) -> list[str]:
    identity = load_identity(create=False)
    if identity is None:
        raise ConnectError("No identity to refresh.", tag="NOT JOINED")
    context = api("GET", "/api/context", identity)
    if not isinstance(context.get("policy"), dict):
        raise ServerUnavailable("profile could not be read")
    context_path().parent.mkdir(parents=True, exist_ok=True)
    _write_json(context_path(), context)
    _write_json(data_dir() / "policy.json", context["policy"])
    state = load_state()
    state["context_version"] = context.get("context_version")
    state.pop("opt_out_sent", None)
    save_state(state)
    return ["PROFILE REFRESHED. Current remote choices and signals replaced this device's snapshot. Review before syncing."]


def cmd_context(args: argparse.Namespace) -> list[str]:
    policy = load_policy()
    lines = [f"POLICY. {describe_policy(policy)}"]
    setup_release = load_state().get("setup_release")
    lines.append(f"Setup release: {clean(setup_release, 80)}." if setup_release else "Setup release: not yet approved for this version.")
    path = Path(args.file).expanduser()
    try:
        ctx = read_context(path)
    except ConnectError:
        lines.append(f"No readable context file at {path}.")
    else:
        try:
            body, skipped = build_context(ctx, policy, utc_now())
        except ConnectError as e:
            lines.append(e.line())
        else:
            lines.append(f"Context file: {len(body['signals'])} signals to send, {skipped} left out here, "
                          f"{len(body['free'])} free times.")
            lines.append(f"Prepared introductions: {body['policy']['intro']}.")
            for s in body["signals"]:
                extra = f" ({s['detail']})" if s.get("detail") else ""
                lines.append(f"- {s['type']} {s['entity']['kind']}: {s['entity']['label']}{extra}")
            profile = body["policy"].get("intro_profile")
            if isinstance(profile, dict):
                lines.append(f"Intro profile: {profile['name']}" + (f". {profile['headline']}" if profile.get("headline") else ""))
                if profile.get("about"):
                    lines.append(f"About: {profile['about']}")
                for link in profile["links"]:
                    lines.append(f"{link['kind']}: {link['url']}")
    last = load_state().get("last_sync")
    if isinstance(last, dict):
        lines.append(f"Last sync: {clean(last.get('at'), 40)}. Sent {clean(last.get('sent'), 5)}, "
                     f"accepted {clean(last.get('accepted'), 5)}, rejected {clean(last.get('rejected_count'), 5)}.")
        for reason in _strings(last.get("rejected")):
            lines.append(f"Rejected {reason}")
    else:
        lines.append("No sync yet.")
    return lines


def cmd_setup(args: argparse.Namespace) -> list[str]:
    """Apply one actually approved summary, preserving the person's existing identity."""
    ctx = read_context(Path(args.file).expanduser())
    given = ctx.get("policy") if isinstance(ctx.get("policy"), dict) else {}
    if given.get("participating") is not True or given.get("intro") not in ("ask", "automatic"):
        raise ConnectError("The approved setup must explicitly choose participation and introduction mode.", tag="BAD CONTEXT")
    at = _iso(args.approved_at, timezone.utc)
    if not at or datetime.fromisoformat(at) > utc_now() + timedelta(minutes=5) or datetime.fromisoformat(at) + timedelta(days=365) <= utc_now():
        raise ConnectError("Use the actual recent setup approval timestamp, not an invented or expired date.", tag="BAD CONTEXT")
    policy = load_policy()
    for flag in ("participating", "discoverable", "intro", "share_events", "share_intro_profile", "alumni_network", "remember_connections", "life_stage", "affiliations", "max_suggestions_per_week"):
        if flag in given:
            policy[flag] = given[flag]
    if (any(type(policy[flag]) is not bool for flag in ("participating", "share_events", "share_intro_profile", "alumni_network", "remember_connections")) or
            policy["discoverable"] not in DISCOVERABLE or policy["life_stage"] not in ("student", "alumni") or
            type(policy["max_suggestions_per_week"]) is not int or not 0 <= policy["max_suggestions_per_week"] <= 7 or
            not isinstance(policy["affiliations"], list) or len(policy["affiliations"]) > 5 or
            any(not isinstance(school, str) or not school.strip() or len(school) > 60 for school in policy["affiliations"]) or
            not clean(given.get("first_name"), 40) or
            (policy["discoverable"] in ("school", "section") and not clean(given.get("school"), 60)) or
            ((policy["remember_connections"] or policy["discoverable"] == "alumni") and not policy["alumni_network"])):
        raise ConnectError("The approved summary needs valid identity, scope and sharing choices.", tag="BAD CONTEXT")
    if policy["share_applications"] or given.get("share_applications") not in (None, False):
        raise ConnectError("Application sharing remains off in this client.", tag="BAD CONTEXT")
    policy.pop("automatic_intro_consent", None)
    if policy["intro"] == "automatic":
        contact = clean(given.get("contact"), 100)
        if not contact or not (EMAIL_RE.fullmatch(contact) or re.fullmatch(r"\+?[1-9]\d{7,14}", re.sub(r"[\s().-]", "", contact))):
            raise ConnectError("Automatic introductions require the person's explicitly chosen contact.", tag="BAD CONTEXT")
        activities = list(dict.fromkeys(clean(s.get("entity", {}).get("label"), 80).lower() for s in _dicts(ctx.get("signals"))
                                        if s.get("type") == "open_to" and isinstance(s.get("entity"), dict) and s.get("source") in ("student", "memory")))
        if not activities or any(activity not in OPEN_TO for activity in activities):
            raise ConnectError("The approved summary must name at least one connection activity.", tag="BAD CONTEXT")
        policy["automatic_intro_consent"] = {"approved_at": at, "contact": contact, "discoverable": policy["discoverable"],
            "school": clean(given.get("school"), 60), "affiliations": policy["affiliations"], "alumni_network": policy["alumni_network"],
            "share_events": policy["share_events"], "share_applications": False, "activities": activities,
            "max_suggestions_per_week": policy["max_suggestions_per_week"]}
    build_context(ctx, policy, utc_now())  # local validation before saving or making a network mutation
    identity = load_identity(create=False) or {"student_id": "", "token": ""}
    try:
        metadata = api("GET", "/api/capabilities", identity, timeout=5)
    except ConnectError as error:
        if error.http_status == 404:
            raise ConnectError("Publish the matching server release before running this Skill setup. Existing settings were not changed.", tag="UPDATE REQUIRED") from None
        raise
    if metadata.get("skill_release") != SKILL_RELEASE or not all(capability in _strings(metadata.get("capabilities")) for capability in SETUP_CAPABILITIES):
        raise ConnectError("The server has not confirmed this release. Existing settings were not changed.", tag="UPDATE REQUIRED")
    _write_json(data_dir() / "policy.json", policy)
    state = load_state()
    state.pop("opt_out_sent", None)
    save_state(state)
    lines = cmd_sync(argparse.Namespace(file=args.file, client_release=SKILL_RELEASE))
    state = load_state()
    state["setup_release"] = SKILL_RELEASE
    state["setup_approved_at"] = at
    save_state(state)
    return [f"SETUP COMPLETE. {SKILL_RELEASE}. Introductions: {policy['intro']}.", *lines]


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

    sync = sub.add_parser("sync", help="share the context file, then report at most one suggestion")
    sync.add_argument("--file", default=str(context_path()), help="the context JSON Cubbie wrote")
    sync.set_defaults(run=cmd_sync)

    answer_cmd = sub.add_parser("answer", help="answer a suggestion from sync")
    answer_cmd.add_argument("id", help="suggestion id from the ASK line")
    answer_cmd.add_argument("answer", choices=("yes", "no", "later"))
    answer_cmd.set_defaults(run=cmd_answer)

    policy = sub.add_parser("policy", help="save sharing choices for the next sync")
    policy.add_argument("--participating", choices=("yes", "no"))
    policy.add_argument("--discoverable", choices=DISCOVERABLE)
    policy.add_argument("--share-events", choices=("yes", "no"))
    policy.add_argument("--share-profile", choices=("yes", "no"))
    policy.add_argument("--intro", choices=("ask",), help="revoke automatic introductions; granting them requires approved setup")
    policy.add_argument("--alumni-network", choices=("yes", "no"))
    policy.add_argument("--remember-connections", choices=("yes", "no"))
    policy.add_argument("--life-stage", choices=("student", "alumni"))
    policy.add_argument("--affiliation", action="append", help="approved school affiliation; repeat to replace the list")
    policy.add_argument("--clear-affiliations", action="store_true")
    policy.add_argument("--max-per-week", type=int, choices=range(8))
    policy.set_defaults(run=cmd_policy)

    setup = sub.add_parser("setup", help="apply one approved sharing summary and sync without changing identity")
    setup.add_argument("--file", required=True)
    setup.add_argument("--approved-at", required=True, help="actual time the person approved the displayed setup")
    setup.set_defaults(run=cmd_setup)

    delivered = sub.add_parser("delivered", help="acknowledge a message only after relaying it")
    delivered.add_argument("id")
    delivered.add_argument("kind", choices=("ask", "agreed"))
    delivered.set_defaults(run=cmd_delivered)

    preview = sub.add_parser("preview", help="show current introduction details for a follow-up question")
    preview.add_argument("id")
    preview.set_defaults(run=cmd_preview)

    connections = sub.add_parser("connections", help="show retained introductions and your own feedback")
    connections.set_defaults(run=cmd_connections)
    feedback = sub.add_parser("feedback", help="record an explicit outcome for a retained connection")
    feedback.add_argument("id")
    feedback.add_argument("outcome", choices=("met", "did_not_meet", "useful", "not_useful", "reset"))
    feedback.set_defaults(run=cmd_connections)

    identity = sub.add_parser("identity", help="privately back up or restore your identity")
    identity.add_argument("action", choices=("export", "import"))
    identity.add_argument("--file", required=True)
    identity.set_defaults(run=cmd_identity)

    refresh = sub.add_parser("refresh", help="recover current remote choices after a stale-device conflict")
    refresh.set_defaults(run=cmd_refresh)

    context = sub.add_parser("context", help="show what is stored here and the last sync")
    context.add_argument("--file", default=str(context_path()), help="the context JSON to show")
    context.set_defaults(run=cmd_context)
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
