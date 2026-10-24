// Input validation. Every function returns either a value or a plain-English error.

import { KINDS, allowedGroupTypes, defaultGroupType, isGroupType, isKind, normalizeGroup } from "./match.js";
import type { GroupType, Kind, TimeWindow } from "./match.js";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(error: string): Result<T> => ({ ok: false, error });

export const LIMITS = {
  firstName: 40,
  contact: 100,
  group: 60,
  topic: 200,
  canHelpItems: 10,
  canHelpItem: 80,
  windows: 10,
  /** Free windows must end within this many days from now. */
  windowDays: 14,
} as const;

export interface JoinInput {
  first_name: string;
  contact: string;
  kind: Kind;
  group_type: GroupType;
  /** The course, campus or event. */
  group: string;
  topic: string;
  can_help: string[];
  free: TimeWindow[];
  /** UTC offset of the first free time, like -420 for -07:00. */
  utc_offset_minutes: number;
}

export interface RespondInput {
  match_id: string;
  accept: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9][0-9 ().-]{5,}$/;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function isToken(value: string): boolean {
  return TOKEN_RE.test(value);
}

/** A phone number or an email address, the contact tiers accepted today. */
export function isContact(value: string): boolean {
  return EMAIL_RE.test(value) || PHONE_RE.test(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(
  body: Record<string, unknown>,
  field: string,
  max: number,
  min = 1,
): Result<string> {
  const value = body[field];
  if (typeof value !== "string") return fail(`${field} is required and must be text.`);
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length < min) return fail(`${field} is too short.`);
  if (trimmed.length > max) return fail(`${field} must be at most ${max} characters.`);
  return ok(trimmed);
}

export function isoDate(value: unknown, label: string): Result<Date> {
  if (typeof value !== "string" || !ISO_RE.test(value)) {
    return fail(`${label} must be an ISO 8601 time with a time zone, like 2026-10-25T14:00:00-07:00.`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return fail(`${label} is not a real date.`);
  return ok(new Date(ms));
}

/** -420 for "...-07:00", 0 for "...Z". Only called on strings that passed ISO_RE. */
function offsetMinutes(iso: string): number {
  const match = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  if (match === null) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

function windows(value: unknown, now: Date): Result<{ free: TimeWindow[]; offset: number }> {
  if (!Array.isArray(value) || value.length === 0) {
    return fail("free must list at least one free time.");
  }
  const items: unknown[] = value;
  if (items.length > LIMITS.windows) {
    return fail(`free can list at most ${LIMITS.windows} free times.`);
  }
  const out: TimeWindow[] = [];
  let offset: number | null = null;
  const latestAllowed = now.getTime() + LIMITS.windowDays * 24 * 3_600_000;
  for (const [i, item] of items.entries()) {
    if (!isRecord(item)) return fail(`free[${i}] must have a start and an end.`);
    const start = isoDate(item.start, `free[${i}].start`);
    if (!start.ok) return start;
    const end = isoDate(item.end, `free[${i}].end`);
    if (!end.ok) return end;
    if (end.value <= start.value) return fail(`free[${i}] must end after it starts.`);
    if (end.value.getTime() > latestAllowed) {
      return fail(`free[${i}] is more than ${LIMITS.windowDays} days away.`);
    }
    if (end.value <= now) continue; // already over, drop it
    if (offset === null && typeof item.start === "string") offset = offsetMinutes(item.start);
    out.push({ start: start.value.toISOString(), end: end.value.toISOString() });
  }
  if (out.length === 0) return fail("All the free times are in the past.");
  out.sort((a, b) => a.start.localeCompare(b.start));
  return ok({ free: out, offset: offset ?? 0 });
}

export function parseJoin(body: unknown, now: Date): Result<JoinInput> {
  if (!isRecord(body)) return fail("Request body must be a JSON object.");

  const firstName = text(body, "first_name", LIMITS.firstName);
  if (!firstName.ok) return firstName;

  const contact = text(body, "contact", LIMITS.contact, 3);
  if (!contact.ok) return contact;
  if (!isContact(contact.value)) {
    return fail("contact must be a phone number or an email address.");
  }

  if (!isKind(body.kind)) return fail(`kind must be one of: ${KINDS.join(", ")}.`);
  const kind = body.kind;

  // The group is a course (study) or a campus (everything else), or an event for any kind.
  const allowed = allowedGroupTypes(kind);
  const groupType = body.group_type ?? defaultGroupType(kind);
  if (!isGroupType(groupType) || !allowed.includes(groupType)) {
    return fail(`group_type for ${kind} must be ${allowed.join(" or ")}.`);
  }
  const group = text(body, "group", LIMITS.group);
  if (!group.ok) return fail(`group must be the ${groupType}, at most ${LIMITS.group} characters.`);
  if (normalizeGroup(groupType, group.value).length < 2) {
    return fail(`group must be the ${groupType}, with at least 2 letters or numbers.`);
  }

  const topic = text(body, "topic", LIMITS.topic, 2);
  if (!topic.ok) return topic;

  const rawHelp = body.can_help ?? [];
  if (!Array.isArray(rawHelp)) return fail("can_help must be a list of text.");
  const helpItems: unknown[] = rawHelp;
  if (helpItems.length > LIMITS.canHelpItems) {
    return fail(`can_help can list at most ${LIMITS.canHelpItems} things.`);
  }
  const canHelp: string[] = [];
  for (const item of helpItems) {
    if (typeof item !== "string") return fail("can_help must be a list of text.");
    const trimmed = item.trim().replace(/\s+/g, " ");
    if (trimmed.length === 0) continue;
    if (trimmed.length > LIMITS.canHelpItem) {
      return fail(`Each can_help item must be at most ${LIMITS.canHelpItem} characters.`);
    }
    canHelp.push(trimmed);
  }

  const free = windows(body.free, now);
  if (!free.ok) return free;

  return ok({
    first_name: firstName.value,
    contact: contact.value,
    kind,
    group_type: groupType,
    group: group.value,
    topic: topic.value,
    can_help: canHelp,
    free: free.value.free,
    utc_offset_minutes: free.value.offset,
  });
}

export function parseRespond(body: unknown): Result<RespondInput> {
  if (!isRecord(body)) return fail("Request body must be a JSON object.");
  const matchId = body.match_id;
  if (typeof matchId !== "string" || !isUuid(matchId)) {
    return fail("match_id must be a match id from check.");
  }
  if (typeof body.accept !== "boolean") return fail("accept must be true or false.");
  return ok({ match_id: matchId.toLowerCase(), accept: body.accept });
}
