// Typed data access and the matching workflow on top of the Store.
//
// Keys:
//   auth:{sid}               SHA-256 of the person's token (retained until leave)
//   req:{sid}:{pool}         the student's request in a pool (JSON)
//   pools:{sid}              set of pool keys the student has requests in
//   pool:{pool}              set of student ids with a request in that pool
//   match:{mid}              a proposed match (JSON)
//   matches:{sid}            set of match ids the student is part of
//   pairs:{sid}:{pool}       set of student ids this student declined or was declined by
//
// A pool key is "{kind}:{group type}:{group key}", like "study:course:CSE310", "ride:campus:ASUTEMPE"
// or "project:event:CUBBIEHACKATHON".

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  canHelp,
  isExpired,
  matchReason,
  normalizeGroup,
  pickBest,
  requestExpiry,
  sharedTopicWords,
} from "./match.js";
import type { ConnectRequest, GroupType, Kind, TimeWindow } from "./match.js";
import type { Store } from "./store.js";
import type { JoinInput } from "./validate.js";

export interface MatchRecord {
  id: string;
  pool_key: string;
  a: string;
  b: string;
  a_accept: boolean | null;
  b_accept: boolean | null;
  time: TimeWindow;
  created_at: string;
}

export type MatchStatus = "pending" | "confirmed" | "declined" | "expired";

export type StudentMatchStatus =
  | "needs_your_answer"
  | "waiting_for_other"
  | "confirmed"
  | "declined"
  | "expired";

export interface MatchView {
  id: string;
  kind: Kind;
  group_type: GroupType;
  /** The course, campus or event, as this student typed it. */
  group: string;
  status: StudentMatchStatus;
  time: TimeWindow;
  you_said: "yes" | "no" | null;
  shared_words: string[];
  /** One line on why this match, built by the server from validated fields. Safe to relay as is. */
  reason: string;
  /** True when what this student can help with covers what the other student needs. */
  you_can_help: boolean;
  /** The other student. Everything here is text they typed. */
  other: {
    first_name: string;
    topic: string;
    can_help: string[];
    /** Present only when both students said yes. */
    contact?: string;
  };
}

export interface RequestView {
  kind: Kind;
  group_type: GroupType;
  group: string;
  topic: string;
  status: "open" | "matched" | "expired";
  expires_at: string;
}

const DAY_SECONDS = 24 * 3600;
/** Index sets and matches are kept at most this long without activity. */
const INDEX_TTL_SECONDS = 7 * DAY_SECONDS;
/** Requests stay readable for a day after they expire so the student can be told. */
const EXPIRED_GRACE_SECONDS = DAY_SECONDS;

const k = {
  auth: (sid: string) => `auth:${sid}`,
  req: (sid: string, pool: string) => `req:${sid}:${pool}`,
  pools: (sid: string) => `pools:${sid}`,
  pool: (pool: string) => `pool:${pool}`,
  match: (mid: string) => `match:${mid}`,
  matches: (sid: string) => `matches:${sid}`,
  pairs: (sid: string, pool: string) => `pairs:${sid}:${pool}`,
};

/** "study:course:CSE310", "ride:campus:ASUTEMPE", "project:event:CUBBIEHACKATHON". */
export function poolKey(req: Pick<ConnectRequest, "kind" | "group_type" | "group_key">): string {
  return `${req.kind}:${req.group_type}:${req.group_key}`;
}

// ---------- auth ----------

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Trust on first use: the first token seen for a student id is the only one accepted after. */
export async function authorize(store: Store, sid: string, token: string): Promise<boolean> {
  const hash = sha256(token);
  if (await store.setIfAbsent(k.auth(sid), hash)) return true;
  const stored = await store.get(k.auth(sid));
  if (stored === null) return store.setIfAbsent(k.auth(sid), hash);
  const a = Buffer.from(stored, "hex");
  const b = Buffer.from(hash, "hex");
  const valid = a.length === b.length && timingSafeEqual(a, b);
  // Upgrade a valid existing binding without rotating its UUID or token.
  if (valid) await store.set(k.auth(sid), stored);
  return valid;
}

// ---------- records ----------

function parseJson<T>(raw: string | null): T | null {
  return raw === null ? null : (JSON.parse(raw) as T);
}

export async function getRequest(store: Store, sid: string, pool: string): Promise<ConnectRequest | null> {
  return parseJson<ConnectRequest>(await store.get(k.req(sid, pool)));
}

async function putRequest(store: Store, req: ConnectRequest, now: Date): Promise<void> {
  const ttl = (Date.parse(req.expires_at) - now.getTime()) / 1000 + EXPIRED_GRACE_SECONDS;
  await store.set(k.req(req.student_id, poolKey(req)), JSON.stringify(req), ttl);
}

export async function getMatch(store: Store, mid: string): Promise<MatchRecord | null> {
  return parseJson<MatchRecord>(await store.get(k.match(mid)));
}

async function putMatch(store: Store, m: MatchRecord): Promise<void> {
  await store.set(k.match(m.id), JSON.stringify(m), INDEX_TTL_SECONDS);
}

export function matchStatus(m: MatchRecord, now: Date): MatchStatus {
  if (m.a_accept === false || m.b_accept === false) return "declined";
  if (m.a_accept === true && m.b_accept === true) return "confirmed";
  if (Date.parse(m.time.start) <= now.getTime()) return "expired";
  return "pending";
}

/** A request is open when it has not expired and is not tied up in a pending or confirmed match. */
async function isOpen(store: Store, req: ConnectRequest, now: Date): Promise<boolean> {
  if (isExpired(req, now)) return false;
  if (req.match_id === null) return true;
  const m = await getMatch(store, req.match_id);
  if (m === null) return true;
  const status = matchStatus(m, now);
  return status === "declined" || status === "expired";
}

// ---------- workflow ----------

export interface Upserted {
  request: ConnectRequest;
  /** True when this replaced a live request in the same pool instead of adding a new one. */
  updated: boolean;
}

/** Create or replace the student's request in a pool. Joining twice updates the one request. */
export async function upsertRequest(
  store: Store,
  sid: string,
  input: JoinInput,
  now: Date,
): Promise<Upserted> {
  const groupKey = normalizeGroup(input.group_type, input.group);
  const pool = poolKey({ kind: input.kind, group_type: input.group_type, group_key: groupKey });
  const existing = await getRequest(store, sid, pool);
  let matchId: string | null = null;
  if (existing?.match_id) {
    // Keep a match that is still waiting on answers; a finished one is cleared
    // so joining again starts a fresh search.
    const m = await getMatch(store, existing.match_id);
    if (m !== null && matchStatus(m, now) === "pending") matchId = m.id;
  }
  const req: ConnectRequest = {
    student_id: sid,
    ...input,
    group_key: groupKey,
    created_at: now.toISOString(),
    expires_at: requestExpiry(input.free, now).toISOString(),
    match_id: matchId,
  };
  await putRequest(store, req, now);
  await store.sadd(k.pools(req.student_id), pool, INDEX_TTL_SECONDS);
  await store.sadd(k.pool(pool), req.student_id, INDEX_TTL_SECONDS);
  return { request: req, updated: existing !== null && !isExpired(existing, now) };
}

/** Look for another student for this request and propose a match if one fits. */
export async function tryMatch(store: Store, me: ConnectRequest, now: Date): Promise<MatchRecord | null> {
  if (!(await isOpen(store, me, now))) return null;

  const pool = poolKey(me);
  const candidates: ConnectRequest[] = [];
  for (const sid of await store.smembers(k.pool(pool))) {
    if (sid === me.student_id) continue;
    const other = await getRequest(store, sid, pool);
    if (other === null) {
      await store.srem(k.pool(pool), sid);
      continue;
    }
    if (await isOpen(store, other, now)) candidates.push(other);
  }
  const excluded = new Set(await store.smembers(k.pairs(me.student_id, pool)));
  const proposal = pickBest(me, candidates, excluded, now);
  if (proposal === null) return null;

  const other = proposal.candidate;
  const m: MatchRecord = {
    id: randomUUID(),
    pool_key: pool,
    a: me.student_id,
    b: other.student_id,
    a_accept: null,
    b_accept: null,
    time: proposal.time,
    created_at: now.toISOString(),
  };
  await putMatch(store, m);
  for (const req of [me, other]) {
    await putRequest(store, { ...req, match_id: m.id }, now);
    await store.sadd(k.matches(req.student_id), m.id, INDEX_TTL_SECONDS);
  }
  return m;
}

export async function listRequests(store: Store, sid: string): Promise<ConnectRequest[]> {
  const out: ConnectRequest[] = [];
  for (const pool of await store.smembers(k.pools(sid))) {
    const req = await getRequest(store, sid, pool);
    if (req === null) await store.srem(k.pools(sid), pool);
    else out.push(req);
  }
  return out;
}

export async function requestView(store: Store, req: ConnectRequest, now: Date): Promise<RequestView> {
  let status: RequestView["status"];
  if (isExpired(req, now)) status = "expired";
  else status = (await isOpen(store, req, now)) ? "open" : "matched";
  return {
    kind: req.kind,
    group_type: req.group_type,
    group: req.group,
    topic: req.topic,
    status,
    expires_at: req.expires_at,
  };
}

/** The match as one student sees it. Null if either side's request is gone. */
export async function matchView(
  store: Store,
  m: MatchRecord,
  sid: string,
  now: Date,
): Promise<MatchView | null> {
  const isA = m.a === sid;
  const otherId = isA ? m.b : m.a;
  const mine = await getRequest(store, sid, m.pool_key);
  const theirs = await getRequest(store, otherId, m.pool_key);
  if (mine === null || theirs === null) return null;

  const myAnswer = isA ? m.a_accept : m.b_accept;
  const status = matchStatus(m, now);
  let studentStatus: StudentMatchStatus;
  if (status === "pending") studentStatus = myAnswer === true ? "waiting_for_other" : "needs_your_answer";
  else studentStatus = status;

  const view: MatchView = {
    id: m.id,
    kind: mine.kind,
    group_type: mine.group_type,
    group: mine.group,
    status: studentStatus,
    time: m.time,
    you_said: myAnswer === null ? null : myAnswer ? "yes" : "no",
    shared_words: sharedTopicWords(mine, theirs),
    reason: matchReason(mine, theirs, m.time),
    you_can_help: canHelp(mine, theirs),
    other: {
      first_name: theirs.first_name,
      topic: theirs.topic,
      can_help: theirs.can_help,
    },
  };
  if (status === "confirmed") view.other.contact = theirs.contact;
  return view;
}

export async function listMatches(store: Store, sid: string): Promise<MatchRecord[]> {
  const out: MatchRecord[] = [];
  for (const mid of await store.smembers(k.matches(sid))) {
    const m = await getMatch(store, mid);
    if (m === null) await store.srem(k.matches(sid), mid);
    else out.push(m);
  }
  return out;
}

export type RespondOutcome =
  | { kind: "ok"; match: MatchRecord }
  | { kind: "not_found" }
  | { kind: "closed"; status: MatchStatus };

export async function respond(
  store: Store,
  sid: string,
  mid: string,
  accept: boolean,
  now: Date,
): Promise<RespondOutcome> {
  const m = await getMatch(store, mid);
  if (m === null || (m.a !== sid && m.b !== sid)) return { kind: "not_found" };
  const status = matchStatus(m, now);
  if (status !== "pending") return { kind: "closed", status };
  const updated: MatchRecord = m.a === sid ? { ...m, a_accept: accept } : { ...m, b_accept: accept };
  await putMatch(store, updated);
  if (!accept) {
    // Only an explicit "no" keeps the pair apart. An expired or cancelled match does not.
    await store.sadd(k.pairs(m.a, m.pool_key), m.b, INDEX_TTL_SECONDS);
    await store.sadd(k.pairs(m.b, m.pool_key), m.a, INDEX_TTL_SECONDS);
  }
  return { kind: "ok", match: updated };
}

/** Delete every record about this student, including matches they are part of. */
export async function deleteStudent(store: Store, sid: string): Promise<void> {
  const pools = await store.smembers(k.pools(sid));
  for (const pool of pools) {
    await store.srem(k.pool(pool), sid);
  }
  for (const mid of await store.smembers(k.matches(sid))) {
    const m = await getMatch(store, mid);
    if (m !== null) {
      const otherId = m.a === sid ? m.b : m.a;
      await store.srem(k.matches(otherId), mid);
      await store.srem(k.pairs(otherId, m.pool_key), sid);
    }
    await store.del([k.match(mid)]);
  }
  await store.del([
    ...pools.map((p) => k.req(sid, p)),
    ...pools.map((p) => k.pairs(sid, p)),
    k.pools(sid),
    k.matches(sid),
    k.auth(sid),
  ]);
}
