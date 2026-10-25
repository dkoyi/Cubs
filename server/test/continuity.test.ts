// Synthetic, local lifecycle tests. Advancing this clock does not exercise Cubbie's scheduler.
import { randomBytes, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAnswer, handleConnections, handleDelivered, handleGetContext, handleLeave, handlePutContext, handleSuggestions } from "../src/handlers.js";
import type { Deps } from "../src/handlers.js";
import type { JudgeRequest } from "../src/judge.js";
import type { AskView } from "../src/loop.js";
import { InMemoryStore } from "../src/store.js";
import { DEFAULT_POLICY, parseSignal } from "../src/signals.js";
import { guardText } from "../src/discovery.js";
import { getContext } from "../src/loop.js";

const DAY = 86_400_000;
const student = () => ({ id: randomUUID(), token: randomBytes(32).toString("base64url") });
type Person = ReturnType<typeof student>;
let now: number;
let store: InMemoryStore;
let deps: Deps;

beforeEach(() => {
  now = Date.parse("2026-10-24T16:00:00Z");
  store = new InMemoryStore(() => now);
  deps = { store, now: () => new Date(now) };
});

function req(person: Person, path: string, method = "GET", body?: unknown): Request {
  return new Request(`https://supercub.test/api/${path}`, { method,
    headers: { "X-Student-Id": person.id, Authorization: `Bearer ${person.token}`, "X-Supercub-Delivery": "acknowledged" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const signal = (type: string, label: string, topics?: string[]) => ({ type,
  entity: { kind: type === "open_to" ? "activity" : "topic", label }, source: "student",
  confirmed_at: new Date(now).toISOString(), ...(topics ? { topics } : {}),
});
function context(name: string, signals: unknown[], policy: Record<string, unknown> = {}) {
  return { policy: { participating: true, first_name: name, contact: `${name.toLowerCase()}@example.edu`,
    school: "ASU", affiliations: ["ASU"], life_stage: "student", alumni_network: true,
    remember_connections: true, discoverable: "alumni", ...policy },
    replace_signals: true, signals: [...signals, signal("open_to", "advising")], free: [], tz: "America/Phoenix" };
}
async function put(person: Person, body: unknown): Promise<{ accepted: number; rejected: unknown[]; open_suggestion: boolean }> {
  const result = await handlePutContext(req(person, "context", "PUT", body), deps);
  expect(result.status).toBe(200);
  return await result.json() as { accepted: number; rejected: unknown[]; open_suggestion: boolean };
}
async function pending(person: Person): Promise<{ ask: AskView | null; agreed: Array<Record<string, unknown>> }> {
  return await (await handleSuggestions(req(person, "suggestions"), deps)).json() as { ask: AskView | null; agreed: Array<Record<string, unknown>> };
}
async function answer(person: Person, id: string, value: string): Promise<Record<string, unknown>> {
  return await (await handleAnswer(req(person, `suggestions/${id}/answer`, "POST", { answer: value }), deps)).json() as Record<string, unknown>;
}
async function connected() {
  const a = student(), b = student();
  await put(a, context("Alex", [signal("looking_for", "healthcare product advice")]));
  await put(b, context("Jordan", [signal("can_help_with", "clinical workflow advice", ["healthcare"])]));
  const id = (await pending(a)).ask?.id ?? "";
  expect(id).not.toBe("");
  expect(await answer(a, id, "yes")).toEqual({ status: "waiting" });
  expect((await answer(b, id, "yes")).status).toBe("agreed");
  return { a, b, id };
}

describe("student to alumni continuity", () => {
  it("rejects a stale device that would restore participation or withdrawn offers", async () => {
    const a = student();
    const first = await handlePutContext(req(a, "context", "PUT", { ...context("Alex", [signal("can_help_with", "React")]), context_version: null }), deps);
    const initial = await first.json() as { context_version: string };
    expect(initial.context_version).toBeTypeOf("string");
    const paused = await handlePutContext(req(a, "context", "PUT", {
      policy: { participating: false }, signals: [], free: [], context_version: initial.context_version,
    }), deps);
    expect(paused.status).toBe(200);
    const stale = await handlePutContext(req(a, "context", "PUT", {
      ...context("Alex", [signal("can_help_with", "React")]), context_version: initial.context_version,
    }), deps);
    expect(stale.status).toBe(409);
    expect(await getContext(store, a.id)).toMatchObject({ policy: { participating: false }, signals: [] });
    const current = await (await handleGetContext(req(a, "context"), deps)).json() as { context_version: string };
    expect(current.context_version).not.toBe(initial.context_version);
    expect((await handlePutContext(req(a, "context", "PUT", {
      ...context("Alex", [signal("looking_for", "healthcare")]), context_version: current.context_version,
    }), deps)).status).toBe(200);
  });

  it("retains affiliation and identity across two dormant years, then connects newly complementary lives", async () => {
    const a = student(), b = student();
    await put(a, context("Alex", [signal("interested_in", "robotics")]));
    expect((await put(b, context("Jordan", [signal("interested_in", "healthcare")]))).open_suggestion).toBe(false);
    now += 2 * 365 * DAY;
    const restored = await (await handleGetContext(req(a, "context"), deps)).json() as Record<string, unknown>;
    expect(restored).toMatchObject({ policy: { affiliations: ["ASU"], alumni_network: true }, signals: [], free: [] });
    expect((await handleGetContext(req({ ...a, token: randomBytes(32).toString("base64url") }, "context"), deps)).status).toBe(401);

    const graduate = { life_stage: "alumni", school: "" };
    await put(a, context("Alex", [signal("looking_for", "healthcare product advice")], graduate));
    expect((await put(b, context("Jordan", [signal("can_help_with", "clinical workflow advice", ["healthcare"])], graduate))).open_suggestion).toBe(true);
    const ask = (await pending(a)).ask;
    expect(ask?.text).toContain("university network");
    expect(ask?.text).toContain("healthcare");
    expect(JSON.stringify(ask)).not.toMatch(/Jordan|example.edu|clinical workflow/);
    const id = ask?.id ?? "";
    expect(await answer(a, id, "yes")).toEqual({ status: "waiting" });
    expect((await pending(a)).agreed).toEqual([]);
    expect(await answer(b, id, "yes")).toMatchObject({ status: "agreed", contact: "alex@example.edu" });
    expect((await pending(a)).agreed[0]).toMatchObject({ contact: "jordan@example.edu" });
    expect(await store.get(`profile:${a.id}`)).not.toContain("healthcare product advice");
  });

  it("requires both people to approve alumni participation and a shared activity", async () => {
    const a = student(), b = student();
    await put(a, context("Alex", [signal("looking_for", "React")], { life_stage: "alumni" }));
    const noAlumni = context("Jordan", [signal("can_help_with", "React")], { alumni_network: false, discoverable: "school" });
    expect((await put(b, noAlumni)).open_suggestion).toBe(false);
    const differentActivity = context("Jordan", [signal("can_help_with", "React")]);
    differentActivity.signals = [signal("can_help_with", "React"), signal("open_to", "meals")];
    expect((await put(b, differentActivity)).open_suggestion).toBe(false);
    expect((await put(b, context("Jordan", [signal("can_help_with", "React")]))).open_suggestion).toBe(true);
  });

  it("does not broaden missing affiliation evidence or treat background as willingness", async () => {
    const a = student(), b = student();
    await put(a, context("Alex", [signal("looking_for", "healthcare")]));
    expect((await put(b, context("Jordan", [signal("can_help_with", "healthcare")], { school: "", affiliations: [] }))).open_suggestion).toBe(false);
    expect((await put(b, context("Jordan", [signal("experienced_in", "healthcare")]))).open_suggestion).toBe(false);
  });

  it("keeps dated willingness expired despite resync and requires a real new confirmation", async () => {
    const a = student(), b = student();
    const old = context("Jordan", [signal("can_help_with", "React")]);
    await put(b, old);
    now += 61 * DAY;
    await put(a, context("Alex", [signal("looking_for", "React")]));
    const expired = await put(b, old);
    expect(expired.accepted).toBe(0);
    expect(expired.rejected).toHaveLength(2);
    expect(expired.open_suggestion).toBe(false);
    expect((await put(b, context("Jordan", [signal("can_help_with", "React")]))).open_suggestion).toBe(true);
  });

  it("invalidates an open ask when its activity permission expires naturally", async () => {
    const a = student(), b = student();
    const ctx = context("Alex", [signal("looking_for", "React")]);
    ctx.signals[1] = { ...signal("open_to", "advising"), confirmed_at: new Date(now - 59.5 * DAY).toISOString() };
    await put(a, ctx);
    await put(b, context("Jordan", [signal("can_help_with", "React")]));
    const id = (await pending(a)).ask?.id ?? "";
    expect(id).not.toBe("");
    await answer(a, id, "yes");
    now += DAY;
    expect(await answer(b, id, "yes")).toEqual({ status: "passed" });
  });
});

describe("complementary discovery and messages", () => {
  it("aligns approved synonyms, preserving directional help evidence for the judge", async () => {
    const calls: JudgeRequest[] = [];
    deps.judge = { name: "mock", async judge(request) { calls.push(request); return null; } };
    const a = student(), b = student();
    await put(a, context("Alex", [signal("looking_for", "voice AI assistant")]));
    await put(b, context("Jordan", [signal("can_help_with", "speech recognition")]));
    expect(calls).toHaveLength(1);
    const call = calls[0];
    // The model sees each person's own approved labels; the aligned subject travels as evidence.
    expect(call?.a).toContainEqual({ type: "can_help_with", kind: "topic", label: "speech recognition" });
    expect(call?.b).toContainEqual({ type: "looking_for", kind: "topic", label: "voice AI assistant" });
    expect(call?.evidence).toContainEqual({ label: "voice AI", a_type: "can_help_with", b_type: "looking_for", relation: "a_offers_help" });
    expect(JSON.stringify(call)).not.toMatch(/Alex|Jordan|example.edu/);
    expect((await pending(a)).ask?.text).toContain("offered to help with voice AI");
  });

  it("does not match mere word fragments or manufacture willingness from expertise", async () => {
    const a = student(), b = student();
    await put(a, context("Alex", [signal("looking_for", "React")]));
    expect((await put(b, context("Jordan", [signal("can_help_with", "reaction kinetics")]))).open_suggestion).toBe(false);
    expect((await put(b, context("Jordan", [signal("experienced_in", "React")]))).open_suggestion).toBe(false);
  });

  it("rejects unsupported enrollment claims in model messages", async () => {
    const a = student(), b = student();
    const ca = context("Alex", []), cb = context("Jordan", []);
    ca.signals.push({ type: "enrolled_in", entity: { kind: "course", label: "CSE 240" }, source: "canvas" });
    cb.signals.push({ type: "working_on", entity: { kind: "assignment", label: "CSE 240 Project 1" }, source: "student" });
    await put(a, ca); await put(b, cb);
    const ac = await getContext(store, a.id), bc = await getContext(store, b.id);
    expect(ac).not.toBeNull(); expect(bc).not.toBeNull();
    if (ac && bc) expect(guardText("Someone in your CSE 240 class wants to connect.", ac, bc, new Date(now))).toBeNull();
  });

  it("validates new signal metadata with the same privacy boundaries", () => {
    const policy = { ...DEFAULT_POLICY, participating: true, alumni_network: true };
    expect(parseSignal({ ...signal("can_help_with", "React"), confirmed_at: undefined }, policy, new Date(now)).ok).toBe(false);
    expect(parseSignal(signal("looking_for", "advice", ["person@example.edu"]), policy, new Date(now)).ok).toBe(false);
    expect(parseSignal({ ...signal("experienced_in", "React"), source: "canvas" }, policy, new Date(now)).ok).toBe(false);
  });
});

describe("relationship-aware rediscovery", () => {
  it("remembers an introduction for years but only proposes a new reason, with new consent", async () => {
    const { a, b, id } = await connected();
    now += 2 * 365 * DAY;
    await put(a, context("Alex", [signal("looking_for", "healthcare product advice")], { life_stage: "alumni" }));
    expect((await put(b, context("Jordan", [signal("can_help_with", "clinical workflow advice", ["healthcare"])], { life_stage: "alumni" }))).open_suggestion).toBe(false);
    await put(a, context("Alex", [signal("looking_for", "climate tech")]));
    expect((await put(b, context("Jordan", [signal("can_help_with", "climate technology")]))).open_suggestion).toBe(true);
    const ask = (await pending(a)).ask;
    expect(ask?.id).not.toBe(id);
    expect(ask?.text).toContain("connected with before");
    expect(ask?.text).toContain("climate technology");
    expect(JSON.stringify(ask)).not.toContain("Jordan");
    const next = ask?.id ?? "";
    await answer(a, next, "yes");
    expect((await pending(a)).agreed).toEqual([]);
    await answer(b, next, "yes");
    const history = await (await handleConnections(req(a, "connections"), deps)).json();
    expect(history).toMatchObject({ connections: [{ id, introductions: 2 }] });
    expect(JSON.stringify(history)).not.toMatch(/Jordan|example.edu|climate|healthcare/);
  });

  it("keeps feedback private and suppresses unwanted reconnections until explicitly reset", async () => {
    const { a, b, id } = await connected();
    expect((await handleConnections(req(a, "connections", "POST", { id, outcome: "not_useful" }), deps)).status).toBe(200);
    expect(await (await handleConnections(req(b, "connections"), deps)).json()).toMatchObject({ connections: [{ feedback: { useful: null } }] });
    expect((await handleConnections(req(student(), "connections", "POST", { id, outcome: "useful" }), deps)).status).toBe(404);
    now += 70 * DAY;
    await put(a, context("Alex", [signal("looking_for", "React")]));
    expect((await put(b, context("Jordan", [signal("can_help_with", "React")]))).open_suggestion).toBe(false);
    await handleConnections(req(a, "connections", "POST", { id, outcome: "reset" }), deps);
    expect((await put(a, context("Alex", [signal("looking_for", "React")]))).open_suggestion).toBe(true);
  });

  it("removes durable continuity from both sides when consent is withdrawn, and deletes identity on leave", async () => {
    const { a, b } = await connected();
    await put(a, { policy: { participating: false, alumni_network: false }, signals: [], free: [] });
    expect(await store.get(`profile:${a.id}`)).toBeNull();
    expect(await (await handleConnections(req(b, "connections"), deps)).json()).toEqual({ connections: [] });
    expect(store.keys().some((key) => key.startsWith("relationship:"))).toBe(false);
    await handleLeave(req(a, "me", "DELETE"), deps);
    expect(store.keys().some((key) => key.includes(a.id))).toBe(false);
  });

  it("retains no relationship when either person declines history retention", async () => {
    const a = student(), b = student();
    await put(a, context("Alex", [signal("looking_for", "React")], { remember_connections: false }));
    await put(b, context("Jordan", [signal("can_help_with", "React")]));
    const id = (await pending(a)).ask?.id ?? "";
    await answer(a, id, "yes"); await answer(b, id, "yes");
    expect(store.keys().some((key) => key.startsWith("relationship:"))).toBe(false);
  });
});

describe("acknowledged delivery", () => {
  it("replays an interrupted ask and agreed message, and suppresses each only after acknowledgment", async () => {
    const a = student(), b = student();
    await put(a, context("Alex", [signal("looking_for", "React")]));
    await put(b, context("Jordan", [signal("can_help_with", "React")]));
    const id = (await pending(a)).ask?.id ?? "";
    expect((await pending(a)).ask?.id).toBe(id);
    expect((await handleDelivered(req(student(), `suggestions/${id}/delivered`, "POST", { kind: "ask" }), deps)).status).toBe(404);
    expect((await handleDelivered(req(a, `suggestions/${id}/delivered`, "POST", { kind: "ask" }), deps)).status).toBe(200);
    expect((await pending(a)).ask).toBeNull();
    await answer(a, id, "later");
    now += DAY;
    expect((await pending(a)).ask?.id).toBe(id);
    await answer(a, id, "yes"); await answer(b, id, "yes");
    expect((await pending(a)).agreed).toHaveLength(1);
    expect((await pending(a)).agreed).toHaveLength(1);
    expect((await handleDelivered(req(a, `suggestions/${id}/delivered`, "POST", { kind: "agreed" }), deps)).status).toBe(200);
    expect((await pending(a)).agreed).toEqual([]);
  });
});
