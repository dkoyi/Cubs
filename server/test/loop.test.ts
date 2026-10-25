import { randomBytes, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAnswer, handleDiscover, handleLeave, handlePutContext, handleSuggestions } from "../src/handlers.js";
import type { Deps } from "../src/handlers.js";
import type { Judge, JudgeRequest, Judgment } from "../src/judge.js";
import type { AgreedView, AskView, Suggestion } from "../src/loop.js";
import { getSuggestion } from "../src/loop.js";
import { InMemoryStore } from "../src/store.js";

const BASE = "https://supercub.test";
const HOUR = 3_600_000;

interface Student {
  id: string;
  token: string;
}

const newStudent = (): Student => ({ id: randomUUID(), token: randomBytes(32).toString("base64url") });

function headers(s: Student): Record<string, string> {
  return { "X-Student-Id": s.id, Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" };
}

const put = (s: Student, body: unknown): Request =>
  new Request(`${BASE}/api/context`, { method: "PUT", headers: headers(s), body: JSON.stringify(body) });
const getSuggestions = (s: Student): Request =>
  new Request(`${BASE}/api/suggestions`, { method: "GET", headers: headers(s) });
const answer = (s: Student, id: string, value: string): Request =>
  new Request(`${BASE}/api/suggestions/${id}/answer`, {
    method: "POST",
    headers: headers(s),
    body: JSON.stringify({ answer: value }),
  });
const del = (s: Student): Request => new Request(`${BASE}/api/me`, { method: "DELETE", headers: headers(s) });

interface ContextBody {
  accepted: number;
  rejected: Array<{ index: number; reason: string }>;
  signals_total: number;
  open_suggestion: boolean;
  events: unknown[];
}
interface SuggestionsBody {
  ask: AskView | null;
  agreed: AgreedView[];
  nothing_new: boolean;
}
interface AnswerBody {
  status: string;
  first_name?: string;
  contact?: string | null;
  when?: { start: string; end: string } | null;
  text?: string;
}

const body = async <T>(res: Response): Promise<T> => (await res.json()) as T;

let nowMs = Date.parse("2026-10-24T16:00:00.000Z");
let store: InMemoryStore;
let deps: Deps;

beforeEach(() => {
  nowMs = Date.parse("2026-10-24T16:00:00.000Z");
  store = new InMemoryStore(() => nowMs);
  deps = { store, now: () => new Date(nowMs) };
});

const classSignals = [
  {
    type: "enrolled_in",
    entity: { kind: "course", label: "CSE 310" },
    detail: "section 12345",
    source: "canvas",
    observed_at: "2026-10-24T08:00:00-07:00",
  },
  {
    type: "working_on",
    entity: { kind: "assignment", label: "HW4" },
    detail: "hash tables",
    due: "2026-10-28T23:59:00-07:00",
    source: "canvas",
    observed_at: "2026-10-24T08:00:00-07:00",
  },
  { type: "open_to", entity: { kind: "activity", label: "study" }, source: "memory", observed_at: "2026-10-24T08:00:00-07:00" },
];

function context(firstName: string, contact: string, free: Array<{ start: string; end: string }>, extra: Array<Record<string, unknown>> = []) {
  return {
    policy: { participating: true, discoverable: "school", school: "ASU", first_name: firstName, contact },
    signals: [...classSignals, ...extra],
    free,
    tz: "America/Phoenix",
  };
}

const alexCtx = context("Alex", "+1 480 555 0101", [{ start: "2026-10-25T18:00:00-07:00", end: "2026-10-25T21:00:00-07:00" }]);
const jordanCtx = context("Jordan", "jordan@example.edu", [
  { start: "2026-10-25T19:00:00-07:00", end: "2026-10-25T22:00:00-07:00" },
]);

async function pair(): Promise<{ alex: Student; jordan: Student; id: string }> {
  const alex = newStudent();
  const jordan = newStudent();
  await handlePutContext(put(alex, alexCtx), deps);
  await handlePutContext(put(jordan, jordanCtx), deps);
  const ask = (await body<SuggestionsBody>(await handleSuggestions(getSuggestions(alex), deps))).ask;
  return { alex, jordan, id: ask?.id ?? "" };
}

describe("two-student loop", () => {
  it("two students with the same course and assignment each get one ask, both say yes, both get the other's name, contact and a time", async () => {
    const alex = newStudent();
    const jordan = newStudent();

    let res = await handlePutContext(put(alex, alexCtx), deps);
    expect(res.status).toBe(200);
    const first = await body<ContextBody>(res);
    expect(first).toEqual({ accepted: 3, rejected: [], signals_total: 3, open_suggestion: false, events: [] });

    res = await handlePutContext(put(jordan, jordanCtx), deps);
    expect((await body<ContextBody>(res)).open_suggestion).toBe(true);

    // Re-sending the same context is idempotent: same counts, still one suggestion.
    const again = await body<ContextBody>(await handlePutContext(put(alex, alexCtx), deps));
    expect(again).toEqual({ accepted: 3, rejected: [], signals_total: 3, open_suggestion: true, events: [] });

    const asks: AskView[] = [];
    for (const s of [alex, jordan]) {
      const view = await body<SuggestionsBody>(await handleSuggestions(getSuggestions(s), deps));
      expect(view.agreed).toEqual([]);
      expect(view.nothing_new).toBe(false);
      expect(view.ask).not.toBeNull();
      if (view.ask !== null) asks.push(view.ask);
    }
    const [alexAsk, jordanAsk] = asks;
    expect(alexAsk?.id).toBe(jordanAsk?.id);
    expect(alexAsk?.kind).toBe("study");
    expect(alexAsk?.shared).toEqual(["enrolled_in:cse310", "open_to:study", "working_on:hw4"]);
    expect(alexAsk?.text).toBe(
      "Someone in your CSE 310 class is working on HW4 too and is open to studying with classmates. Want me to see if you'd both like to connect?",
    );
    expect(alexAsk?.text).not.toContain("Jordan");
    expect(jordanAsk?.text).not.toContain("Alex");
    const id = alexAsk?.id ?? "";

    // The suggestion records the reasoning and both sides as asked.
    const stored = await getSuggestion(store, id);
    expect(stored?.status).toBe("asked_both");
    expect(stored?.judge).toBe("rules");
    expect(stored?.score).toBe(1);
    expect(stored?.why).toContain("judge: rules");

    // Unanswered asks are returned again before they expire.
    const repeat = await body<SuggestionsBody>(await handleSuggestions(getSuggestions(alex), deps));
    expect(repeat.ask?.id).toBe(id);

    const alexYes = await body<AnswerBody>(await handleAnswer(answer(alex, id, "yes"), deps));
    expect(alexYes).toEqual({ status: "waiting" });
    // Answering twice while waiting is refused.
    expect((await handleAnswer(answer(alex, id, "no"), deps)).status).toBe(409);

    // Waiting on Jordan: Alex has nothing new.
    expect((await body<SuggestionsBody>(await handleSuggestions(getSuggestions(alex), deps))).nothing_new).toBe(true);

    const jordanYes = await body<AnswerBody>(await handleAnswer(answer(jordan, id, "yes"), deps));
    expect(jordanYes.status).toBe("agreed");
    expect(jordanYes.first_name).toBe("Alex");
    expect(jordanYes.contact).toBe("+1 480 555 0101");

    const meeting = { start: "2026-10-25T19:00:00-07:00", end: "2026-10-25T20:00:00-07:00" };
    for (const [s, name, contact] of [
      [alex, "Jordan", "jordan@example.edu"],
      [jordan, "Alex", "+1 480 555 0101"],
    ] as const) {
      const view = await body<SuggestionsBody>(await handleSuggestions(getSuggestions(s), deps));
      expect(view.ask).toBeNull();
      expect(view.agreed).toHaveLength(1);
      expect(view.agreed[0]).toEqual({
        id,
        first_name: name,
        contact,
        when: meeting,
        text: `You're on. ${name} said yes too. Sun Oct 25, 7 to 8 pm.`,
      });
      // Delivered once.
      expect((await body<SuggestionsBody>(await handleSuggestions(getSuggestions(s), deps))).nothing_new).toBe(true);
    }

    // Answering an agreed suggestion again returns the outcome, idempotently.
    const replay = await body<AnswerBody>(await handleAnswer(answer(alex, id, "yes"), deps));
    expect(replay.status).toBe("agreed");
    expect(replay.first_name).toBe("Jordan");
  });

  it("contacts are never released before both say yes", async () => {
    const { alex, jordan, id } = await pair();
    await handleAnswer(answer(alex, id, "yes"), deps);
    for (const key of store.keys()) {
      if (!key.startsWith("sugg:")) continue;
      const raw = (await store.get(key)) ?? "";
      expect(raw).not.toContain("jordan@example.edu");
      expect(raw).not.toContain("480 555");
    }
    const view = await body<SuggestionsBody>(await handleSuggestions(getSuggestions(jordan), deps));
    expect(view.ask?.id).toBe(id);
    expect(JSON.stringify(view)).not.toContain("Alex");
  });

  it("DELETE /api/me wipes context, suggestions and answers", async () => {
    const { alex, jordan, id } = await pair();
    await handleAnswer(answer(alex, id, "yes"), deps);
    await handleAnswer(answer(jordan, id, "yes"), deps);

    expect((await handleLeave(del(alex), deps)).status).toBe(200);
    expect(store.keys().filter((key) => key.includes(alex.id))).toEqual([]);
    expect(store.keys().filter((key) => key.startsWith("sugg:"))).toEqual([]);
    for (const key of store.keys()) {
      const raw = await store.get(key);
      if (raw !== null) {
        expect(raw).not.toContain("Alex");
        expect(raw).not.toContain("480 555");
      }
      expect((await store.smembers(key)).includes(alex.id)).toBe(false);
      expect((await store.smembers(key)).includes(id)).toBe(false);
    }
    const view = await body<SuggestionsBody>(await handleSuggestions(getSuggestions(jordan), deps));
    expect(view).toEqual({ ask: null, agreed: [], nothing_new: true });
    expect((await handleAnswer(answer(jordan, id, "yes"), deps)).status).toBe(404);
  });
});

describe("answers", () => {
  it("no passes for both sides, cools the pair down for an hour and blocks the same reason for a day", async () => {
    const { alex, jordan, id } = await pair();
    expect(await body<AnswerBody>(await handleAnswer(answer(jordan, id, "no"), deps))).toEqual({ status: "passed" });
    for (const s of [alex, jordan]) {
      expect((await body<SuggestionsBody>(await handleSuggestions(getSuggestions(s), deps))).ask).toBeNull();
    }
    expect(await body<AnswerBody>(await handleAnswer(answer(alex, id, "yes"), deps))).toEqual({ status: "passed" });
    expect((await handleAnswer(answer(jordan, id, "yes"), deps)).status).toBe(409);

    const resync = async (): Promise<boolean> => {
      await handlePutContext(put(alex, alexCtx), deps);
      return (await body<ContextBody>(await handlePutContext(put(jordan, jordanCtx), deps))).open_suggestion;
    };
    // Inside the one-hour pair cooldown nothing new is suggested.
    expect(await resync()).toBe(false);
    // After the cooldown the pair is free again, but the same reason is still blocked for a day.
    nowMs += 2 * HOUR;
    expect(await resync()).toBe(false);
    // Once the day has passed, the same reason may be suggested again.
    nowMs += 23 * HOUR;
    expect(await resync()).toBe(true);
  });

  it("later re-asks after 24 hours once; a second later counts as no", async () => {
    const { alex, id } = await pair();
    const later = await body<AnswerBody & { ask_again_at: string }>(await handleAnswer(answer(alex, id, "later"), deps));
    expect(later.status).toBe("later");
    expect(later.ask_again_at).toBe("2026-10-25T16:00:00.000Z");

    nowMs += 23 * HOUR;
    expect((await body<SuggestionsBody>(await handleSuggestions(getSuggestions(alex), deps))).ask).toBeNull();
    nowMs += 2 * HOUR;
    expect((await body<SuggestionsBody>(await handleSuggestions(getSuggestions(alex), deps))).ask?.id).toBe(id);

    expect((await body<AnswerBody>(await handleAnswer(answer(alex, id, "later"), deps))).status).toBe("passed");
  });

  it("an unanswered suggestion expires after 48 hours", async () => {
    const { alex, id } = await pair();
    nowMs += 49 * HOUR;
    expect((await body<SuggestionsBody>(await handleSuggestions(getSuggestions(alex), deps))).ask).toBeNull();
    const res = await handleAnswer(answer(alex, id, "yes"), deps);
    expect(res.status).toBe(410);
    expect((await getSuggestion(store, id))?.status).toBe("expired");
  });

  it("rejects bad answers, unknown ids and other students", async () => {
    const { id } = await pair();
    const stranger = newStudent();
    const { alex } = await pair();
    expect((await handleAnswer(answer(alex, id, "maybe"), deps)).status).toBe(400);
    expect((await handleAnswer(answer(stranger, id, "yes"), deps)).status).toBe(404);
    expect((await handleAnswer(answer(alex, "not-a-uuid", "yes"), deps)).status).toBe(400);
  });

  it("accepts the id in the query string or body when the path has none", async () => {
    const { alex, id } = await pair();
    const req = new Request(`${BASE}/api/suggestions?id=${id}`, {
      method: "POST",
      headers: headers(alex),
      body: JSON.stringify({ answer: "yes" }),
    });
    expect((await body<AnswerBody>(await handleAnswer(req, deps))).status).toBe("waiting");
  });
});

describe("discovery rules", () => {
  it("one open suggestion per student: a third classmate waits", async () => {
    await pair();
    const casey = newStudent();
    const res = await body<ContextBody>(
      await handlePutContext(put(casey, context("Casey", "casey@example.edu", jordanCtx.free)), deps),
    );
    expect(res.open_suggestion).toBe(false);
  });

  it("school discoverability needs the same school; network does not", async () => {
    const a = newStudent();
    const b = newStudent();
    await handlePutContext(put(a, alexCtx), deps);
    const other = { ...jordanCtx, policy: { ...jordanCtx.policy, school: "UCLA" } };
    expect((await body<ContextBody>(await handlePutContext(put(b, other), deps))).open_suggestion).toBe(false);

    const bothNetwork = (c: typeof alexCtx) => ({ ...c, policy: { ...c.policy, discoverable: "network" } });
    await handlePutContext(put(a, bothNetwork(alexCtx)), deps);
    const res = await body<ContextBody>(await handlePutContext(put(b, bothNetwork(other)), deps));
    expect(res.open_suggestion).toBe(true);
  });

  it("section discoverability needs the same section detail", async () => {
    const a = newStudent();
    const b = newStudent();
    const section = (c: typeof alexCtx, detail: string) => ({
      ...c,
      policy: { ...c.policy, discoverable: "section" },
      signals: c.signals.map((s) => (s.type === "enrolled_in" ? { ...s, detail } : s)),
    });
    await handlePutContext(put(a, section(alexCtx, "section 12345")), deps);
    expect(
      (await body<ContextBody>(await handlePutContext(put(b, section(jordanCtx, "section 99999")), deps))).open_suggestion,
    ).toBe(false);
    expect(
      (await body<ContextBody>(await handlePutContext(put(b, section(jordanCtx, "Section  12345")), deps))).open_suggestion,
    ).toBe(true);
  });

  it("an opt-out body with policy only is accepted and keeps nothing", async () => {
    const s = newStudent();
    await handlePutContext(put(s, alexCtx), deps);
    const res = await handlePutContext(put(s, { tz: "America/Phoenix", policy: { participating: false } }), deps);
    expect(res.status).toBe(200);
    expect(await body<ContextBody>(res)).toEqual({ accepted: 0, rejected: [], signals_total: 0, open_suggestion: false, events: [] });
    const raw = (await store.get(`ctx:${s.id}`)) ?? "";
    expect(raw).not.toContain("CSE 310");
    expect(raw).toContain('"free":[]');
    expect(await store.smembers("participants")).not.toContain(s.id);

    const fresh = newStudent();
    expect((await handlePutContext(put(fresh, { policy: { participating: false } }), deps)).status).toBe(200);
  });

  it("students who stop participating are not discovered and their signals are not stored", async () => {
    const a = newStudent();
    const b = newStudent();
    await handlePutContext(put(a, { ...alexCtx, policy: { ...alexCtx.policy, participating: false } }), deps);
    const res = await body<ContextBody>(await handlePutContext(put(b, jordanCtx), deps));
    expect(res.open_suggestion).toBe(false);
    const aRes = await body<ContextBody>(
      await handlePutContext(put(a, { ...alexCtx, policy: { ...alexCtx.policy, participating: false } }), deps),
    );
    expect(aRes.signals_total).toBe(0);
    expect(aRes.rejected.every((r) => r.reason === "participating is off")).toBe(true);
  });

  it("opting out closes open suggestions, so an earlier yes cannot release the contact", async () => {
    const { alex, jordan, id } = await pair();
    await handleSuggestions(getSuggestions(jordan), deps);
    await handleAnswer(answer(alex, id, "yes"), deps);
    await handlePutContext(put(alex, { ...alexCtx, policy: { ...alexCtx.policy, participating: false } }), deps);
    const res = await body<AnswerBody>(await handleAnswer(answer(jordan, id, "yes"), deps));
    expect(res).toEqual({ status: "passed" });
    expect(JSON.stringify(res)).not.toContain("alex@");
  });

  it("a course alone is below the prefilter", async () => {
    const a = newStudent();
    const b = newStudent();
    const courseOnly = (c: typeof alexCtx) => ({ ...c, signals: [classSignals[0]], free: [] });
    await handlePutContext(put(a, courseOnly(alexCtx)), deps);
    const res = await body<ContextBody>(await handlePutContext(put(b, courseOnly(jordanCtx)), deps));
    expect(res.open_suggestion).toBe(false);
  });
});

describe("permission revocation", () => {
  it("a named new student without an opt-in cannot publish context", async () => {
    const s = newStudent();
    const res = await body<ContextBody>(await handlePutContext(put(s, { policy: { first_name: "Sam" }, signals: classSignals }), deps));
    expect(res.accepted).toBe(0);
    expect(res.signals_total).toBe(0);
    expect(res.rejected.every((r) => r.reason === "participating is off")).toBe(true);
    expect(await store.smembers("participants")).not.toContain(s.id);
  });

  it("section scope cannot connect identical course/section codes at different schools", async () => {
    const a = newStudent();
    const b = newStudent();
    await handlePutContext(put(a, { ...alexCtx, policy: { ...alexCtx.policy, discoverable: "section" } }), deps);
    const res = await body<ContextBody>(await handlePutContext(put(b, { ...jordanCtx, policy: { ...jordanCtx.policy, discoverable: "section", school: "UCLA" } }), deps));
    expect(res.open_suggestion).toBe(false);
  });

  it("turning events off purges remembered events and closes an already accepted ask", async () => {
    const { alex, jordan, id } = await pair();
    const event = { type: "attending", entity: { kind: "event", label: "Cubbie Hackathon" }, source: "memory" };
    await handlePutContext(put(alex, { policy: { share_events: true }, signals: [event] }), deps);
    await handleAnswer(answer(alex, id, "yes"), deps);
    await handlePutContext(put(alex, { policy: { share_events: false } }), deps);
    expect(await getSuggestion(store, id)).toMatchObject({ status: "passed", release_a: null, release_b: null });
    const ctx = JSON.parse((await store.get(`ctx:${alex.id}`)) ?? "{}");
    expect(ctx.signals.some((s: { type: string }) => s.type === "attending")).toBe(false);
    expect(await body<AnswerBody>(await handleAnswer(answer(jordan, id, "yes"), deps))).toEqual({ status: "passed" });
  });

  it("narrowing scope closes an existing suggestion before the other yes", async () => {
    const { alex, jordan, id } = await pair();
    await handleAnswer(answer(alex, id, "yes"), deps);
    await handlePutContext(put(alex, { policy: { discoverable: "section" } }), deps);
    expect(await body<AnswerBody>(await handleAnswer(answer(jordan, id, "yes"), deps))).toEqual({ status: "passed" });
  });

  it("snapshot sync withdraws old offers/preferences even when replaced by other signals", async () => {
    const { alex, id } = await pair();
    const offer = { type: "can_help_with", entity: { kind: "topic", label: "recursion" }, source: "student" };
    await handlePutContext(put(alex, { signals: [offer] }), deps);
    // Same-sized replacement must still detect removal, not just a lower signal count.
    const replacement = { type: "interested_in", entity: { kind: "topic", label: "robotics" }, source: "student" };
    const res = await body<ContextBody>(await handlePutContext(put(alex, { signals: [classSignals[0], classSignals[1], replacement, { ...replacement, entity: { kind: "topic", label: "music" } }], replace_signals: true }), deps));
    expect(res.signals_total).toBe(4);
    const raw = (await store.get(`ctx:${alex.id}`)) ?? "";
    expect(raw).not.toContain("can_help_with");
    expect(raw).not.toContain("open_to");
    expect((await getSuggestion(store, id))?.status).toBe("passed");
    expect((await handlePutContext(put(alex, { replace_signals: "yes" }), deps)).status).toBe(400);
  });

  it("the daily cap defaults to several suggestions, follows SUPERCUB_MAX_PER_DAY, and a personal cap of 0 means none", async () => {
    const { alex, id } = await pair();
    await handleAnswer(answer(alex, id, "no"), deps);
    const third = newStudent();
    const res = await body<ContextBody>(await handlePutContext(put(third, context("Taylor", "taylor@example.edu", [])), deps));
    // Alex and Jordan have each had one suggestion today, under the default daily cap of 5.
    expect(res.open_suggestion).toBe(true);

    const saved = process.env.SUPERCUB_MAX_PER_DAY;
    process.env.SUPERCUB_MAX_PER_DAY = "1";
    try {
      store = new InMemoryStore(() => nowMs);
      deps = { store, now: () => new Date(nowMs) };
      const capped = await pair();
      await handleAnswer(answer(capped.alex, capped.id, "no"), deps);
      const fourth = newStudent();
      const blocked = await body<ContextBody>(await handlePutContext(put(fourth, context("Riley", "riley@example.edu", [])), deps));
      // Alex and Jordan used the configured cap of one, so Riley cannot get a new ask with either.
      expect(blocked.open_suggestion).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.SUPERCUB_MAX_PER_DAY;
      else process.env.SUPERCUB_MAX_PER_DAY = saved;
    }

    store = new InMemoryStore(() => nowMs);
    deps = { store, now: () => new Date(nowMs) };
    const none = newStudent();
    const other = newStudent();
    await handlePutContext(put(none, { ...alexCtx, policy: { ...alexCtx.policy, max_suggestions_per_week: 0 } }), deps);
    const zero = await body<ContextBody>(await handlePutContext(put(other, jordanCtx), deps));
    expect(zero.open_suggestion).toBe(false);
  });
});

describe("PUT /api/context validation", () => {
  it("rejects signals on the never-accepted list with a reason and stores the rest", async () => {
    const s = newStudent();
    const signals = [
      { type: "working_on", entity: { kind: "assignment", label: "HW3" }, detail: "got 87/100", source: "canvas" },
      { type: "interested_in", entity: { kind: "topic", label: "Re: lunch plans" }, source: "memory" },
      { type: "attending", entity: { kind: "event", label: "Devils Invent Hackathon" }, source: "email" },
      { type: "working_on", entity: { kind: "topic", label: "graphs" }, detail: "x".repeat(121), source: "memory" },
      { type: "interested_in", entity: { kind: "topic", label: "robotics" }, detail: "meet in room 204", source: "memory" },
      { type: "open_to", entity: { kind: "activity", label: "dating" }, source: "memory" },
      { type: "interested_in", entity: { kind: "topic", label: "databases" }, detail: "ping me at a@b.edu or 480-555-0101", source: "memory" },
      { type: "enrolled_in", entity: { kind: "topic", label: "CSE 310" }, source: "canvas" },
      { type: "grade", entity: { kind: "course", label: "CSE 310" }, source: "canvas" },
      { type: "working_on", entity: { kind: "assignment", label: "HW1" }, due: "2026-10-01T23:59:00-07:00", source: "canvas" },
    ];
    const res = await body<ContextBody>(
      await handlePutContext(put(s, { policy: { participating: true, first_name: "Sam" }, signals }), deps),
    );
    expect(res.accepted).toBe(1);
    expect(res.signals_total).toBe(1);
    expect(res.rejected.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5, 7, 8, 9]);
    expect(res.rejected[0]?.reason).toContain("grade");
    expect(res.rejected[1]?.reason).toContain("email subject");
    expect(res.rejected[2]?.reason).toBe("share_events is off");
    expect(res.rejected[4]?.reason).toContain("finer than campus");
    expect(res.rejected[8]?.reason).toBe("already expired");

    const raw = (await store.get(`ctx:${s.id}`)) ?? "";
    expect(raw).not.toContain("a@b.edu");
    expect(raw).not.toContain("480-555-0101");
    expect(raw).toContain('"detail":"ping me at or"');
  });

  it("calendar events must look public, and only when share_events is on", async () => {
    const s = newStudent();
    const signals = [
      { type: "attending", entity: { kind: "event", label: "Dentist" }, source: "calendar", when: "2026-10-27T10:00:00-07:00" },
      { type: "attending", entity: { kind: "event", label: "Fall Career Fair" }, source: "calendar", when: "2026-10-27T10:00:00-07:00" },
    ];
    const res = await body<ContextBody>(
      await handlePutContext(put(s, { policy: { participating: true, first_name: "Sam", share_events: true }, signals }), deps),
    );
    expect(res.accepted).toBe(1);
    expect(res.rejected).toEqual([{ index: 0, reason: "event does not look like a public event" }]);
  });

  it("requires a first name, caps signals per call, and validates free and tz", async () => {
    const s = newStudent();
    expect((await handlePutContext(put(s, { policy: { participating: true }, signals: [] }), deps)).status).toBe(400);
    const tooMany = Array.from({ length: 61 }, () => classSignals[2]);
    expect((await handlePutContext(put(s, { policy: { participating: true, first_name: "Sam" }, signals: tooMany }), deps)).status).toBe(400);
    expect((await handlePutContext(put(s, { policy: { participating: true, first_name: "Sam" }, tz: "Mars/Olympus" }), deps)).status).toBe(400);
    expect(
      (await handlePutContext(put(s, { policy: { participating: true, first_name: "Sam" }, free: [{ start: "tomorrow", end: "later" }] }), deps)).status,
    ).toBe(400);
    expect((await handlePutContext(put(s, { policy: { participating: true, first_name: "Sam", contact: "not a contact" } }), deps)).status).toBe(400);
  });

  it("re-sending a signal refreshes it, and expired signals drop on the next sync", async () => {
    const s = newStudent();
    await handlePutContext(put(s, alexCtx), deps);
    // HW4 is due Oct 28 23:59 -07:00, so it expires a day later.
    nowMs = Date.parse("2026-10-30T08:00:00.000Z");
    const res = await body<ContextBody>(await handlePutContext(put(s, { policy: { participating: true }, signals: [] }), deps));
    expect(res.signals_total).toBe(2);
  });

  it("needs the same auth as the other endpoints", async () => {
    const res = await handlePutContext(new Request(`${BASE}/api/context`, { method: "PUT", body: "{}" }), deps);
    expect(res.status).toBe(400);
  });
});

describe("model judge (mocked)", () => {
  function mockJudge(reply: (req: JudgeRequest) => Judgment | null): Judge & { calls: JudgeRequest[] } {
    const calls: JudgeRequest[] = [];
    return {
      name: "mock",
      calls,
      async judge(req) {
        calls.push(req);
        return reply(req);
      },
    };
  }

  const goodText = "Someone in your CSE 310 class is on HW4 too. Want me to see if you'd both like to connect?";

  it("uses the model's text when it passes the guard, and stores why and score", async () => {
    const judge = mockJudge(() => ({ worth: 0.85, why: "Same course and assignment due soon.", text_for_a: goodText, text_for_b: goodText }));
    deps.judge = judge;
    const { alex, id } = await pair();
    expect(judge.calls).toHaveLength(1);
    const sent = JSON.stringify(judge.calls[0]);
    expect(sent).not.toContain("Alex");
    expect(sent).not.toContain("Jordan");
    expect(sent).not.toContain("555");
    expect(sent).not.toContain("hash tables"); // details never go to the model
    const view = await body<SuggestionsBody>(await handleSuggestions(getSuggestions(alex), deps));
    expect(view.ask?.text).toBe(goodText);
    const stored = (await getSuggestion(store, id)) as Suggestion;
    expect(stored.judge).toBe("mock");
    expect(stored.texts_from).toBe("model");
    expect(stored.score).toBe(0.85);
    expect(stored.why).toBe("Same course and assignment due soon.");
  });

  it("never sends the model an entity only one student has", async () => {
    const judge = mockJudge(() => null);
    deps.judge = judge;
    const a = newStudent();
    const b = newStudent();
    const extra = [{ type: "enrolled_in", entity: { kind: "course", label: "PSY 366 Abnormal Psychology" }, source: "canvas" }];
    await handlePutContext(put(a, alexCtx), deps);
    await handlePutContext(put(b, context("Jordan", "jordan@example.edu", jordanCtx.free, extra)), deps);
    expect(judge.calls).toHaveLength(1);
    expect(JSON.stringify(judge.calls[0])).not.toContain("PSY");
    expect(JSON.stringify(judge.calls[0])).toContain("CSE 310");
  });

  it("falls back to the rules text when the model text names someone or shares contacts, but keeps complementary reasons", async () => {
    const extra = [{ type: "enrolled_in", entity: { kind: "course", label: "CSE 340" }, source: "canvas" }];
    const run = async (text: string): Promise<{ text: string | undefined; from: string | undefined }> => {
      store = new InMemoryStore(() => nowMs);
      deps = { store, now: () => new Date(nowMs), judge: mockJudge(() => ({ worth: 0.9, why: "ok", text_for_a: text, text_for_b: goodText })) };
      const a = newStudent();
      const b = newStudent();
      await handlePutContext(put(a, alexCtx), deps);
      await handlePutContext(put(b, context("Jordan", "jordan@example.edu", jordanCtx.free, extra)), deps);
      const view = await body<SuggestionsBody>(await handleSuggestions(getSuggestions(b), deps));
      return { text: view.ask?.text, from: (await getSuggestion(store, view.ask?.id ?? ""))?.texts_from };
    };
    const bad = [
      "Jordan in your CSE 310 class wants to study. Want me to see if you'd both like to connect?",
      "Someone in CSE 310 is on HW4, text them at 480-555-0199. Want me to connect you?",
    ];
    for (const text of bad) {
      const result = await run(text);
      expect(result.text).toContain("Someone in your CSE 310 class is working on HW4 too");
      expect(result.from).toBe("rules");
    }
    // A label only one side has (CSE 340) is a complementary reason, not a guard failure.
    const complementary = "Someone in CSE 310 is also taking CSE 340. Want me to see if you'd both like to connect?";
    expect(await run(complementary)).toEqual({ text: complementary, from: "model" });
  });

  it("skips a pair the model scores below 0.6, and uses rules when the model gives nothing", async () => {
    deps.judge = mockJudge(() => ({ worth: 0.3, why: "weak", text_for_a: goodText, text_for_b: goodText }));
    const a = newStudent();
    const b = newStudent();
    await handlePutContext(put(a, alexCtx), deps);
    expect((await body<ContextBody>(await handlePutContext(put(b, jordanCtx), deps))).open_suggestion).toBe(false);

    // A low-worth pair is not sent to the model again for 6 hours, however often they sync.
    const again = mockJudge(() => ({ worth: 0.9, why: "ok", text_for_a: goodText, text_for_b: goodText }));
    deps.judge = again;
    expect((await body<ContextBody>(await handlePutContext(put(b, jordanCtx), deps))).open_suggestion).toBe(false);
    expect(again.calls).toHaveLength(0);

    nowMs += 7 * HOUR;
    deps.judge = mockJudge(() => null);
    expect((await body<ContextBody>(await handlePutContext(put(b, jordanCtx), deps))).open_suggestion).toBe(true);
    const view = await body<SuggestionsBody>(await handleSuggestions(getSuggestions(a), deps));
    expect((await getSuggestion(store, view.ask?.id ?? ""))?.judge).toBe("rules");
  });
});

describe("undated memory signals (synthetic adaptations with explicit activity approval)", () => {
  const memory = (type: string, kind: string, label: string) => ({ type, entity: { kind, label }, source: "memory" });
  const enrolled = (label: string) => ({ type: "enrolled_in", entity: { kind: "course", label }, source: "canvas" });
  const student = (firstName: string, signals: Array<Record<string, unknown>>) => ({
    policy: { participating: true, discoverable: "school", school: "ASU", first_name: firstName, share_events: true },
    signals: [...signals, memory("open_to", "activity", "study")],
    tz: "America/Phoenix",
  });
  const studentA = student("Ana", [
    memory("attending", "event", "Cubbie Hackathon"),
    memory("interested_in", "topic", "Voice AI and speech recognition"),
    memory("working_on", "topic", "AI project"),
  ]);
  const studentB = student("Ben", [
    ...["CSE 230", "CSE 240", "MAT 243", "SES 141", "UNI 220"].map(enrolled),
    memory("working_on", "topic", "AI project"),
  ]);
  const studentC = student("Cam", [
    memory("attending", "event", "Adobe University Hackathon"),
    ...["CIS 401", "CSE 110"].map(enrolled),
    memory("working_on", "assignment", "CSE 240 Project 1"),
  ]);

  function mockJudge(reply: (req: JudgeRequest) => Judgment | null): Judge & { calls: JudgeRequest[] } {
    const calls: JudgeRequest[] = [];
    return {
      name: "mock",
      calls,
      async judge(req) {
        calls.push(req);
        return reply(req);
      },
    };
  }

  it("A and B share an undated working_on and get a suggestion", async () => {
    const text = "Someone at ASU is working on an AI project too. Want me to see if you'd both like to connect?";
    const judge = mockJudge(() => ({ worth: 0.7, why: "Both on an AI project.", text_for_a: text, text_for_b: text }));
    deps.judge = judge;
    const a = newStudent();
    const b = newStudent();
    await handlePutContext(put(a, studentA), deps);
    expect((await body<ContextBody>(await handlePutContext(put(b, studentB), deps))).open_suggestion).toBe(true);
    expect(judge.calls).toHaveLength(1);
    const req = judge.calls[0];
    expect(req?.shared).toEqual(["open_to:study", "working_on:ai project"]);
    expect(req?.prefilter).toBe(0.65);
    expect(req?.a).toContainEqual({ type: "working_on", kind: "topic", label: "AI project" });
    expect(req?.b).toContainEqual({ type: "working_on", kind: "topic", label: "AI project" });
    const view = await body<SuggestionsBody>(await handleSuggestions(getSuggestions(a), deps));
    expect(view.ask?.text).toBe(text);
    expect((await getSuggestion(store, view.ask?.id ?? ""))?.texts_from).toBe("model");
  });

  it("B is enrolled in CSE 240 and C works on CSE 240 Project 1: the suggestion names the course", async () => {
    const textB = "Someone working on something for CSE 240 is on Super Cub too. Want me to see if you'd both like to connect?";
    const textC = "Someone taking CSE 240 is on Super Cub too. Want me to see if you'd both like to connect?";
    const judge = mockJudge((req) => ({
      worth: 0.7,
      why: "Same course.",
      text_for_a: req.a.some((s) => s.type === "enrolled_in") ? textB : textC,
      text_for_b: req.b.some((s) => s.type === "enrolled_in") ? textB : textC,
    }));
    deps.judge = judge;
    const b = newStudent();
    const c = newStudent();
    await handlePutContext(put(b, studentB), deps);
    expect((await body<ContextBody>(await handlePutContext(put(c, studentC), deps))).open_suggestion).toBe(true);
    expect(judge.calls).toHaveLength(1);
    const req = judge.calls[0];
    expect(req?.shared).toEqual(["enrolled_in:cse240", "open_to:study"]);
    expect(req?.prefilter).toBe(0.75);
    // C discovered B: C is side a. Both sides see the course, never the assignment title or other courses.
    expect(req?.a).toContainEqual({ type: "working_on", kind: "course", label: "CSE 240" });
    expect(req?.b).toContainEqual({ type: "enrolled_in", kind: "course", label: "CSE 240" });
    expect(JSON.stringify(req)).not.toContain("Project 1");
    expect(JSON.stringify(req)).not.toContain("CSE 230");

    const viewB = await body<SuggestionsBody>(await handleSuggestions(getSuggestions(b), deps));
    const viewC = await body<SuggestionsBody>(await handleSuggestions(getSuggestions(c), deps));
    expect(viewB.ask?.text).toBe(textB);
    expect(viewC.ask?.text).toBe(textC);
    const stored = await getSuggestion(store, viewB.ask?.id ?? "");
    expect(stored?.texts_from).toBe("model");
    expect(stored?.kind).toBe("study");
    expect(stored?.shared).toEqual(["enrolled_in:cse240", "open_to:study"]);
  });

  it("B and C without the judge get rules text naming CSE 240", async () => {
    const b = newStudent();
    const c = newStudent();
    await handlePutContext(put(b, studentB), deps);
    expect((await body<ContextBody>(await handlePutContext(put(c, studentC), deps))).open_suggestion).toBe(true);
    const viewB = await body<SuggestionsBody>(await handleSuggestions(getSuggestions(b), deps));
    const viewC = await body<SuggestionsBody>(await handleSuggestions(getSuggestions(c), deps));
    expect(viewB.ask?.text).toBe("Someone working on something for CSE 240 is open to studying with classmates. Want me to see if you'd both like to connect?");
    expect(viewC.ask?.text).toBe("Someone taking CSE 240 is open to studying with classmates. Want me to see if you'd both like to connect?");
  });

  it("the guard allows model text naming one side's assignment title, since complementary reasons are allowed", async () => {
    const text = "Someone is also doing CSE 240 Project 1. Want me to see if you'd both like to connect?";
    deps.judge = mockJudge(() => ({ worth: 0.7, why: "Same course.", text_for_a: text, text_for_b: text }));
    const b = newStudent();
    const c = newStudent();
    await handlePutContext(put(b, studentB), deps);
    await handlePutContext(put(c, studentC), deps);
    const view = await body<SuggestionsBody>(await handleSuggestions(getSuggestions(c), deps));
    expect(view.ask?.text).toBe(text);
    expect((await getSuggestion(store, view.ask?.id ?? ""))?.texts_from).toBe("model");
  });

  it("with a model judge, two students sharing only a school are judged; without one they get nothing", async () => {
    const judge = mockJudge(() => ({ worth: 1, why: "x", text_for_a: "Someone at ASU. Want to connect?", text_for_b: "Someone at ASU. Want to connect?" }));
    deps.judge = judge;
    const a = newStudent();
    const c = newStudent();
    await handlePutContext(put(a, studentA), deps);
    expect((await body<ContextBody>(await handlePutContext(put(c, studentC), deps))).open_suggestion).toBe(true);
    expect(judge.calls).toHaveLength(1);

    // The rules-only fallback still needs shared activity and keys above the prefilter.
    store = new InMemoryStore(() => nowMs);
    deps = { store, now: () => new Date(nowMs) };
    const a2 = newStudent();
    const c2 = newStudent();
    await handlePutContext(put(a2, studentA), deps);
    expect((await body<ContextBody>(await handlePutContext(put(c2, studentC), deps))).open_suggestion).toBe(false);
  });
});

describe("POST /api/discover", () => {
  const discover = (secret?: string): Request =>
    new Request(`${BASE}/api/discover`, {
      method: "POST",
      headers: secret === undefined ? {} : { "X-Discover-Secret": secret },
    });

  it("is off without a configured secret and refuses a wrong one", async () => {
    expect((await handleDiscover(discover("x"), deps)).status).toBe(503);
    deps.discoverSecret = "s3cret-value";
    expect((await handleDiscover(discover("wrong"), deps)).status).toBe(401);
    expect((await handleDiscover(discover(), deps)).status).toBe(401);
  });

  it("runs discovery for everyone", async () => {
    deps.discoverSecret = "s3cret-value";
    const a = newStudent();
    const b = newStudent();
    // Store both contexts with discovery finding nothing (b is at another school at first).
    await handlePutContext(put(a, alexCtx), deps);
    await handlePutContext(put(b, { ...jordanCtx, policy: { ...jordanCtx.policy, school: "UCLA" } }), deps);
    await store.set(`ctx:${b.id}`, ((await store.get(`ctx:${b.id}`)) ?? "").replace('"school":"UCLA"', '"school":"ASU"'));
    const res = await body<{ students: number; created: number }>(await handleDiscover(discover("s3cret-value"), deps));
    expect(res).toEqual({ students: 2, created: 1 });
  });
});
