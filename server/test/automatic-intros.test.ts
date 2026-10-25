import { randomBytes, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAnswer, handleCapabilities, handlePutContext, handleSuggestions } from "../src/handlers.js";
import type { Deps } from "../src/handlers.js";
import type { Judge } from "../src/judge.js";
import { getContext, getSuggestion } from "../src/loop.js";
import { DEFAULT_POLICY, parsePolicy } from "../src/signals.js";
import type { Policy } from "../src/signals.js";
import { CAPABILITIES, SKILL_RELEASE } from "../src/capabilities.js";
import { InMemoryStore } from "../src/store.js";

const DAY = 86400_000;
const person = () => ({ id: randomUUID(), token: randomBytes(32).toString("base64url") });
type Person = ReturnType<typeof person>;
let now: number, store: InMemoryStore, deps: Deps;
beforeEach(() => { now = Date.parse("2026-10-25T16:00:00Z"); store = new InMemoryStore(() => now); deps = { store, now: () => new Date(now) }; });
function request(p: Person, path: string, method = "GET", body?: unknown): Request {
  return new Request(`https://supercub.test/api/${path}`, { method,
    headers: { "X-Student-Id": p.id, Authorization: `Bearer ${p.token}`, "X-Supercub-Delivery": "acknowledged" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function context(name: string, automatic: boolean, approval = new Date(now).toISOString(), activities = ["study"]) {
  const policy: Policy = { ...DEFAULT_POLICY, participating: true, school: "ASU", first_name: name, contact: `${name.toLowerCase()}@example.test`,
    intro: automatic ? "automatic" : "ask", share_intro_profile: true, intro_profile: { name: `${name} Example`, headline: "Example project builder", links: [] } };
  if (automatic) policy.automatic_intro_consent = { approved_at: approval, contact: policy.contact!, discoverable: "school", school: "ASU", affiliations: [],
    alumni_network: false, share_events: false, share_applications: false, activities: activities as ["study"], max_suggestions_per_week: policy.max_suggestions_per_week };
  return { policy, signals: [
    { type: "working_on", entity: { kind: "topic", label: "healthcare" }, source: "student" },
    { type: "open_to", entity: { kind: "activity", label: "study" }, source: "student" },
  ], replace_signals: true };
}
async function put(p: Person, body: unknown) { return handlePutContext(request(p, "context", "PUT", body), deps); }
async function pending(p: Person) { return (await handleSuggestions(request(p, "suggestions"), deps)).json() as Promise<{ ask: { id: string; text: string; other_consent?: string } | null; agreed: Array<{ id: string; contact: string; text: string; profile?: { name: string }; consent?: { you: string; other: string }; reason?: string }> }>; }
async function answer(p: Person, id: string, value: string) { return (await handleAnswer(request(p, `suggestions/${id}/answer`, "POST", { answer: value }), deps)).json() as Promise<{ status: string; contact?: string }>; }

describe("bounded standing introduction permission", () => {
  it("automatically releases contacts with two valid setup grants, without inventing yes answers", async () => {
    const a = person(), b = person();
    expect((await put(a, context("Alex", true))).status).toBe(200);
    expect((await put(b, context("Jordan", true))).status).toBe(200);
    const result = await pending(a);
    expect(result.ask).toBeNull(); expect(result.agreed).toHaveLength(1);
    expect(result.agreed[0]).toMatchObject({ contact: "jordan@example.test", profile: { name: "Jordan Example" }, consent: { you: "standing", other: "standing" } });
    expect(result.agreed[0]?.text).not.toContain("said yes");
    const stored = await getSuggestion(store, result.agreed[0]!.id);
    expect(stored?.side_a.answer).toBeNull(); expect(stored?.side_b.answer).toBeNull();
    expect(stored?.side_a.standing_consent?.approved_at).toBe(new Date(now).toISOString());
    expect((await pending(b)).agreed[0]?.contact).toBe("alex@example.test");
  });
  it("still asks a manual participant, while truthfully describing the other's standing permission", async () => {
    const a = person(), b = person();
    await put(a, context("Alex", true)); await put(b, context("Jordan", false));
    expect(await pending(a)).toMatchObject({ ask: null, agreed: [] });
    const manual = await pending(b);
    expect(manual.ask?.other_consent).toBe("standing");
    expect(manual.ask?.text).toMatch(/They're up for it\. Want the intro\?$/);
    expect(manual.agreed).toEqual([]);
    expect(await answer(b, manual.ask!.id, "yes")).toMatchObject({ status: "agreed", contact: "alex@example.test" });
    expect((await pending(a)).agreed[0]?.contact).toBe("jordan@example.test");
  });
  it("does not upgrade missing consent or legacy auto_study metadata", async () => {
    expect(parsePolicy({ participating: true, first_name: "Alex", intro: "automatic" }, null).ok).toBe(false);
    const a = person(), b = person();
    const legacy = context("Alex", false); legacy.policy.intro = "auto_study";
    await put(a, legacy); await put(b, context("Jordan", true));
    expect((await pending(a)).ask).not.toBeNull();
    expect((await pending(a)).agreed).toEqual([]);
  });
  it("does not use expired grants, never refreshes approval by sync, and does not limit a grant to its listed activities", async () => {
    const a = person(), b = person();
    const at = new Date(now - 366 * DAY).toISOString();
    await put(a, context("Alex", true, at)); await put(b, context("Jordan", true));
    expect((await pending(a)).agreed).toEqual([]);
    expect((await pending(a)).ask).not.toBeNull();
    await put(a, context("Alex", true, at));
    expect((await getContext(store, a.id))?.policy.automatic_intro_consent?.approved_at).toBe(at);
    const c = person(), d = person();
    await put(c, context("Casey", true, undefined, ["advising"])); await put(d, context("Dana", true));
    const unlisted = await pending(c);
    expect(unlisted.ask).toBeNull();
    expect(unlisted.agreed).toHaveLength(1);
    expect(unlisted.agreed[0]).toMatchObject({ contact: "dana@example.test", consent: { you: "standing", other: "standing" } });
  });
  it("invalidates old standing permission when the contact or scope changes", async () => {
    const a = person(), b = person();
    await put(a, context("Alex", true)); await put(b, context("Jordan", false));
    const id = (await pending(b)).ask!.id;
    expect((await put(a, { policy: { contact: "new@example.test" } })).status).toBe(200);
    expect((await getContext(store, a.id))?.policy.intro).toBe("ask");
    expect((await getContext(store, a.id))?.policy.automatic_intro_consent).toBeUndefined();
    expect(await answer(b, id, "yes")).toMatchObject({ status: "passed" });
  });
  it("permits no/later to override standing permission for an unfinished mixed introduction", async () => {
    const a = person(), b = person();
    await put(a, context("Alex", true)); await put(b, context("Jordan", false));
    const id = (await pending(b)).ask!.id;
    expect(await answer(a, id, "later")).toMatchObject({ status: "later" });
    expect(await answer(b, id, "yes")).toMatchObject({ status: "waiting" });
    expect((await pending(a)).agreed).toEqual([]);
    now += DAY + 1000;
    expect((await pending(a)).ask?.id).toBe(id);
    expect(await answer(a, id, "no")).toMatchObject({ status: "passed" });
    expect((await pending(b)).agreed).toEqual([]);
  });
  it("does not serve an automatic contact after its permission is revoked before retrieval", async () => {
    const a = person(), b = person();
    await put(a, context("Alex", true)); await put(b, context("Jordan", true));
    const list = await store.smembers(`suggs:${a.id}`);
    expect(list).toHaveLength(1);
    await put(a, { policy: { intro: "ask" } });
    expect((await pending(b)).agreed).toEqual([]);
    expect(await answer(b, list[0]!, "yes")).toMatchObject({ status: "passed" });
  });
  it("rejects future or mismatched approval and a mismatched setup release before mutation", async () => {
    const a = person();
    expect((await put(a, context("Alex", true, new Date(now + DAY).toISOString()))).status).toBe(400);
    expect(await getContext(store, a.id)).toBeNull();
    const body = context("Alex", true); body.policy.automatic_intro_consent!.contact = "other@example.test";
    expect((await put(a, body)).status).toBe(400);
    expect((await put(a, { ...context("Alex", true), client_release: "unknown-release" })).status).toBe(409);
    expect(await getContext(store, a.id)).toBeNull();
    const caps = await handleCapabilities(new Request("https://supercub.test/api/capabilities"), deps);
    expect(await caps.json()).toEqual({ skill_release: SKILL_RELEASE, capabilities: CAPABILITIES });
  });
  it("automatic intro text says the name once, as the start of the reason, and keeps the named reason separately", async () => {
    const cases: Array<[string, string]> = [
      ["Someone is also attending Dev Hacks.", "Jordan is also attending Dev Hacks."],
      ["Someone has offered to help with healthcare.", "Jordan has offered to help with healthcare."],
      ["Someone's working on healthcare too.", "Jordan's working on healthcare too."],
    ];
    for (const [reason, head] of cases) {
      store = new InMemoryStore(() => now);
      const text = `${reason} Want an intro?`;
      const judge: Judge = { name: "mock", async judge() { return { worth: 0.9, why: "ok", text_for_a: text, text_for_b: text }; } };
      deps = { store, now: () => new Date(now), judge };
      const a = person(), b = person();
      await put(a, context("Alex", true)); await put(b, context("Jordan", true));
      const agreed = (await pending(a)).agreed[0];
      expect(agreed?.text).toBe(head);
      expect(agreed?.text).not.toContain("Jordan Example");
      expect(agreed?.reason).toBe(reason.replace(/^Someone/, "Jordan Example"));
    }
  });
});
