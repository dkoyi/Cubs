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
  sharedActivities,
  suggestionKind,
  connectionEvidence,
} from "./discovery.js";
import type { StudentContext } from "./discovery.js";
import { JUDGE_THRESHOLD } from "./judge.js";
import type { Judge } from "./judge.js";
import { describeSpan, firstMeetingTime } from "./match.js";
import type { TimeWindow } from "./match.js";
import { CONTEXT_LIMITS, isFresh, isTimeZone, parseFree, parsePolicy, parseSignal, signalId, signalPermissionError, standingConsent, zoneOffsetMinutes } from "./signals.js";
import type { Activity, AutomaticIntroConsent, IntroProfile, Signal } from "./signals.js";
import type { Store } from "./store.js";
import { isRecord } from "./validate.js";
import type { Result } from "./validate.js";
import { connectionSignature, forgetConnections, forgetContinuity, mayReconnect, relationshipFor, rememberConnection, retainProfile, retainedContext } from "./continuity.js";

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
  version: (sid: string) => `context-version:${sid}`,
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
  return parseJson<StudentContext>(await store.get(k.ctx(sid))) ?? await retainedContext(store, sid);
}

export interface ContextOutcome {
  accepted: number;
  rejected: Array<{ index: number; reason: string }>;
  signals_total: number;
  context_version?: string;
}

/** Validates, normalizes and merges a PUT /api/context body into the student's context record. */
export async function putContext(store: Store, sid: string, body: unknown, now: Date): Promise<Result<ContextOutcome>> {
  const fail = (error: string): Result<ContextOutcome> => ({ ok: false, error });
  if (!isRecord(body)) return fail("Request body must be a JSON object.");
  const versioned = Object.hasOwn(body, "context_version");
  if (versioned && body.context_version !== null && typeof body.context_version !== "string") {
    return fail("context_version must be a string or null.");
  }
  if (versioned && body.context_version !== await store.get(k.version(sid))) {
    return fail("CONTEXT CONFLICT. Your other device changed this profile. Refresh before syncing again.");
  }
  const existing = await getContext(store, sid);

  const policy = parsePolicy(body.policy, existing?.policy ?? null);
  if (!policy.ok) return fail(policy.error);
  if (policy.value.automatic_intro_consent && Date.parse(policy.value.automatic_intro_consent.approved_at) > now.getTime() + 300_000) return fail("Automatic introduction approval cannot be in the future.");

  const rawSignals = body.signals ?? [];
  if (!Array.isArray(rawSignals)) return fail("signals must be a list.");
  const incoming: unknown[] = rawSignals;
  if (body.replace_signals !== undefined && typeof body.replace_signals !== "boolean") {
    return fail("replace_signals must be true or false.");
  }
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
  if (p.participating && body.replace_signals !== true) {
    for (const s of existing?.signals ?? []) {
      if (!isFresh(s, now)) continue;
      if (signalPermissionError(s.type, s.entity.kind, s.source, p) !== null) continue;
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
  await retainProfile(store, ctx);
  if (!p.remember_connections || !p.alumni_network) await forgetConnections(store, sid);
  if (p.participating) await store.sadd(k.participants, sid);
  else await store.srem(k.participants, sid);

  const old = existing?.policy;
  const permissionChanged = old !== undefined && (
    old.discoverable !== p.discoverable || old.school !== p.school ||
    old.contact !== p.contact || old.intro !== p.intro || JSON.stringify(old.automatic_intro_consent) !== JSON.stringify(p.automatic_intro_consent) ||
    old.max_suggestions_per_week !== p.max_suggestions_per_week ||
    old.life_stage !== p.life_stage || old.alumni_network !== p.alumni_network ||
    Boolean(old.share_intro_profile) !== p.share_intro_profile || JSON.stringify(old.intro_profile) !== JSON.stringify(p.intro_profile) ||
    JSON.stringify(old.affiliations ?? []) !== JSON.stringify(p.affiliations) ||
    (old.share_events && !p.share_events) || (old.share_applications && !p.share_applications)
  );
  // Cached asks may expose context that is no longer permitted. Close them before discovery
  // runs again; a previous yes must not survive a narrower sharing policy.
  const signalsRemoved = (existing?.signals ?? []).some((s) => {
    const next = byId.get(signalId(s));
    return next === undefined || (s.topics ?? []).some((topic) => !(next.topics ?? []).includes(topic));
  });
  if (!p.participating || permissionChanged || signalsRemoved) {
    for (const s of await listSuggestions(store, sid, now)) {
      if (isOpen(s)) await putSuggestion(store, { ...s, status: "passed" });
    }
  }
  const version = randomUUID();
  await store.set(k.version(sid), version);
  return { ok: true, value: { accepted, rejected, signals_total: ctx.signals.length,
    ...(versioned ? { context_version: version } : {}) } };
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
  ask_delivered_at?: string | null;
  /** A snapshot of explicit standing permission; never fabricate an answer of yes. */
  standing_consent?: AutomaticIntroConsent | null;
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
  connection_signature?: string;
  reconnecting?: boolean;
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
    if (suggestionKind(me, other, now) === null) continue;
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
    const kind = suggestionKind(me, other, now);
    if (kind === null) continue;
    const evidence = connectionEvidence(me, other, now);
    const signature = connectionSignature(sid, other.student_id, evidence, kind);
    const previous = await relationshipFor(store, sid, other.student_id);
    if (!mayReconnect(previous, signature)) continue;
    const shared = sharedSignals(me, other, now);
    let textA = rulesText(me, other, now);
    let textB = rulesText(other, me, now);
    let why = rulesWhy(shared, prefilter);
    let score = prefilter;
    let judgeName: Suggestion["judge"] = "rules";
    let textsFrom: Suggestion["texts_from"] = "rules";

    const [mutualA, mutualB] = mutualSignals(me, other, now);
    const verdict = judge === null ? null : await judge.judge({ shared: shared.slice(0, 48), a: mutualA.slice(0, 48), b: mutualB.slice(0, 48), prefilter, evidence, reconnecting: previous !== null });
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

    if (previous !== null) {
      // Keep the reconnection explanation grounded, regardless of model phrasing.
      textA = rulesText(me, other, now).replace(/^Someone/, "Someone you've connected with before");
      textB = rulesText(other, me, now).replace(/^Someone/, "Someone you've connected with before");
      textsFrom = "rules";
    }
    const id = randomUUID();
    // Claiming the pair key first keeps two concurrent syncs from creating the same pair twice.
    if (!(await store.setIfAbsent(k.pair(sid, other.student_id), id, COOLDOWN_SECONDS))) continue;
    const suggestion: Suggestion = {
      id,
      a: sid,
      b: other.student_id,
      kind,
      connection_signature: signature,
      reconnecting: previous !== null,
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
    const consentA = standingConsent(me.policy, kind, now), consentB = standingConsent(other.policy, kind, now);
    if (consentA) suggestion.side_a.standing_consent = consentA;
    if (consentB) suggestion.side_b.standing_consent = consentB;
    await putSuggestion(store, suggestion);
    await store.sadd(k.suggs(sid), id, SUGGESTION_TTL_SECONDS);
    await store.sadd(k.suggs(other.student_id), id, SUGGESTION_TTL_SECONDS);
    return await finishWithConsent(store, suggestion, now) ?? suggestion;
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
  profile?: IntroProfile;
  other_accepted?: boolean;
  you_accepted?: boolean;
  other_consent?: "standing" | "explicit";
}

export interface AgreedView {
  id: string;
  first_name: string;
  contact: string | null;
  when: TimeWindow | null;
  text: string;
  profile?: IntroProfile;
  consent?: { you: "standing" | "explicit"; other: "standing" | "explicit" };
  reason?: string;
}

const sideOf = (s: Suggestion, sid: string): "a" | "b" => (s.a === sid ? "a" : "b");

const pad = (n: number): string => String(n).padStart(2, "0");

async function stillPermitted(store: Store, s: Suggestion, now: Date): Promise<boolean> {
  const a = await getContext(store, s.a);
  const b = await getContext(store, s.b);
  return a !== null && b !== null && a.policy.participating && b.policy.participating &&
    discoverableTo(a, b, now) && sharedActivities(a, b, now).includes(s.kind) && prefilterScore(a, b, now) >= PREFILTER_MIN;
}

/** Keep stored/model-written reasons anonymous; compose identity only at read time. */
async function askView(store: Store, s: Suggestion, sid: string, now: Date): Promise<AskView> {
  const mine = sideOf(s, sid);
  const side = mine === "a" ? s.side_a : s.side_b;
  const otherSide = mine === "a" ? s.side_b : s.side_a;
  const other = await getContext(store, mine === "a" ? s.b : s.a);
  const otherStanding = other !== null && activeStanding(otherSide, other, s.kind, now) !== null;
  const view: AskView = { id: s.id, text: mine === "a" ? s.text_a : s.text_b, kind: s.kind, shared: s.shared, expires_at: s.expires_at };
  const profile = other?.policy.share_intro_profile ? other.policy.intro_profile : undefined;
  if (profile === undefined) return view;
  const reason = view.text.replace(/\s*Want me to see if you'd both like to connect\?$/i, "")
    .replace(/\s*Want (?:an intro|to connect)\?$/i, "")
    .replace(/^Someone you've connected with before/, "Someone");
  // Inserting the approved display name after the model guard avoids model-invented identities.
  const named = /\bsomeone\b/i.test(reason) ? reason.replace(/\bsomeone\b/i, () => profile.name) : `${profile.name}: ${reason}`;
  const question = (s.reconnecting ? "You've connected before. " : "") + (side.answer === "yes" ? "You've said yes. I'll let you know when they answer." :
    otherStanding ? "They've opted into automatic introductions. Want the intro?" : otherSide.answer === "yes" ? "They've already said yes. Want the intro?" : "Want an intro?");
  const budget = 399 - question.length;
  const body = named.length <= budget ? named : `${named.slice(0, budget - 3).trimEnd()}...`;
  return { ...view, text: `${body} ${question}`, profile, other_accepted: otherSide.answer === "yes" || otherStanding, you_accepted: side.answer === "yes",
    ...(otherStanding ? { other_consent: "standing" as const } : {}) };
}

/** On-demand details for a follow-up such as "Who is it?" or "Link?", without consuming delivery. */
export async function previewSuggestion(store: Store, sid: string, id: string, now: Date): Promise<AskView | null> {
  const found = await getSuggestion(store, id);
  if (found === null || (found.a !== sid && found.b !== sid)) return null;
  const s = await settle(store, found, now);
  if (!isOpen(s) || !(await stillPermitted(store, s, now))) return null;
  return askView(store, s, sid, now);
}

/** "2026-10-25T19:00:00-07:00": the instant written at the given UTC offset. */
export function isoAtOffset(iso: string, offsetMinutes: number): string {
  const local = new Date(Date.parse(iso) + offsetMinutes * 60_000).toISOString().slice(0, 19);
  const abs = Math.abs(offsetMinutes);
  return `${local}${offsetMinutes < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The agreed outcome as one student sees it, with times at that student's UTC offset. */
async function agreedView(store: Store, s: Suggestion, sid: string): Promise<AgreedView> {
  const other = (sideOf(s, sid) === "a" ? s.release_b : s.release_a) ?? { first_name: "", contact: null };
  const mine = sideOf(s, sid);
  const ownStanding = Boolean((mine === "a" ? s.side_a : s.side_b).standing_consent);
  const otherStanding = Boolean((mine === "a" ? s.side_b : s.side_a).standing_consent);
  const head = ownStanding || otherStanding ? `You're connected with ${other.first_name}. ${otherStanding ? "They approved automatic introductions" : "They accepted this introduction"}.` : `You're on. ${other.first_name} said yes too.`;
  const view: AgreedView = { id: s.id, first_name: other.first_name, contact: other.contact, when: null, text: "" };
  if (ownStanding || otherStanding) {
    view.consent = { you: ownStanding ? "standing" : "explicit", other: otherStanding ? "standing" : "explicit" };
    const ctx = await getContext(store, mine === "a" ? s.b : s.a);
    if (ctx?.policy.share_intro_profile && ctx.policy.intro_profile) view.profile = ctx.policy.intro_profile;
    const rawReason = (mine === "a" ? s.text_a : s.text_b)
      .replace(/\s*Want me to see if you'd both like to connect\?$/i, "")
      .replace(/\s*[^.?!]*\?$/, "");
    view.reason = rawReason.replace(/\bsomeone\b/i, () => view.profile?.name ?? other.first_name).slice(0, 350);
  }
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
export async function pendingFor(store: Store, sid: string, now: Date, acknowledgedDelivery = false): Promise<SuggestionsOutcome> {
  const list = await listSuggestions(store, sid, now);
  for (const [index, suggestion] of list.entries()) {
    if (isOpen(suggestion)) list[index] = await finishWithConsent(store, suggestion, now) ?? suggestion;
  }

  const agreed: AgreedView[] = [];
  for (const s of list) {
    const side = sideOf(s, sid) === "a" ? s.side_a : s.side_b;
    if (s.status !== "agreed" || side.agreed_seen) continue;
    if (!(await standingAgreementReadable(store, s, now))) continue;
    agreed.push(await agreedView(store, s, sid));
    if (!acknowledgedDelivery) {
      const seen: SideState = { ...side, agreed_seen: true };
      await putSuggestion(store, sideOf(s, sid) === "a" ? { ...s, side_a: seen } : { ...s, side_b: seen });
    }
  }

  let ask: AskView | null = null;
  for (const s of list) {
    if (!isOpen(s)) continue;
    if (!(await stillPermitted(store, s, now))) {
      await putSuggestion(store, { ...s, status: "passed" });
      continue;
    }
    const mine = sideOf(s, sid);
    const side = mine === "a" ? s.side_a : s.side_b;
    if (side.answer !== null) continue;
    const ctx = await getContext(store, sid);
    if (ctx !== null && activeStanding(side, ctx, s.kind, now) !== null) continue;
    if (acknowledgedDelivery && side.ask_delivered_at) continue;
    if (side.later_until !== null && Date.parse(side.later_until) > now.getTime()) continue;
    const asked: SideState = {
      ...side,
      asked_at: side.later_until !== null || side.asked_at === null ? now.toISOString() : side.asked_at,
      later_until: null,
    };
    const updated: Suggestion = mine === "a" ? { ...s, side_a: asked } : { ...s, side_b: asked };
    updated.status = askedStatus(updated);
    await putSuggestion(store, updated);
    ask = await askView(store, s, sid, now);
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
  if (s.status === "agreed") return await standingAgreementReadable(store, s, now) ?
    { kind: "agreed", view: await agreedView(store, s, sid) } : { kind: "passed" };
  if (s.status === "passed") {
    // The student who said no already answered; the other side learns it passed.
    const own = sideOf(s, sid) === "a" ? s.side_a : s.side_b;
    return own.answer === "no" ? { kind: "already_answered" } : { kind: "passed" };
  }
  if (s.status === "expired") return { kind: "expired" };
  if (!(await stillPermitted(store, s, now))) {
    await putSuggestion(store, { ...s, status: "passed" });
    return { kind: "passed" };
  }

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
      ...withSide({ ...side, later_until: until.toISOString(), later_used: true, ask_delivered_at: null, standing_consent: null }),
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

  const answered = withSide({ ...side, answer: "yes", standing_consent: null, later_until: null, asked_at: side.asked_at ?? now.toISOString() });
  const finished = await finishWithConsent(store, answered, now);
  if (finished === null) {
    answered.status = askedStatus(answered);
    await putSuggestion(store, answered);
    return { kind: "waiting" };
  }

  return { kind: "agreed", view: await agreedView(store, finished, sid) };
}

function activeStanding(side: SideState, ctx: StudentContext, kind: Activity, now: Date): AutomaticIntroConsent | null {
  if (side.answer !== null || !side.standing_consent || side.later_until !== null) return null;
  const current = standingConsent(ctx.policy, kind, now);
  return current?.approved_at === side.standing_consent.approved_at ? current : null;
}

/** Do not disclose an unfetched standing-permission contact after that permission was revoked. */
async function standingAgreementReadable(store: Store, s: Suggestion, now: Date): Promise<boolean> {
  if (!s.side_a.standing_consent && !s.side_b.standing_consent) return true;
  const a = await getContext(store, s.a), b = await getContext(store, s.b);
  if (!a || !b || !a.policy.participating || !b.policy.participating || !discoverableTo(a, b, now)) return false;
  return (!s.side_a.standing_consent || activeStanding(s.side_a, a, s.kind, now) !== null) &&
    (!s.side_b.standing_consent || activeStanding(s.side_b, b, s.kind, now) !== null);
}

/** Shared completion path: two real explicit permissions, from answers or bounded setup grants. */
async function finishWithConsent(store: Store, s: Suggestion, now: Date): Promise<Suggestion | null> {
  if (!isOpen(s) || !(await stillPermitted(store, s, now))) return null;
  const ctxA = await getContext(store, s.a);
  const ctxB = await getContext(store, s.b);
  if (!ctxA || !ctxB) return null;
  if (!(s.side_a.answer === "yes" || activeStanding(s.side_a, ctxA, s.kind, now)) ||
      !(s.side_b.answer === "yes" || activeStanding(s.side_b, ctxB, s.kind, now))) return null;
  const agreed: Suggestion = {
    ...s,
    status: "agreed",
    agreed_at: now.toISOString(),
    when: firstMeetingTime(ctxA?.free ?? [], ctxB?.free ?? [], now, MEETING_MINUTES),
    release_a: await release(store, s.a),
    release_b: await release(store, s.b),
  };
  await putSuggestion(store, agreed);
  if (ctxA !== null && ctxB !== null) {
    await rememberConnection(store, ctxA, ctxB, s.id, s.connection_signature ?? "legacy", now);
  }
  return agreed;
}

/** Explicit acknowledgment after the assistant successfully relays a message. */
export async function acknowledgeDelivery(store: Store, sid: string, id: string, kind: "ask" | "agreed", now: Date): Promise<boolean> {
  const s = await getSuggestion(store, id);
  if (s === null || (s.a !== sid && s.b !== sid)) return false;
  if (kind === "agreed" ? s.status !== "agreed" : !isOpen(await settle(store, s, now))) return false;
  const mine = sideOf(s, sid);
  const side = mine === "a" ? s.side_a : s.side_b;
  const next = kind === "agreed" ? { ...side, agreed_seen: true } : { ...side, ask_delivered_at: now.toISOString() };
  await putSuggestion(store, mine === "a" ? { ...s, side_a: next } : { ...s, side_b: next });
  return true;
}

// ---------- leaving ----------

/** Deletes the student's context, every suggestion they are part of (with both sides' answers) and their pair cooldowns. */
export async function deleteLoopData(store: Store, sid: string): Promise<void> {
  await forgetContinuity(store, sid);
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
  await store.del([k.ctx(sid), k.suggs(sid), k.version(sid)]);
}
