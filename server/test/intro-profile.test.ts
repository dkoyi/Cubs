import { randomBytes, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAnswer, handleDelivered, handlePutContext, handleSuggestions } from "../src/handlers.js";
import type { Deps } from "../src/handlers.js";
import type { JudgeRequest } from "../src/judge.js";
import { getContext, getSuggestion } from "../src/loop.js";
import type { AskView } from "../src/loop.js";
import { DEFAULT_POLICY, parsePolicy, profileUrl } from "../src/signals.js";
import { InMemoryStore } from "../src/store.js";

const NOW = new Date("2026-10-25T16:00:00Z");
const person = () => ({ id: randomUUID(), token: randomBytes(32).toString("base64url") });
type Person = ReturnType<typeof person>;
const profile = { name: "Jordan Shah", headline: "Healthcare product builder", about: "Building tools for clinical teams.",
  links: [{ kind: "linkedin", url: "https://www.linkedin.com/in/jordan-example" }], photo_url: "https://images.example.edu/jordan.jpg" };
let store: InMemoryStore, deps: Deps;
beforeEach(() => { store = new InMemoryStore(() => NOW.getTime()); deps = { store, now: () => NOW }; });

function req(p: Person, path: string, method = "GET", body?: unknown): Request {
  return new Request(`https://supercub.test/api/${path}`, { method,
    headers: { "X-Student-Id": p.id, Authorization: `Bearer ${p.token}`, "X-Supercub-Delivery": "acknowledged" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function context(name: string, type: string, share = false) {
  return { policy: { participating: true, first_name: name, contact: `${name.toLowerCase()}@example.edu`, school: "ASU",
    share_intro_profile: share, intro_profile: profile }, signals: [
    { type, entity: { kind: "topic", label: "healthcare" }, source: "student" },
    { type: "open_to", entity: { kind: "activity", label: "advising" }, source: "student" },
  ] };
}
async function pair(share = true) {
  const a = person(), b = person();
  expect((await handlePutContext(req(a, "context", "PUT", context("Alex", "looking_for")), deps)).status).toBe(200);
  expect((await handlePutContext(req(b, "context", "PUT", context("Jordan", "can_help_with", share)), deps)).status).toBe(200);
  const data = await (await handleSuggestions(req(a, "suggestions"), deps)).json() as { ask: AskView };
  return { a, b, ask: data.ask };
}

describe("profile-led introductions", () => {
  it("shows the approved profile and relevant reason before acceptance, while gating private contact", async () => {
    const { a, b, ask } = await pair();
    expect(ask.profile).toEqual(profile);
    expect(ask.text).toContain("Jordan Shah");
    expect(ask.text).toContain("healthcare");
    expect(ask.text.endsWith("Want an intro?")).toBe(true);
    expect(ask.other_accepted).toBe(false);
    expect(JSON.stringify(ask)).not.toContain("jordan@example.edu");
    const stored = await getSuggestion(store, ask.id);
    expect(stored?.text_a).not.toContain("Jordan");
    expect(JSON.stringify(stored)).not.toContain("linkedin.com");
    expect((await handleAnswer(req(a, `suggestions/${ask.id}/answer`, "POST", { answer: "yes" }), deps)).status).toBe(200);
    const agreed = await (await handleAnswer(req(b, `suggestions/${ask.id}/answer`, "POST", { answer: "yes" }), deps)).json();
    expect(agreed).toMatchObject({ status: "agreed", contact: "alex@example.edu" });
  });

  it("does not turn old participation consent into profile sharing", async () => {
    const { b, ask } = await pair(false);
    expect(ask.profile).toBeUndefined();
    expect(ask.text).not.toContain("Jordan");
    expect((await getContext(store, b.id))?.policy.intro_profile).toBeUndefined();
    expect(DEFAULT_POLICY.share_intro_profile).toBe(false);
  });

  it("supports Link? follow-ups after delivery, and reports an actual first yes", async () => {
    const { a, b, ask } = await pair();
    await handleDelivered(req(a, `suggestions/${ask.id}/delivered`, "POST", { kind: "ask" }), deps);
    expect(await (await handleSuggestions(req(a, "suggestions"), deps)).json()).toMatchObject({ ask: null });
    await handleAnswer(req(b, `suggestions/${ask.id}/answer`, "POST", { answer: "yes" }), deps);
    const details = await (await handleSuggestions(req(a, `suggestions?id=${ask.id}`), deps)).json() as { ask: AskView };
    expect(details.ask.profile?.links).toEqual(profile.links);
    expect(details.ask.other_accepted).toBe(true);
    expect(details.ask.text).toContain("They're up for it. Want the intro?");
    expect((await handleSuggestions(req(person(), `suggestions?id=${ask.id}`), deps)).status).toBe(404);
  });

  it("withdraws a profile and invalidates cached open introductions", async () => {
    const { a, b, ask } = await pair();
    await handleAnswer(req(a, `suggestions/${ask.id}/answer`, "POST", { answer: "yes" }), deps);
    await handlePutContext(req(b, "context", "PUT", { policy: { share_intro_profile: false } }), deps);
    expect((await getContext(store, b.id))?.policy.intro_profile).toBeUndefined();
    expect((await handleSuggestions(req(a, `suggestions?id=${ask.id}`), deps)).status).toBe(404);
    expect(await (await handleAnswer(req(b, `suggestions/${ask.id}/answer`, "POST", { answer: "yes" }), deps)).json()).toMatchObject({ status: "passed" });
  });

  it("keeps profile identity out of model input and composes it after the model guard", async () => {
    const calls: JudgeRequest[] = [];
    deps.judge = { name: "mock", async judge(input) { calls.push(input); return null; } };
    const { ask } = await pair();
    expect(ask.profile?.name).toBe("Jordan Shah");
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls)).not.toMatch(/Jordan|linkedin|clinical teams/);
  });
});

describe("approved profile schema", () => {
  it("accepts explicit profile consent and strips unsupported fields", () => {
    const result = parsePolicy({ participating: true, first_name: "Jordan", share_intro_profile: true,
      intro_profile: { ...profile, contact: "private@example.edu", unrelated: "not part of the profile" } }, null);
    expect(result.ok && result.value.intro_profile).toEqual(profile);
    expect(parsePolicy({ participating: true, first_name: "Jordan", share_intro_profile: true }, null).ok).toBe(false);
    // Pausing still succeeds when an ordinary inactive context record has expired.
    expect(parsePolicy({ participating: false, share_intro_profile: true }, null).ok).toBe(true);
  });

  it("rejects private contact text and non-public or credential-bearing links", () => {
    for (const url of ["http://example.edu/jordan", "https://localhost/photo", "https://127.0.0.1/photo", "https://host.local/photo",
      "https://name:secret@example.edu/photo", "https://example.edu/photo?token=private", "mailto:jordan@example.edu"]) {
      expect(profileUrl(url)).toBeNull();
    }
    expect(profileUrl("https://evil.example/in/jordan", "linkedin")).toBeNull();
    expect(parsePolicy({ share_intro_profile: true, intro_profile: { ...profile, about: "Email jordan@example.edu" } }, null).ok).toBe(false);
    expect(parsePolicy({ share_intro_profile: true, intro_profile: { ...profile, about: "GPA 4.0" } }, null).ok).toBe(false);
  });
});
