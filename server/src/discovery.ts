// Discovery rules: who may be paired, the prefilter score, the suggestion kind, the rules-only
// suggestion text, and the guard on model-written text. Pure functions, no I/O.

import { firstMeetingTime, normalizeGroup } from "./match.js";
import type { TimeWindow } from "./match.js";
import { hasContactInfo, hasUrl, isFresh, normalizeEntityKey, signalId } from "./signals.js";
import type { Activity, Policy, Signal, SignalType } from "./signals.js";

export interface StudentContext {
  student_id: string;
  policy: Policy;
  signals: Signal[];
  free: TimeWindow[];
  tz?: string;
  updated_at: string;
}

const DAY_MS = 24 * 3_600_000;
/** Pairs scoring below this are not considered. */
export const PREFILTER_MIN = 0.5;
/** At most this many candidates per student go to the judge. */
export const CANDIDATES_PER_STUDENT = 3;
/** Shared free time needed for the overlap bonus and for the meeting window. */
export const MEETING_MINUTES = 60;

const fresh = (c: StudentContext, now: Date): Signal[] => c.signals.filter((s) => isFresh(s, now));

function keysOf(signals: Signal[], types: readonly SignalType[]): Set<string> {
  return new Set(signals.filter((s) => types.includes(s.type)).map((s) => s.entity.key));
}

const within = (iso: string | undefined, now: Date, days: number): boolean => {
  if (iso === undefined) return false;
  const t = Date.parse(iso);
  return t >= now.getTime() && t <= now.getTime() + days * DAY_MS;
};

// ---------- who may be paired ----------

export function sameSchool(a: Policy, b: Policy): boolean {
  if (a.school === undefined || b.school === undefined) return false;
  return normalizeGroup("campus", a.school) === normalizeGroup("campus", b.school);
}

/** True when both are enrolled in the same course with the same section detail. */
function sameSection(a: Signal[], b: Signal[]): boolean {
  return a.some(
    (x) =>
      x.type === "enrolled_in" &&
      x.detail !== undefined &&
      b.some(
        (y) =>
          y.type === "enrolled_in" &&
          y.entity.key === x.entity.key &&
          y.detail !== undefined &&
          normalizeEntityKey("topic", y.detail) === normalizeEntityKey("topic", x.detail ?? ""),
      ),
  );
}

function allows(owner: StudentContext, other: StudentContext, now: Date): boolean {
  switch (owner.policy.discoverable) {
    case "network":
      return true;
    case "school":
      return sameSchool(owner.policy, other.policy);
    case "section":
      return sameSection(fresh(owner, now), fresh(other, now));
  }
}

/** Each student's discoverability setting must allow the other. */
export function discoverableTo(a: StudentContext, b: StudentContext, now: Date): boolean {
  return allows(a, b, now) && allows(b, a, now);
}

// ---------- shared signals and score ----------

/** "type:key" for every signal both students have with the same type and key, sorted. */
export function sharedSignals(a: StudentContext, b: StudentContext, now: Date): string[] {
  const theirs = new Set(fresh(b, now).map(signalId));
  return [...new Set(fresh(a, now).map(signalId))].filter((id) => theirs.has(id)).sort();
}

/** Entity keys present in both students' signals, whatever the signal type. */
export function sharedKeys(a: StudentContext, b: StudentContext, now: Date): Set<string> {
  const theirs = new Set(fresh(b, now).map((s) => s.entity.key));
  return new Set(fresh(a, now).map((s) => s.entity.key).filter((k) => theirs.has(k)));
}

const NEEDS: readonly SignalType[] = ["working_on", "interested_in"];

/** Keys `helper` can help with that `other` is working on or interested in. */
function helpKeys(helper: Signal[], other: Signal[]): string[] {
  const needs = keysOf(other, NEEDS);
  return [...keysOf(helper, ["can_help_with"])].filter((k) => needs.has(k));
}

function sharedSignalsOf(a: Signal[], b: Signal[], type: SignalType): Array<[Signal, Signal]> {
  const out: Array<[Signal, Signal]> = [];
  for (const x of a) {
    if (x.type !== type) continue;
    const y = b.find((s) => s.type === type && s.entity.key === x.entity.key);
    if (y !== undefined) out.push([x, y]);
  }
  return out;
}

export function sharedActivities(a: StudentContext, b: StudentContext, now: Date): Activity[] {
  return sharedSignalsOf(fresh(a, now), fresh(b, now), "open_to").map(([x]) => x.entity.key as Activity);
}

/** True when the two free lists share at least an hour in the next 7 days, at least 30 minutes out. */
export function freeOverlap(a: TimeWindow[], b: TimeWindow[], now: Date): TimeWindow | null {
  const meeting = firstMeetingTime(a, b, now, MEETING_MINUTES);
  if (meeting === null || Date.parse(meeting.start) > now.getTime() + 7 * DAY_MS) return null;
  return meeting;
}

/** The rules prefilter, 0 to 1. */
export function prefilterScore(a: StudentContext, b: StudentContext, now: Date): number {
  const sa = fresh(a, now);
  const sb = fresh(b, now);
  let score = 0;
  if (sharedSignalsOf(sa, sb, "enrolled_in").length > 0) score += 0.3;
  const assignments = sharedSignalsOf(sa, sb, "working_on").filter(
    ([x, y]) => x.entity.kind === "assignment" && (within(x.due, now, 7) || within(y.due, now, 7)),
  );
  if (assignments.length > 0) score += 0.3;
  const events = sharedSignalsOf(sa, sb, "attending").filter(
    ([x, y]) => within(x.when, now, 14) || within(y.when, now, 14),
  );
  if (events.length > 0) score += 0.3;
  if (helpKeys(sa, sb).length > 0 || helpKeys(sb, sa).length > 0) score += 0.3;
  if (sharedActivities(a, b, now).length > 0) score += 0.2;
  if (freeOverlap(a.free, b.free, now) !== null) score += 0.1;
  return Math.min(1, Math.round(score * 100) / 100);
}

/** What the suggestion is for, from the open_to activities both share, or else from what they share. */
export function suggestionKind(a: StudentContext, b: StudentContext, now: Date): Activity {
  const activities = sharedActivities(a, b, now);
  if (activities.includes("study")) return "study";
  const first = activities[0];
  if (first !== undefined) return first;
  const sa = fresh(a, now);
  const sb = fresh(b, now);
  if (helpKeys(sa, sb).length > 0 || helpKeys(sb, sa).length > 0) return "mentoring";
  if (sharedSignalsOf(sa, sb, "enrolled_in").length > 0 || sharedSignalsOf(sa, sb, "working_on").length > 0) {
    return "study";
  }
  if (sharedSignalsOf(sa, sb, "attending").length > 0) return "teammates";
  return "buddies";
}

// ---------- rules text ----------

const ACTIVITY_PHRASE: Readonly<Record<Activity, string>> = {
  study: "studying with classmates",
  teammates: "finding teammates",
  rides: "sharing rides",
  mentoring: "mentoring",
  meals: "grabbing a meal",
  buddies: "meeting new people",
};

export const ASK_QUESTION = "Want me to see if you'd both like to connect?";

function joinClauses(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1] ?? ""}`;
}

/** The suggestion as `me` reads it. Built only from `me`'s own labels for entities both share. */
export function rulesText(me: StudentContext, other: StudentContext, now: Date): string {
  const mine = fresh(me, now);
  const theirs = fresh(other, now);
  const label = (key: string): string => mine.find((s) => s.entity.key === key)?.entity.label ?? key;

  const courses = sharedSignalsOf(mine, theirs, "enrolled_in").map(([x]) => x.entity.label);
  const events = sharedSignalsOf(mine, theirs, "attending").map(([x]) => x.entity.label);
  let start: string;
  let usedEvent = false;
  if (courses[0] !== undefined) start = `Someone in your ${courses[0]} class`;
  else if (events[0] !== undefined) {
    start = `Someone going to ${events[0]}`;
    usedEvent = true;
  } else if (sameSchool(me.policy, other.policy) && me.policy.school !== undefined) {
    start = `Someone at ${me.policy.school}`;
  } else start = "Someone on Super Cub";

  const clauses: string[] = [];
  for (const [x] of sharedSignalsOf(mine, theirs, "working_on")) clauses.push(`is working on ${x.entity.label} too`);
  if (!usedEvent) for (const e of events) clauses.push(`is going to ${e} too`);
  for (const k of helpKeys(theirs, mine)) clauses.push(`can help with ${label(k)}`);
  for (const k of helpKeys(mine, theirs)) clauses.push(`is working on ${label(k)}, which you can help with`);
  for (const [x] of sharedSignalsOf(mine, theirs, "interested_in")) clauses.push(`is also into ${x.entity.label}`);
  for (const [x] of sharedSignalsOf(mine, theirs, "can_help_with")) clauses.push(`can also help with ${x.entity.label}`);
  for (const activity of sharedActivities(me, other, now)) clauses.push(`is open to ${ACTIVITY_PHRASE[activity]}`);

  const picked = clauses.slice(0, 3);
  const body = picked.length > 0 ? `${start} ${joinClauses(picked)}.` : `${start} is on Super Cub too.`;
  return `${body} ${ASK_QUESTION}`;
}

export function rulesWhy(shared: string[], score: number): string {
  return `judge: rules. Prefilter ${score.toFixed(2)} from ${shared.join(", ") || "shared entities"}.`;
}

// ---------- model input and output guard ----------

export interface JudgeSignal {
  type: SignalType;
  kind: Signal["entity"]["kind"];
  label: string;
}

/**
 * Signals of the types both students have shared, limited to entities both students have.
 * Labels only: no details, names or contacts. The model never sees an entity only one student has,
 * so it cannot paraphrase one past guardText, and a crafted label reaches it only if both students sent it.
 */
export function mutualSignals(a: StudentContext, b: StudentContext, now: Date): [JudgeSignal[], JudgeSignal[]] {
  const sa = fresh(a, now);
  const sb = fresh(b, now);
  const typesB = new Set(sb.map((s) => s.type));
  const types = new Set(sa.map((s) => s.type).filter((t) => typesB.has(t)));
  const keys = sharedKeys(a, b, now);
  const view = (list: Signal[]): JudgeSignal[] =>
    list
      .filter((s) => types.has(s.type) && keys.has(s.entity.key))
      .map((s) => ({ type: s.type, kind: s.entity.kind, label: s.entity.label }));
  return [view(sa), view(sb)];
}

export const MAX_TEXT_CHARS = 400;

const names = (a: StudentContext, b: StudentContext): string[] =>
  [a.policy.first_name, b.policy.first_name].filter((n): n is string => n !== undefined && n.length > 0);

const words = (text: string): string => ` ${normalizeEntityKey("topic", text)} `;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Cleans model-written text for one student and checks it. Returns null (reject) when it carries a
 * name, contact details, a link or markup, or mentions an entity only one of the two students has.
 */
export function guardText(raw: unknown, a: StudentContext, b: StudentContext, now: Date): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim().replace(/\s+/g, " ");
  if (text.length < 10 || text.length > MAX_TEXT_CHARS) return null;
  if (hasContactInfo(text) || hasUrl(text) || /[<>`@]/.test(text)) return null; // "@" also blocks social handles
  for (const name of names(a, b)) {
    if (new RegExp(`(^|[^\\p{L}])${escapeRegExp(name)}($|[^\\p{L}])`, "iu").test(text)) return null;
  }
  const shared = sharedKeys(a, b, now);
  const normalized = words(text);
  const compact = normalized.replace(/ /g, "");
  for (const s of [...fresh(a, now), ...fresh(b, now)]) {
    if (shared.has(s.entity.key)) continue;
    if (normalized.includes(words(s.entity.label))) return null;
    if (s.entity.kind === "course" && s.entity.key.length >= 4 && compact.includes(s.entity.key)) return null;
  }
  return text;
}

/** Strips contact details and names from the model's reasoning before it is stored. */
export function guardWhy(raw: unknown, a: StudentContext, b: StudentContext): string {
  if (typeof raw !== "string") return "";
  let why = raw.trim().replace(/\s+/g, " ").slice(0, MAX_TEXT_CHARS);
  if (hasContactInfo(why) || hasUrl(why)) why = "(reasoning withheld: it contained contact details)";
  for (const name of names(a, b)) {
    why = why.replace(new RegExp(escapeRegExp(name), "giu"), "the student");
  }
  return why;
}
