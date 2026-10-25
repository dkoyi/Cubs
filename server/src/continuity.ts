// Long-lived, explicitly opted-in continuity. No transcripts, old signal snapshots,
// peer contacts or inferred availability are retained here.
import { createHash } from "node:crypto";
import type { StudentContext, ConnectionEvidence } from "./discovery.js";
import type { Store } from "./store.js";

export type RetainedProfile = Pick<StudentContext, "policy" | "tz" | "updated_at">;
const profileKey = (sid: string): string => `profile:${sid}`;
const pairKey = (a: string, b: string): string => `relationship:${[a, b].sort().join(":")}`;
const indexKey = (sid: string): string => `relationships:${sid}`;

export async function retainedContext(store: Store, sid: string): Promise<StudentContext | null> {
  const raw = await store.get(profileKey(sid));
  if (raw === null) return null;
  const profile = JSON.parse(raw) as RetainedProfile;
  return { ...profile, student_id: sid, signals: [], free: [] };
}

export async function retainProfile(store: Store, ctx: StudentContext): Promise<void> {
  if (!ctx.policy.alumni_network) {
    await store.del([profileKey(ctx.student_id)]);
    return;
  }
  const profile: RetainedProfile = { policy: ctx.policy, updated_at: ctx.updated_at };
  if (ctx.tz !== undefined) profile.tz = ctx.tz;
  await store.set(profileKey(ctx.student_id), JSON.stringify(profile));
}

interface Feedback { met: boolean | null; useful: boolean | null }
export interface Relationship {
  id: string;
  a: string;
  b: string;
  first_connected_at: string;
  last_connected_at: string;
  introductions: number;
  last_signature: string;
  feedback_a: Feedback;
  feedback_b: Feedback;
}

export function connectionSignature(a: string, b: string, evidence: ConnectionEvidence[], kind: string): string {
  const reasons = evidence.map((e) => [e.label.toLowerCase(), ...(a < b ? [e.a_type, e.b_type] : [e.b_type, e.a_type])].join(":"));
  // Refresh timestamps and deadline movement are not new reasons to contact the same person.
  return createHash("sha256").update(JSON.stringify([kind, [...new Set(reasons)].sort()])).digest("hex");
}

export async function relationshipFor(store: Store, a: string, b: string): Promise<Relationship | null> {
  const raw = await store.get(pairKey(a, b));
  return raw === null ? null : JSON.parse(raw) as Relationship;
}

export function mayReconnect(relationship: Relationship | null, signature: string): boolean {
  return relationship === null || (relationship.last_signature !== signature &&
    relationship.feedback_a.useful !== false && relationship.feedback_b.useful !== false);
}

export async function rememberConnection(store: Store, a: StudentContext, b: StudentContext, id: string, signature: string, now: Date): Promise<void> {
  if (![a, b].every((ctx) => ctx.policy.alumni_network && ctx.policy.remember_connections)) return;
  const old = await relationshipFor(store, a.student_id, b.student_id);
  // Bound each person's history without displacing previously retained relationships.
  if (old === null && ((await store.smembers(indexKey(a.student_id))).length >= 200 ||
      (await store.smembers(indexKey(b.student_id))).length >= 200)) return;
  const record: Relationship = old === null ? {
    id, a: a.student_id, b: b.student_id, first_connected_at: now.toISOString(), last_connected_at: now.toISOString(),
    introductions: 1, last_signature: signature, feedback_a: { met: null, useful: null }, feedback_b: { met: null, useful: null },
  } : { ...old, last_connected_at: now.toISOString(), introductions: old.introductions + 1, last_signature: signature };
  await store.set(pairKey(a.student_id, b.student_id), JSON.stringify(record));
  await store.sadd(indexKey(a.student_id), b.student_id);
  await store.sadd(indexKey(b.student_id), a.student_id);
}

export async function connectionHistory(store: Store, sid: string): Promise<Array<{
  id: string; first_connected_at: string; last_connected_at: string; introductions: number; feedback: Feedback;
}>> {
  const result = [];
  for (const other of await store.smembers(indexKey(sid))) {
    const r = await relationshipFor(store, sid, other);
    if (r !== null) result.push({ id: r.id, first_connected_at: r.first_connected_at, last_connected_at: r.last_connected_at,
      introductions: r.introductions, feedback: r.a === sid ? r.feedback_a : r.feedback_b });
  }
  return result.sort((a, b) => b.last_connected_at.localeCompare(a.last_connected_at));
}

export const OUTCOMES = ["met", "did_not_meet", "useful", "not_useful", "reset"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export async function recordOutcome(store: Store, sid: string, id: string, outcome: Outcome): Promise<boolean> {
  for (const other of await store.smembers(indexKey(sid))) {
    const r = await relationshipFor(store, sid, other);
    if (r === null || r.id !== id) continue;
    const field = r.a === sid ? "feedback_a" : "feedback_b";
    const feedback = { ...r[field] };
    if (outcome === "reset") { feedback.met = null; feedback.useful = null; }
    else if (outcome === "met" || outcome === "did_not_meet") feedback.met = outcome === "met";
    else feedback.useful = outcome === "useful";
    await store.set(pairKey(sid, other), JSON.stringify({ ...r, [field]: feedback }));
    return true;
  }
  return false;
}

export async function forgetConnections(store: Store, sid: string): Promise<void> {
  for (const other of await store.smembers(indexKey(sid))) {
    await store.del([pairKey(sid, other)]);
    await store.srem(indexKey(other), sid);
  }
  await store.del([indexKey(sid)]);
}

export async function forgetContinuity(store: Store, sid: string): Promise<void> {
  await forgetConnections(store, sid);
  await store.del([profileKey(sid)]);
}
