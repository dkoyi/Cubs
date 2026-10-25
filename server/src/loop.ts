// Context, discovery and suggestions on top of the Store.
//
// Keys:
//   ctx:{sid}            the student's context record: policy, signals, free windows, tz (JSON)
//   participants         set of student ids with participating = true
//   sugg:{id}            a suggestion between two students (JSON), holding both sides' answers
//   suggs:{sid}          set of suggestion ids the student is part of
//   spair:{lo}:{hi}      present while a pair is cooling down (30 days from a suggestion or a "no")

import { randomUUID } from "node:crypto";
import {
  CANDIDATES_PER_STUDENT,
  MEETING_MINUTES,
  PREFILTER_MIN,
  discoverableTo,
  guardText,
  guardWhy,
  mutualSignals,
  prefilterScore,
  rulesText,
  rulesWhy,
  sharedKeys,
  sharedSignals,
  suggestionKind,
} from "./discovery.js";
import type { StudentContext } from "./discovery.js";
import { JUDGE_THRESHOLD } from "./judge.js";
import type { Judge } from "./judge.js";
import { describeSpan, firstMeetingTime } from "./match.js";
import type { TimeWindow } from "./match.js";
import { CONTEXT_LIMITS, isFresh, isTimeZone, parseFree, parsePolicy, parseSignal, signalId, zoneOffsetMinutes } from "./signals.js";
import type { Activity, Signal } from "./signals.js";
import type { Store } from "./store.js";
import { isRecord } from "./validate.js";
import type { Result } from "./validate.js";

const DAY_SECONDS = 24 * 3600;
const HOUR_MS = 3_600_000;
const CONTEXT_TTL_SECONDS = 120 * DAY_SECONDS;
/** Suggestions are kept a little past the 30-day pair cooldown, so the weekly cap and cooldown can be read from them. */
const SUGGESTION_TTL_SECONDS = 31 * DAY_SECONDS;
const COOLDOWN_SECONDS = 30 * DAY_SECONDS;
/** A pair the model judged not worth it is not sent to the model again for this long. Caps judge calls per pair. */
const LOW_WORTH_COOLDOWN_SECONDS = 6 * 3600;
const ASK_HOURS = 48;
const LATER_HOURS = 24;
const WEEK_MS = 7 * 24 * HOUR_MS;

const k = {
  ctx: (sid: string) => `ctx:${sid}`,
  participants: "participants",
  sugg: (id: string) => `sugg:${id}`,
  suggs: (sid: string) => `suggs:${sid}`,
  pair: (a: string, b: string) => (a < b ? `spair:${a}:${b}` : `spair:${b}:${a}`),
};

function parseJson<T>(raw: string | null): T | null {
  return raw === null ? null : (JSON.parse(raw) as T);
}

// ---------- context ----------

export async function getContext(store: Store, sid: string): Promise<StudentContext | null> {
  return parseJson<StudentContext>(await store.get(k.ctx(sid)));
}

export interface ContextOutcome {
  accepted: number;
  rejected: Array<{ index: number; reason: string }>;
  signals_total: number;
}

/** Validates, normalizes and merges a PUT /api/context body into the student's context record. */
export async function putContext(store: Store, sid: string, body: unknown, now: Date): Promise<Result<ContextOutcome>> {
  const fail = (error: string): Result<ContextOutcome> => ({ ok: false, error });
  if (!isRecord(body)) return fail("Request body must be a JSON object.");
  const existing = await getContext(store, sid);

  const policy = parsePolicy(body.policy, existing?.policy ?? null);
  if (!policy.ok) return fail(policy.error);

  const rawSignals = body.signals ?? [];
  if (!Array.isArray(rawSignals)) return fail("signals must be a list.");
  const incoming: unknown[] = rawSignals;
  if (incoming.length > CONTEXT_LIMITS.signalsPerCall) {
    return fail(`signals can list at most ${CONTEXT_LIMITS.signalsPerCall} per call.`);
  }

  let free = (existing?.free ?? []).filter((w) => Date.parse(w.end) > now.getTime());
  if (body.free !== undefined && body.free !== null) {
    const parsed = parseFree(body.free, now);
    if (!parsed.ok) return fail(parsed.error);
    free = parsed.value;
  }

  let tz = existing?.tz;
  if (body.tz !== undefined) {
    if (typeof body.tz !== "string" || !isTimeZone(body.tz)) return fail("tz must be a time zone like America/Phoenix.");
    tz = body.tz;
  }

  const p = policy.value;
  // Drop expired signals, and any of a type the student has since stopped sharing.
  const byId = new Map<string, Signal>();
  if (p.participating) {
    for (const s of existing?.signals ?? []) {
      if (!isFresh(s, now)) continue;
      if (s.type === "attending" && !p.share_events && s.source !== "memory" && s.source !== "student") continue;
      if (s.type === "applying_to" && !p.share_applications) continue;
      byId.set(signalId(s), s);
    }
  }

  const rejected: ContextOutcome["rejected"] = [];
  let accepted = 0;
  for (const [index, raw] of incoming.entries()) {
    if (!p.participating) {
      rejected.push({ index, reason: "participating is off" });
      continue;
    }
    const parsed = parseSignal(raw, p, now);
    if (!parsed.ok) {
      rejected.push({ index, reason: parsed.error });
      continue;
    }
    const id = signalId(parsed.value);
    if (!byId.has(id) && byId.size >= CONTEXT_LIMITS.signalsStored) {
      rejected.push({ index, reason: `at most ${CONTEXT_LIMITS.signalsStored} signals are stored` });
      continue;
    }
    byId.set(id, parsed.value);
    accepted += 1;
  }

  // Opting out keeps nothing new: no signals and no free times, only the policy that says so.
  const ctx: StudentContext = {
    student_id: sid,
    policy: p,
    signals: [...byId.values()],
    free: p.participating ? free : [],
    updated_at: now.toISOString(),
  };
  if (tz !== undefined) ctx.tz = tz;
  await store.set(k.ctx(sid), JSON.stringify(ctx), CONTEXT_TTL_SECONDS);
  if (p.participating) await store.sadd(k.participants, sid);
  else {
    await store.srem(k.participants, sid);
    // Opting out closes open suggestions, so an earlier "yes" can no longer release this student's contact.
    for (const s of await listSuggestions(store, sid, now)) {
      if (isOpen(s)) await putSuggestion(store, { ...s, status: "passed" });
    }
  }
  return { ok: true, value: { accepted, rejected, signals_total: ctx.signals.length } };
}

// ---------- suggestions ----------

export type SuggestionStatus = "proposed" | "asked_a" | "asked_b" | "asked_both" | "agreed" | "passed" | "expired";

export interface SideState {
  asked_at: string | null;
  answer: "yes" | "no" | null;
  /** Set by "later": not asked again before this time. */
  later_until: string | null;
  later_used: boolean;
  /** True once this side has been sent the agreed outcome by GET /api/suggestions. */
  agreed_seen: boolean;
}

export interface Release {
  first_name: string;
  contact: string | null;
}

export interface Suggestion {
  id: string;
  a: string;
  b: string;
  kind: Activity;
  shared: string[];
  text_a: string;
  text_b: string;
  why: string;
  /** The judge's worth, or the prefilter score when the rules judged. */
  score: number;
  prefilter: number;
  judge: Judge["name"] | "rules";
  texts_from: "model" | "rules";
  status: SuggestionStatus;
  created_at: string;
  expires_at: string;
  side_a: SideState;
  side_b: SideState;
  when: TimeWindow | null;
  agreed_at: string | null;
  /** Filled at agreement: what each side releases to the other. */
  release_a: Release | null;
  release_b: Release | null;
}

const newSide = (): SideState => ({ asked_at: null, answer: null, later_until: null, later_used: false, agreed_seen: false });

const TERMINAL: ReadonlySet<SuggestionStatus> = new Set(["agreed", "passed", "expired"]);
export const isOpen = (s: Suggestion): boolean => !TERMINAL.has(s.status);

function askedStatus(s: Suggestion): SuggestionStatus {
  const a = s.side_a.asked_at !== null;
  const b = s.side_b.asked_at !== null;
  if (a && b) return "asked_both";
  if (a) return "asked_a";
  if (b) return "asked_b";
  return "proposed";
}

export async function getSuggestion(store: Store, id: string): Promise<Suggestion | null> {
  return parseJson<Suggestion>(await store.get(k.sugg(id)));
}

async function putSuggestion(store: Store, s: Suggestion): Promise<void> {
  await store.set(k.sugg(s.id), JSON.stringify(s), SUGGESTION_TTL_SECONDS);
}

/** Marks an open suggestion expired once its expires_at passes. */
async function settle(store: Store, s: Suggestion, now: Date): Promise<Suggestion> {
  if (isOpen(s) && Date.parse(s.expires_at) <= now.getTime()) {
    const expired: Suggestion = { ...s, status: "expired" };
    await putSuggestion(store, expired);
    return expired;
  }
  return s;
}

export async function listSuggestions(store: Store, sid: string, now: Date): Promise<Suggestion[]> {
  const out: Suggestion[] = [];
  for (const id of await store.smembers(k.suggs(sid))) {
    const s = await getSuggestion(store, id);
    if (s === null) await store.srem(k.suggs(sid), id);
    else out.push(await settle(store, s, now));
  }
  return out.sort((x, y) => x.created_at.localeCompare(y.created_at));
}

export async function hasOpenSuggestion(store: Store, sid: string, now: Date): Promise<boolean> {
  return (await listSuggestions(store, sid, now)).some(isOpen);
}

async function underWeeklyCap(store: Store, ctx: StudentContext, now: Date): Promise<boolean> {
  const since = now.getTime() - WEEK_MS;
  const recent = (await listSuggestions(store, ctx.student_id, now)).filter((s) => Date.parse(s.created_at) > since);
  return recent.length < ctx.policy.max_suggestions_per_week;
}

// ---------- discovery ----------

interface Candidate {
  other: StudentContext;
  prefilter: number;
}

/**
 * Looks for one new suggestion for this student among all other participating students.
 * Returns the suggestion it created, or null.
 */
export async function runDiscovery(store: Store, sid: string, now: Date, judge: Judge | null): Promise<Suggestion | null> {
  const me = await getContext(store, sid);
  if (me === null || !me.policy.participating) return null;
  if (await hasOpenSuggestion(store, sid, now)) return null;
  if (!(await underWeeklyCap(store, me, now))) return null;

  const candidates: Candidate[] = [];
  for (const otherId of await store.smembers(k.participants)) {
    if (otherId === sid) continue;
    const other = await getContext(store, otherId);
    if (other === null) {
      await store.srem(k.participants, otherId);
      continue;
    }
    if (!other.policy.participating || !discoverableTo(me, other, now)) continue;
    if (sharedKeys(me, other, now).size === 0) continue;
    const prefilter = prefilterScore(me, other, now);
    if (prefilter < PREFILTER_MIN) continue;
    if ((await store.get(k.pair(sid, otherId))) !== null) continue;
    if (await hasOpenSuggestion(store, otherId, now)) continue;
    if (!(await underWeeklyCap(store, other, now))) continue;
    candidates.push({ other, prefilter });
  }
  candidates.sort((x, y) => y.prefilter - x.prefilter || x.other.updated_at.localeCompare(y.other.updated_at));

  for (const { other, prefilter } of candidates.slice(0, CANDIDATES_PER_STUDENT)) {
    const shared = sharedSignals(me, other, now);
    let textA = rulesText(me, other, now);
    let textB = rulesText(other, me, now);
    let why = rulesWhy(shared, prefilter);
    let score = prefilter;
    let judgeName: Suggestion["judge"] = "rules";
    let textsFrom: Suggestion["texts_from"] = "rules";

    const [mutualA, mutualB] = mutualSignals(me, other, now);
    const verdict = judge === null ? null : await judge.judge({ shared, a: mutualA, b: mutualB, prefilter });
    if (verdict === null) {
      console.log(judge === null ? "judge: rules" : `judge: rules (${judge.name} gave no usable answer)`);
    } else {
      judgeName = judge?.name ?? "rules";
      score = verdict.worth;
      why = guardWhy(verdict.why, me, other);
      if (verdict.worth < JUDGE_THRESHOLD) {
        console.log(`judge: ${judgeName} worth ${verdict.worth.toFixed(2)} below ${JUDGE_THRESHOLD}, skipped`);
        await store.setIfAbsent(k.pair(sid, other.student_id), "low_worth", LOW_WORTH_COOLDOWN_SECONDS);
        continue;
      }
      const guardedA = guardText(verdict.text_for_a, me, other, now);
      const guardedB = guardText(verdict.text_for_b, me, other, now);
      if (guardedA !== null && guardedB !== null) {
        textA = guardedA;
        textB = guardedB;
        textsFrom = "model";
      } else {
        console.log(`judge: ${judgeName} texts rejected by the guard, using rules text`);
      }
    }

    const id = randomUUID();
    // Claiming the pair key first keeps two concurrent syncs from creating the same pair twice.
    if (!(await store.setIfAbsent(k.pair(sid, other.student_id), id, COOLDOWN_SECONDS))) continue;
    const suggestion: Suggestion = {
      id,
      a: sid,
      b: other.student_id,
      kind: suggestionKind(me, other, now),
      shared,
      text_a: textA,
      text_b: textB,
      why,
      score,
      prefilter,
      judge: judgeName,
      texts_from: textsFrom,
      status: "proposed",
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ASK_HOURS * HOUR_MS).toISOString(),
      side_a: newSide(),
      side_b: newSide(),
      when: null,
      agreed_at: null,
      release_a: null,
      release_b: null,
    };
    await putSuggestion(store, suggestion);
    await store.sadd(k.suggs(sid), id, SUGGESTION_TTL_SECONDS);
    await store.sadd(k.suggs(other.student_id), id, SUGGESTION_TTL_SECONDS);
    return suggestion;
  }
  return null;
}

/** Runs discovery for every participating student. For the optional cron. */
export async function discoverAll(store: Store, now: Date, judge: Judge | null): Promise<{ students: number; created: number }> {
  const ids = await store.smembers(k.participants);
  let created = 0;
  for (const sid of ids) {
    if ((await runDiscovery(store, sid, now, judge)) !== null) created += 1;
  }
  return { students: ids.length, created };
}

// ---------- views ----------

export interface AskView {
  id: string;
  text: string;
  kind: Activity;
  shared: string[];
  expires_at: string;
}

export interface AgreedView {
  id: string;
  first_name: string;
  contact: string | null;
  when: TimeWindow | null;
  text: string;
}

const sideOf = (s: Suggestion, sid: string): "a" | "b" => (s.a === sid ? "a" : "b");

const pad = (n: number): string => String(n).padStart(2, "0");

/** "2026-10-25T19:00:00-07:00": the instant written at the given UTC offset. */
export function isoAtOffset(iso: string, offsetMinutes: number): string {
  const local = new Date(Date.parse(iso) + offsetMinutes * 60_000).toISOString().slice(0, 19);
  const abs = Math.abs(offsetMinutes);
  return `${local}${offsetMinutes < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The agreed outcome as one student sees it, with times at that student's UTC offset. */
async function agreedView(store: Store, s: Suggestion, sid: string): Promise<AgreedView> {
  const other = (sideOf(s, sid) === "a" ? s.release_b : s.release_a) ?? { first_name: "", contact: null };
  const head = `You're on. ${other.first_name} said yes too.`;
  const view: AgreedView = { id: s.id, first_name: other.first_name, contact: other.contact, when: null, text: "" };
  if (s.when === null) return { ...view, text: `${head} Pick a time that works for you both.` };
  const ctx = await getContext(store, sid);
  const offset = (ctx?.tz === undefined ? null : zoneOffsetMinutes(ctx.tz, new Date(s.when.start))) ?? 0;
  return {
    ...view,
    when: { start: isoAtOffset(s.when.start, offset), end: isoAtOffset(s.when.end, offset) },
    text: `${head} ${describeSpan(s.when, offset)}.`,
  };
}

export interface SuggestionsOutcome {
  ask: AskView | null;
  agreed: AgreedView[];
  nothing_new: boolean;
}

/** GET /api/suggestions: at most one ask to relay now, plus agreed outcomes not yet delivered. */
export async function pendingFor(store: Store, sid: string, now: Date): Promise<SuggestionsOutcome> {
  const list = await listSuggestions(store, sid, now);

  const agreed: AgreedView[] = [];
  for (const s of list) {
    const side = sideOf(s, sid) === "a" ? s.side_a : s.side_b;
    if (s.status !== "agreed" || side.agreed_seen) continue;
    agreed.push(await agreedView(store, s, sid));
    const seen: SideState = { ...side, agreed_seen: true };
    await putSuggestion(store, sideOf(s, sid) === "a" ? { ...s, side_a: seen } : { ...s, side_b: seen });
  }

  let ask: AskView | null = null;
  for (const s of list) {
    if (!isOpen(s)) continue;
    const mine = sideOf(s, sid);
    const side = mine === "a" ? s.side_a : s.side_b;
    if (side.answer !== null) continue;
    if (side.later_until !== null && Date.parse(side.later_until) > now.getTime()) continue;
    const asked: SideState = {
      ...side,
      asked_at: side.later_until !== null || side.asked_at === null ? now.toISOString() : side.asked_at,
      later_until: null,
    };
    const updated: Suggestion = mine === "a" ? { ...s, side_a: asked } : { ...s, side_b: asked };
    updated.status = askedStatus(updated);
    await putSuggestion(store, updated);
    ask = {
      id: s.id,
      text: mine === "a" ? s.text_a : s.text_b,
      kind: s.kind,
      shared: s.shared,
      expires_at: s.expires_at,
    };
    break;
  }
  return { ask, agreed, nothing_new: ask === null && agreed.length === 0 };
}

// ---------- answers ----------

export type AnswerValue = "yes" | "no" | "later";

export type AnswerOutcome =
  | { kind: "not_found" }
  | { kind: "expired" }
  | { kind: "already_answered" }
  | { kind: "waiting" }
  | { kind: "later"; ask_again_at: string }
  | { kind: "passed" }
  | { kind: "agreed"; view: AgreedView };

async function release(store: Store, sid: string): Promise<Release> {
  const ctx = await getContext(store, sid);
  return { first_name: ctx?.policy.first_name ?? "", contact: ctx?.policy.contact ?? null };
}

/** POST /api/suggestions/:id/answer. */
export async function answerSuggestion(
  store: Store,
  sid: string,
  id: string,
  answer: AnswerValue,
  now: Date,
): Promise<AnswerOutcome> {
  const found = await getSuggestion(store, id);
  if (found === null || (found.a !== sid && found.b !== sid)) return { kind: "not_found" };
  const s = await settle(store, found, now);
  if (s.status === "agreed") return { kind: "agreed", view: await agreedView(store, s, sid) };
  if (s.status === "passed") {
    // The student who said no already answered; the other side learns it passed.
    const own = sideOf(s, sid) === "a" ? s.side_a : s.side_b;
    return own.answer === "no" ? { kind: "already_answered" } : { kind: "passed" };
  }
  if (s.status === "expired") return { kind: "expired" };

  const mine = sideOf(s, sid);
  const side = mine === "a" ? s.side_a : s.side_b;
  const theirs = mine === "a" ? s.side_b : s.side_a;
  if (side.answer !== null) return { kind: "already_answered" };
  const withSide = (next: SideState): Suggestion => (mine === "a" ? { ...s, side_a: next } : { ...s, side_b: next });

  // A second "later" counts as "no": "later" re-asks only once.
  const effective: AnswerValue = answer === "later" && side.later_used ? "no" : answer;

  if (effective === "later") {
    const until = new Date(now.getTime() + LATER_HOURS * HOUR_MS);
    const extended = new Date(Math.max(Date.parse(s.expires_at), until.getTime() + ASK_HOURS * HOUR_MS));
    await putSuggestion(store, {
      ...withSide({ ...side, later_until: until.toISOString(), later_used: true }),
      expires_at: extended.toISOString(),
    });
    return { kind: "later", ask_again_at: until.toISOString() };
  }

  if (effective === "no") {
    await putSuggestion(store, { ...withSide({ ...side, answer: "no", later_until: null }), status: "passed" });
    // Both sides cool down for this pair for 30 days from the "no".
    await store.set(k.pair(s.a, s.b), s.id, COOLDOWN_SECONDS);
    return { kind: "passed" };
  }

  const answered = withSide({ ...side, answer: "yes", later_until: null, asked_at: side.asked_at ?? now.toISOString() });
  if (theirs.answer !== "yes") {
    answered.status = askedStatus(answered);
    await putSuggestion(store, answered);
    return { kind: "waiting" };
  }

  // Both said yes: pick a meeting window and release first names and contacts to each other.
  const ctxA = await getContext(store, s.a);
  const ctxB = await getContext(store, s.b);
  const agreed: Suggestion = {
    ...answered,
    status: "agreed",
    agreed_at: now.toISOString(),
    when: firstMeetingTime(ctxA?.free ?? [], ctxB?.free ?? [], now, MEETING_MINUTES),
    release_a: await release(store, s.a),
    release_b: await release(store, s.b),
  };
  await putSuggestion(store, agreed);
  return { kind: "agreed", view: await agreedView(store, agreed, sid) };
}

// ---------- leaving ----------

/** Deletes the student's context, every suggestion they are part of (with both sides' answers) and their pair cooldowns. */
export async function deleteLoopData(store: Store, sid: string): Promise<void> {
  for (const id of await store.smembers(k.suggs(sid))) {
    const s = await getSuggestion(store, id);
    if (s !== null) {
      const otherId = s.a === sid ? s.b : s.a;
      await store.srem(k.suggs(otherId), id);
      await store.del([k.pair(s.a, s.b)]);
    }
    await store.del([k.sugg(id)]);
  }
  await store.srem(k.participants, sid);
  await store.del([k.ctx(sid), k.suggs(sid)]);
}
