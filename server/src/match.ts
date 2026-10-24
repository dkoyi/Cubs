// Pure matching logic. No I/O, no clock: callers pass `now`.

export interface TimeWindow {
  /** ISO 8601 in UTC, for example 2026-10-25T21:00:00.000Z */
  start: string;
  end: string;
}

/** What the student is looking for. */
export const KINDS = ["study", "project", "ride", "buddy", "food"] as const;
export type Kind = (typeof KINDS)[number];

export function isKind(value: unknown): value is Kind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

/** Who is in the same pool: a course, a campus, or an event like a hackathon (open to any school). */
export const GROUP_TYPES = ["course", "campus", "event"] as const;
export type GroupType = (typeof GROUP_TYPES)[number];

export function isGroupType(value: unknown): value is GroupType {
  return typeof value === "string" && (GROUP_TYPES as readonly string[]).includes(value);
}

/** Study is grouped by course or event; everything else by campus or event. */
export function allowedGroupTypes(kind: Kind): readonly GroupType[] {
  return kind === "study" ? ["course", "event"] : ["campus", "event"];
}

export function defaultGroupType(kind: Kind): GroupType {
  return kind === "study" ? "course" : "campus";
}

export interface ConnectRequest {
  student_id: string;
  first_name: string;
  contact: string;
  kind: Kind;
  group_type: GroupType;
  /** The course, campus or event, as the student typed it. */
  group: string;
  /** Normalized group, for matching. */
  group_key: string;
  /** What to study, the project, the ride's destination, or the activity. */
  topic: string;
  can_help: string[];
  free: TimeWindow[];
  /** The student's UTC offset, from their first free time, for writing times they read. */
  utc_offset_minutes: number;
  created_at: string;
  expires_at: string;
  /** The match this request is part of, if any. */
  match_id: string | null;
}

export interface Proposal {
  candidate: ConnectRequest;
  time: TimeWindow;
  score: number;
}

/** How long a proposed meetup is, and so how much shared free time it needs. */
export const MEETING_MINUTES: Readonly<Record<Kind, number>> = {
  study: 60,
  project: 60,
  ride: 30,
  buddy: 60,
  food: 60,
};
/** A proposed meeting starts at least this long after now, so both students have time to answer. */
export const MIN_LEAD_MINUTES = 30;
/** Proposed start times are rounded up to this mark, like 2:15 or 2:30. */
export const START_STEP_MINUTES = 15;
export const MAX_REQUEST_HOURS = 72;

const MINUTE_MS = 60_000;

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "for",
  "from", "get", "help", "how", "i", "im", "in", "into", "is", "it", "its",
  "me", "my", "of", "on", "or", "so", "some", "stuck", "study", "studying",
  "that", "the", "their", "them", "this", "to", "understand", "understanding",
  "up", "want", "with", "work", "working", "need", "needs", "looking",
  "someone", "teammate", "partner",
]);

/** Uppercase letters and digits only, accents and punctuation dropped: "cse-310", "CSE 310" and "cse310" all become "CSE310". */
export function normalizeKey(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^\p{L}\p{N}\p{M}]/gu, "")
    .normalize("NFC");
}

/** Long campus names that mean the same as a short one. Applied to the start of a normalized key. */
const CAMPUS_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["ARIZONASTATEUNIVERSITY", "ASU"],
  ["ARIZONASTATE", "ASU"],
];

/** `key` without `suffix` at the end, unless that would leave nothing. */
function dropSuffix(key: string, suffix: string): string {
  return key.length > suffix.length && key.endsWith(suffix) ? key.slice(0, -suffix.length) : key;
}

/**
 * Matching key for a course, campus or event.
 * - Course: case, spaces and punctuation only.
 * - Campus: also drops a trailing "campus" and shortens a few long names,
 *   so "Arizona State University, Tempe campus" is "ASUTEMPE".
 * - Event: also drops a leading "the" and a trailing year ("2026" or "'26"), so "Cubbie Hackathon 2026"
 *   is "CUBBIEHACKATHON". Events are not tied to a campus: students from any school share the pool.
 */
export function normalizeGroup(type: GroupType, text: string): string {
  if (type === "event") text = text.replace(/\s*['’]\d\d\s*$/, ""); // "Cubbie Hackathon '26"
  const key = normalizeKey(text);
  if (type === "course") return key;
  if (type === "event") {
    const noYear = key.length > 4 && /(19|20)\d\d$/.test(key) ? key.slice(0, -4) : key;
    return noYear.length > 3 && noYear.startsWith("THE") ? noYear.slice(3) : noYear;
  }
  let campus = dropSuffix(key, "CAMPUS");
  for (const [long, short] of CAMPUS_PREFIXES) {
    if (campus.startsWith(long)) {
      campus = short + campus.slice(long.length);
      break;
    }
  }
  return campus;
}

/** Lowercase content words, stopwords and one-letter tokens removed. */
export function topicWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(words.filter((w) => w.length > 1 && !STOPWORDS.has(w)));
}

function intersect(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((w) => b.has(w)).sort();
}

/** Words both students used in their topics. */
export function sharedTopicWords(a: ConnectRequest, b: ConnectRequest): string[] {
  return intersect(topicWords(a.topic), topicWords(b.topic));
}

/**
 * Bonus for each direction where one student's topic overlaps what the other can help with.
 * Projects weigh it higher than a shared topic word, so complementary skills win.
 */
export const HELP_BONUS: Readonly<Record<Kind, number>> = {
  study: 2,
  project: 3,
  ride: 2,
  buddy: 2,
  food: 2,
};
/**
 * Below this, the two students have nothing in common, so they are not proposed.
 * Food has no minimum: anyone free for a meal at the same time fits, and shared words rank higher.
 */
export const MIN_SCORE: Readonly<Record<Kind, number>> = {
  study: 1,
  project: 1,
  ride: 1,
  buddy: 1,
  food: 0,
};

/** Topic word overlap, plus HELP_BONUS for each direction where a topic overlaps the other's can-help. */
export function score(a: ConnectRequest, b: ConnectRequest): number {
  const bonus = HELP_BONUS[a.kind];
  let total = sharedTopicWords(a, b).length;
  if (intersect(topicWords(a.topic), topicWords(b.can_help.join(" "))).length > 0) total += bonus;
  if (intersect(topicWords(b.topic), topicWords(a.can_help.join(" "))).length > 0) total += bonus;
  return total;
}

/** `now` plus MIN_LEAD_MINUTES, rounded up to the next START_STEP_MINUTES mark. */
export function earliestStart(now: Date): number {
  const stepMs = START_STEP_MINUTES * MINUTE_MS;
  return Math.ceil((now.getTime() + MIN_LEAD_MINUTES * MINUTE_MS) / stepMs) * stepMs;
}

/**
 * First stretch of `meetingMinutes` that both students are free, starting no
 * earlier than earliestStart(now). Returns null if no overlap is long enough.
 */
export function firstMeetingTime(
  a: TimeWindow[],
  b: TimeWindow[],
  now: Date,
  meetingMinutes: number = MEETING_MINUTES.study,
): TimeWindow | null {
  const nowMs = earliestStart(now);
  const needMs = meetingMinutes * MINUTE_MS;
  let best: number | null = null;
  for (const wa of a) {
    for (const wb of b) {
      const start = Math.max(Date.parse(wa.start), Date.parse(wb.start), nowMs);
      const end = Math.min(Date.parse(wa.end), Date.parse(wb.end));
      if (end - start >= needMs && (best === null || start < best)) {
        best = start;
      }
    }
  }
  if (best === null) return null;
  return {
    start: new Date(best).toISOString(),
    end: new Date(best + needMs).toISOString(),
  };
}

/** End of the latest free window, or 72 hours after creation, whichever is earlier. */
export function requestExpiry(free: TimeWindow[], createdAt: Date): Date {
  const latestEnd = Math.max(...free.map((w) => Date.parse(w.end)));
  const cap = createdAt.getTime() + MAX_REQUEST_HOURS * 60 * MINUTE_MS;
  return new Date(Math.min(latestEnd, cap));
}

export function isExpired(req: ConnectRequest, now: Date): boolean {
  return Date.parse(req.expires_at) <= now.getTime();
}

/**
 * Pick the best match for `me` from `candidates`.
 * `candidates` should already be limited to open requests (not in an active match).
 * `excluded` holds student ids that `me` declined, or that declined `me`, in this pool.
 * Candidates need the same kind and group, a score of at least MIN_SCORE for the kind, and a meeting
 * time before both requests expire.
 * Best = highest score, then earliest meeting time, then who joined first.
 */
export function pickBest(
  me: ConnectRequest,
  candidates: ConnectRequest[],
  excluded: ReadonlySet<string>,
  now: Date,
): Proposal | null {
  let best: Proposal | null = null;
  for (const c of candidates) {
    if (c.student_id === me.student_id) continue;
    if (c.kind !== me.kind || c.group_type !== me.group_type || c.group_key !== me.group_key) continue;
    if (excluded.has(c.student_id)) continue;
    if (isExpired(c, now)) continue;
    const proposalScore = score(me, c);
    if (proposalScore < MIN_SCORE[me.kind]) continue;
    const time = firstMeetingTime(me.free, c.free, now, MEETING_MINUTES[me.kind]);
    if (time === null) continue;
    // A meeting after either request expires would outlive the records it is shown from.
    if (Date.parse(time.end) > Math.min(Date.parse(me.expires_at), Date.parse(c.expires_at))) continue;
    const proposal: Proposal = { candidate: c, time, score: proposalScore };
    if (best === null || isBetter(proposal, best)) best = proposal;
  }
  return best;
}

function isBetter(p: Proposal, q: Proposal): boolean {
  if (p.score !== q.score) return p.score > q.score;
  if (p.time.start !== q.time.start) return p.time.start < q.time.start;
  return p.candidate.created_at < q.candidate.created_at;
}

// ---------- why this match ----------

/** Longest reason the server sends. */
export const MAX_REASON_CHARS = 200;
const MAX_REASON_WORDS = 3;
const MAX_REASON_NAME = 20;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Topic words in the order they first appear in `text`. */
function orderedWords(text: string): string[] {
  const keep = topicWords(text);
  const out: string[] = [];
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (keep.has(w) && !out.includes(w)) out.push(w);
  }
  return out;
}

/** Words of `need` that also appear in `offer`, in the order of `need`, at most three. */
function overlapWords(need: string, offer: string): string[] {
  const offered = topicWords(offer);
  return orderedWords(need)
    .filter((w) => offered.has(w))
    .slice(0, MAX_REASON_WORDS);
}

/** True when what `me` can help with covers part of what `them` needs. */
export function canHelp(me: ConnectRequest, them: ConnectRequest): boolean {
  return overlapWords(them.topic, me.can_help.join(" ")).length > 0;
}

/** The shared free stretch that holds the proposed meeting, from the meeting start to the end of the overlap. */
export function sharedWindow(a: TimeWindow[], b: TimeWindow[], meeting: TimeWindow): TimeWindow {
  const start = Date.parse(meeting.start);
  let end = Date.parse(meeting.end);
  for (const wa of a) {
    for (const wb of b) {
      const s = Math.max(Date.parse(wa.start), Date.parse(wb.start));
      const e = Math.min(Date.parse(wa.end), Date.parse(wb.end));
      if (s <= start && e > end) end = e;
    }
  }
  return { start: meeting.start, end: new Date(end).toISOString() };
}

function clock(local: Date): { text: string; half: "am" | "pm" } {
  const hours = local.getUTCHours();
  const minutes = local.getUTCMinutes();
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return {
    text: minutes === 0 ? `${h12}` : `${h12}:${String(minutes).padStart(2, "0")}`,
    half: hours < 12 ? "am" : "pm",
  };
}

/** "Sat Oct 25, 2 to 4 pm" or "Sat Oct 25, 11:30 am to 1 pm", at the given UTC offset. */
export function describeSpan(window: TimeWindow, offsetMinutes: number): string {
  const shift = offsetMinutes * MINUTE_MS;
  const start = new Date(Date.parse(window.start) + shift);
  const end = new Date(Date.parse(window.end) + shift);
  const a = clock(start);
  const b = clock(end);
  const day = `${DAYS[start.getUTCDay()] ?? ""} ${MONTHS[start.getUTCMonth()] ?? ""} ${start.getUTCDate()}`;
  const range = a.half === b.half ? `${a.text} to ${b.text} ${b.half}` : `${a.text} ${a.half} to ${b.text} ${b.half}`;
  return `${day}, ${range}`;
}

/**
 * One line telling `me` why `them` was proposed, like
 * "You're both free Sat Oct 25, 2 to 4 pm. Maya knows react, you offer backend."
 * Built only from validated fields: a capped first name, the free times, and topic words
 * (lowercase letters and digits), so it carries no instructions or markup from the other student.
 */
export function matchReason(me: ConnectRequest, them: ConnectRequest, meeting: TimeWindow): string {
  const name = them.first_name.slice(0, MAX_REASON_NAME).trim();
  const offset = Number.isFinite(me.utc_offset_minutes) ? me.utc_offset_minutes : 0;
  const when = `You're both free ${describeSpan(sharedWindow(me.free, them.free, meeting), offset)}.`;
  const theyOffer = overlapWords(me.topic, them.can_help.join(" ")).join(" ");
  const iOffer = overlapWords(them.topic, me.can_help.join(" ")).join(" ");
  const shared = overlapWords(me.topic, them.topic).join(" ");
  let why = "";
  if (theyOffer && iOffer) why = `${name} knows ${theyOffer}, you offer ${iOffer}.`;
  else if (theyOffer) why = `${name} can help with ${theyOffer}.`;
  else if (iOffer) why = `${name} needs ${iOffer}, which you offer.`;
  else if (shared) why = me.kind === "ride" ? `You're both headed to ${shared}.` : `You both mentioned ${shared}.`;
  else if (me.kind === "food") why = "You're both up for a meal.";
  const reason = `${when} ${why}`.trim();
  return reason.length <= MAX_REASON_CHARS ? reason : `${reason.slice(0, MAX_REASON_CHARS - 3).trimEnd()}...`;
}
