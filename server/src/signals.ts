// Signal schema for PUT /api/context: validation, normalization, the reject list and freshness.
// Pure functions, no I/O. Callers pass `now`.

import type { TimeWindow } from "./match.js";
import { LIMITS, isContact, isRecord, isoDate } from "./validate.js";
import type { Result } from "./validate.js";

export const SIGNAL_TYPES = [
  "enrolled_in",
  "working_on",
  "attending",
  "interested_in",
  "can_help_with",
  "applying_to",
  "open_to",
] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

export const ENTITY_KINDS = ["course", "assignment", "event", "topic", "company", "activity"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const SOURCES = ["canvas", "calendar", "email", "memory", "student"] as const;
export type Source = (typeof SOURCES)[number];

export const ACTIVITIES = ["study", "teammates", "rides", "mentoring", "meals", "buddies"] as const;
export type Activity = (typeof ACTIVITIES)[number];

export const DISCOVERABLE = ["section", "school", "network"] as const;
export type Discoverable = (typeof DISCOVERABLE)[number];

export const INTROS = ["ask", "auto_study"] as const;
export type Intro = (typeof INTROS)[number];

const includes = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

export interface Signal {
  type: SignalType;
  entity: { kind: EntityKind; key: string; label: string };
  detail?: string;
  when?: string;
  due?: string;
  source: Source;
  /** Server time of the last sync that sent this signal. */
  observed_at: string;
  expires_at: string;
}

export interface Policy {
  participating: boolean;
  discoverable: Discoverable;
  intro: Intro;
  share_events: boolean;
  share_applications: boolean;
  max_suggestions_per_week: number;
  school?: string;
  /** Required while participating. */
  first_name?: string;
  contact?: string;
}

export const DEFAULT_POLICY: Omit<Policy, "first_name"> = {
  participating: true,
  discoverable: "school",
  intro: "ask",
  share_events: false,
  share_applications: false,
  max_suggestions_per_week: defaultPerWeek(),
};

function defaultPerWeek(): number {
  const raw = process.env.SUPERCUB_MAX_PER_WEEK;
  const n = raw === undefined ? 3 : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 7 ? n : 3;
}

export const CONTEXT_LIMITS = {
  signalsPerCall: 60,
  signalsStored: 200,
  label: 120,
  detail: 120,
  school: 60,
  windows: 10,
  maxPerWeek: 7,
} as const;

const DAY_MS = 24 * 3_600_000;

// ---------- normalization ----------

/** Lowercase, punctuation stripped, spaces collapsed. Course codes also drop spaces: "CSE 310" is "cse310". */
export function normalizeEntityKey(kind: EntityKind, label: string): string {
  const words = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return kind === "course" ? words.replace(/ /g, "") : words;
}

/** Collapses whitespace in free text. */
const clean = (text: string): string => text.trim().replace(/\s+/g, " ");

// ---------- reject list and PII stripping ----------

const EMAIL_IN_TEXT = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const PHONE_IN_TEXT = /\+?\d[\d\s().-]{6,}\d/g;
const URL_IN_TEXT = /\bhttps?:\/\/\S+/gi;

function digitCount(text: string): number {
  return (text.match(/\d/g) ?? []).length;
}

/** True when the text carries something that looks like an email address or a phone number. */
export function hasContactInfo(text: string): boolean {
  if (new RegExp(EMAIL_IN_TEXT.source).test(text)) return true;
  return (text.match(PHONE_IN_TEXT) ?? []).some((m) => digitCount(m) >= 10);
}

/** Removes anything that looks like an email address or a phone number. */
export function stripContactInfo(text: string): string {
  return clean(
    text
      .replace(EMAIL_IN_TEXT, "")
      .replace(PHONE_IN_TEXT, (m) => (digitCount(m) >= 10 ? "" : m)),
  );
}

export function hasUrl(text: string): boolean {
  return new RegExp(URL_IN_TEXT.source, "i").test(text);
}

const GRADE_WORDS = /\b(grades?|graded|scores?|scored|gpa|marks?|points?|pts)\b/i;
const GRADE_NUMBERS = /\b\d{1,3}(\.\d+)?\s*(\/\s*\d{1,3}\b|%)/;
const EMAIL_HEADER = /^\s*(re|fw|fwd|subject)\s*:/i;
const FINE_LOCATION = [
  /\b(room|rm\.?|apt\.?|apartment|dorm|suite|floor|unit)\s*#?\s*\d+/i,
  /\b\d+\s+([a-z]+\s+){0,3}(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court)\b/i,
];
/** Words that make a calendar or email event look public, like a hackathon or a career fair. */
const PUBLIC_EVENT_WORDS =
  /\b(hackathon|career fair|fair|club|talk|workshop|meetup|conference|seminar|info session|symposium|expo|festival|panel|game|tournament|showcase|lecture series|networking|summit)\b/i;

/** Returns a reason when a piece of free text must never be stored, or null when it is fine. */
function forbiddenText(text: string): string | null {
  if (GRADE_WORDS.test(text) || GRADE_NUMBERS.test(text)) return "looks like a grade or score";
  if (EMAIL_HEADER.test(text)) return "looks like an email subject";
  if (FINE_LOCATION.some((re) => re.test(text))) return "location is finer than campus";
  if (hasUrl(text)) return "links are not accepted";
  return null;
}

/** Which entity kinds each signal type may carry. Types not listed accept any kind but activity. */
const KINDS_FOR_TYPE: Partial<Record<SignalType, readonly EntityKind[]>> = {
  enrolled_in: ["course"],
  attending: ["event"],
  applying_to: ["company"],
  open_to: ["activity"],
};

// ---------- freshness ----------

/** When a signal stops counting. Re-sending the same (type, key) refreshes it. */
export function signalExpiry(type: SignalType, observed: Date, when?: string, due?: string): Date {
  const t = observed.getTime();
  switch (type) {
    case "working_on":
      return new Date(due !== undefined ? Date.parse(due) + DAY_MS : t + 21 * DAY_MS);
    case "attending":
      return new Date(when !== undefined ? Date.parse(when) + DAY_MS : t + 30 * DAY_MS);
    case "interested_in":
    case "can_help_with":
    case "open_to":
      return new Date(t + 60 * DAY_MS);
    case "enrolled_in":
      return new Date(t + 120 * DAY_MS);
    case "applying_to":
      return new Date(t + 45 * DAY_MS);
  }
}

export function isFresh(signal: Signal, now: Date): boolean {
  return Date.parse(signal.expires_at) > now.getTime();
}

export const signalId = (s: Pick<Signal, "type" | "entity">): string => `${s.type}:${s.entity.key}`;

// ---------- parsing ----------

function optionalIso(value: unknown, label: string): Result<string | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  const parsed = isoDate(value, label);
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.value.toISOString() };
}

/** Validates one signal. Never throws; returns a reason when the signal must not be stored. */
export function parseSignal(raw: unknown, policy: Policy, now: Date): Result<Signal> {
  const fail = (error: string): Result<Signal> => ({ ok: false, error });
  if (!isRecord(raw)) return fail("signal must be an object");
  if (!includes(SIGNAL_TYPES, raw.type)) return fail(`type must be one of: ${SIGNAL_TYPES.join(", ")}`);
  const type = raw.type;
  if (type === "attending" && !policy.share_events) return fail("share_events is off");
  if (type === "applying_to" && !policy.share_applications) return fail("share_applications is off");

  const entity = raw.entity;
  if (!isRecord(entity)) return fail("entity must be an object with kind and label");
  if (!includes(ENTITY_KINDS, entity.kind)) return fail(`entity.kind must be one of: ${ENTITY_KINDS.join(", ")}`);
  const kind = entity.kind;
  const allowedKinds = KINDS_FOR_TYPE[type];
  if (allowedKinds !== undefined ? !allowedKinds.includes(kind) : kind === "activity") {
    return fail(`entity.kind ${kind} does not fit type ${type}`);
  }
  if (typeof entity.label !== "string") return fail("entity.label is required");
  const label = clean(entity.label);
  if (label.length === 0) return fail("entity.label is empty");
  if (label.length > CONTEXT_LIMITS.label) return fail(`entity.label is over ${CONTEXT_LIMITS.label} characters`);
  if (hasContactInfo(label)) return fail("entity.label contains contact info");
  const labelProblem = forbiddenText(label);
  if (labelProblem !== null) return fail(`entity.label ${labelProblem}`);
  const key = normalizeEntityKey(kind, label);
  if (key.length < 2) return fail("entity.label needs at least 2 letters or numbers");
  if (type === "open_to" && !includes(ACTIVITIES, key)) {
    return fail(`open_to must be one of: ${ACTIVITIES.join(", ")}`);
  }

  if (!includes(SOURCES, raw.source)) return fail(`source must be one of: ${SOURCES.join(", ")}`);
  const source = raw.source;
  if (source === "email" && type !== "attending") return fail("only public events are accepted from email");
  if (type === "attending" && (source === "calendar" || source === "email") && !PUBLIC_EVENT_WORDS.test(label)) {
    return fail("event does not look like a public event");
  }

  let detail: string | undefined;
  if (raw.detail !== undefined && raw.detail !== null) {
    if (typeof raw.detail !== "string") return fail("detail must be text");
    const trimmed = clean(raw.detail);
    if (trimmed.length > CONTEXT_LIMITS.detail) return fail(`detail is over ${CONTEXT_LIMITS.detail} characters`);
    const detailProblem = forbiddenText(trimmed);
    if (detailProblem !== null) return fail(`detail ${detailProblem}`);
    const stripped = stripContactInfo(trimmed);
    if (stripped.length > 0) detail = stripped;
  }

  const when = optionalIso(raw.when, "when");
  if (!when.ok) return fail(when.error);
  const due = optionalIso(raw.due, "due");
  if (!due.ok) return fail(due.error);
  const observed = optionalIso(raw.observed_at, "observed_at");
  if (!observed.ok) return fail(observed.error);

  const expires = signalExpiry(type, now, when.value, due.value);
  if (expires.getTime() <= now.getTime()) return fail("already expired");

  const signal: Signal = {
    type,
    entity: { kind, key, label },
    source,
    observed_at: now.toISOString(),
    expires_at: expires.toISOString(),
  };
  if (detail !== undefined) signal.detail = detail;
  if (when.value !== undefined) signal.when = when.value;
  if (due.value !== undefined) signal.due = due.value;
  return { ok: true, value: signal };
}

/** Merges incoming fields over the stored policy, then the defaults. */
export function parsePolicy(raw: unknown, stored: Policy | null): Result<Policy> {
  const fail = (error: string): Result<Policy> => ({ ok: false, error });
  if (raw !== undefined && !isRecord(raw)) return fail("policy must be an object.");
  const p = raw ?? {};
  const base: Partial<Policy> = stored ?? {};
  const out: Partial<Policy> = { ...DEFAULT_POLICY, ...base };

  for (const field of ["participating", "share_events", "share_applications"] as const) {
    const value = p[field];
    if (value === undefined) continue;
    if (typeof value !== "boolean") return fail(`policy.${field} must be true or false.`);
    out[field] = value;
  }
  if (p.discoverable !== undefined) {
    if (!includes(DISCOVERABLE, p.discoverable)) return fail(`policy.discoverable must be ${DISCOVERABLE.join(", ")}.`);
    out.discoverable = p.discoverable;
  }
  if (p.intro !== undefined) {
    if (!includes(INTROS, p.intro)) return fail(`policy.intro must be ${INTROS.join(" or ")}.`);
    out.intro = p.intro;
  }
  if (p.max_suggestions_per_week !== undefined) {
    const n = p.max_suggestions_per_week;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > CONTEXT_LIMITS.maxPerWeek) {
      return fail(`policy.max_suggestions_per_week must be a whole number from 0 to ${CONTEXT_LIMITS.maxPerWeek}.`);
    }
    out.max_suggestions_per_week = n;
  }
  if (p.school !== undefined) {
    if (typeof p.school !== "string" || clean(p.school).length > CONTEXT_LIMITS.school) {
      return fail(`policy.school must be text, at most ${CONTEXT_LIMITS.school} characters.`);
    }
    const school = clean(p.school);
    if (school.length > 0) out.school = school;
    else delete out.school;
  }
  if (p.first_name !== undefined) {
    if (typeof p.first_name !== "string") return fail("policy.first_name must be text.");
    const name = clean(p.first_name);
    if (name.length < 1 || name.length > LIMITS.firstName) {
      return fail(`policy.first_name must be 1 to ${LIMITS.firstName} characters.`);
    }
    out.first_name = name;
  }
  if (p.contact !== undefined) {
    if (typeof p.contact !== "string") return fail("policy.contact must be text.");
    const contact = clean(p.contact);
    if (contact.length === 0) delete out.contact;
    else if (contact.length > LIMITS.contact || !isContact(contact)) {
      return fail("policy.contact must be a phone number or an email address.");
    } else out.contact = contact;
  }
  if (out.participating === true && out.first_name === undefined) {
    return fail("policy.first_name is required while participating.");
  }
  return { ok: true, value: out as Policy };
}

/** Free windows: up to 10, ISO with offset, ending within 14 days. Past ones are dropped. */
export function parseFree(raw: unknown, now: Date): Result<TimeWindow[]> {
  const fail = (error: string): Result<TimeWindow[]> => ({ ok: false, error });
  if (!Array.isArray(raw)) return fail("free must be a list of {start, end}.");
  const items: unknown[] = raw;
  if (items.length > CONTEXT_LIMITS.windows) return fail(`free can list at most ${CONTEXT_LIMITS.windows} times.`);
  const latest = now.getTime() + LIMITS.windowDays * DAY_MS;
  const out: TimeWindow[] = [];
  for (const [i, item] of items.entries()) {
    if (!isRecord(item)) return fail(`free[${i}] must have a start and an end.`);
    const start = isoDate(item.start, `free[${i}].start`);
    if (!start.ok) return fail(start.error);
    const end = isoDate(item.end, `free[${i}].end`);
    if (!end.ok) return fail(end.error);
    if (end.value <= start.value) return fail(`free[${i}] must end after it starts.`);
    if (end.value.getTime() > latest) return fail(`free[${i}] is more than ${LIMITS.windowDays} days away.`);
    if (end.value <= now) continue;
    out.push({ start: start.value.toISOString(), end: end.value.toISOString() });
  }
  out.sort((a, b) => a.start.localeCompare(b.start));
  return { ok: true, value: out };
}

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** UTC offset in minutes of an IANA zone at a moment, like -420 for America/Phoenix. */
export function zoneOffsetMinutes(tz: string, at: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(at);
    const name = parts.find((part) => part.type === "timeZoneName")?.value ?? "";
    const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
    if (match === null) return name === "GMT" ? 0 : null;
    const minutes = Number(match[2]) * 60 + Number(match[3] ?? "0");
    return match[1] === "-" ? -minutes : minutes;
  } catch {
    return null;
  }
}
