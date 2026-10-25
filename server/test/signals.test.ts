import { describe, expect, it } from "vitest";
import { guardText, prefilterScore, rulesText } from "../src/discovery.js";
import type { StudentContext } from "../src/discovery.js";
import { anthropicJudge, judgeFromEnv, messageText, parseJudgment, SYSTEM_PROMPT } from "../src/judge.js";
import { isoAtOffset } from "../src/loop.js";
import {
  DEFAULT_POLICY,
  hasContactInfo,
  normalizeEntityKey,
  parsePolicy,
  parseSignal,
  signalExpiry,
  stripContactInfo,
  zoneOffsetMinutes,
} from "../src/signals.js";
import type { Policy, Signal } from "../src/signals.js";

const NOW = new Date("2026-10-24T16:00:00.000Z");
const policy: Policy = { ...DEFAULT_POLICY, participating: true, first_name: "Alex", school: "ASU", share_events: true };

function sig(raw: Record<string, unknown>): Signal {
  const parsed = parseSignal(raw, policy, NOW);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function ctx(id: string, name: string, signals: Signal[], free: StudentContext["free"] = []): StudentContext {
  return { student_id: id, policy: { ...policy, first_name: name }, signals, free, updated_at: NOW.toISOString() };
}

const course = sig({ type: "enrolled_in", entity: { kind: "course", label: "CSE 310" }, source: "canvas" });
const hw4 = sig({
  type: "working_on",
  entity: { kind: "assignment", label: "HW4" },
  due: "2026-10-28T23:59:00-07:00",
  source: "canvas",
});
const study = sig({ type: "open_to", entity: { kind: "activity", label: "Study" }, source: "memory" });

describe("normalization", () => {
  it("course codes drop case, punctuation and spaces; other kinds keep words", () => {
    expect(normalizeEntityKey("course", "CSE 310")).toBe("cse310");
    expect(normalizeEntityKey("course", "cse-310")).toBe("cse310");
    expect(normalizeEntityKey("event", "Devils Invent:  Hackathon!")).toBe("devils invent hackathon");
    expect(normalizeEntityKey("topic", "Hash Tables")).toBe("hash tables");
    expect(normalizeEntityKey("topic", "Café")).toBe("cafe");
  });

  it("the server computes the key from the label, ignoring a client key", () => {
    const s = sig({ type: "enrolled_in", entity: { kind: "course", key: "whatever", label: "Cse310" }, source: "canvas" });
    expect(s.entity.key).toBe("cse310");
  });
});

describe("freshness", () => {
  it("follows the per-type rules", () => {
    const day = 24 * 3_600_000;
    const at = (type: Signal["type"], when?: string, due?: string) =>
      signalExpiry(type, NOW, when, due).getTime() - NOW.getTime();
    expect(at("working_on")).toBe(21 * day);
    expect(signalExpiry("working_on", NOW, undefined, "2026-10-28T00:00:00Z").toISOString()).toBe("2026-10-29T00:00:00.000Z");
    expect(at("attending")).toBe(30 * day);
    expect(signalExpiry("attending", NOW, "2026-11-01T00:00:00Z").toISOString()).toBe("2026-11-02T00:00:00.000Z");
    expect(at("interested_in")).toBe(60 * day);
    expect(at("can_help_with")).toBe(60 * day);
    expect(at("open_to")).toBe(60 * day);
    expect(at("enrolled_in")).toBe(120 * day);
    expect(at("applying_to")).toBe(45 * day);
  });
});

describe("contact stripping", () => {
  it("finds and strips emails and phone numbers but keeps section numbers", () => {
    expect(hasContactInfo("call 480-555-0101")).toBe(true);
    expect(hasContactInfo("+1 (480) 555 0101")).toBe(true);
    expect(hasContactInfo("me@asu.edu")).toBe(true);
    expect(hasContactInfo("section 12345")).toBe(false);
    expect(stripContactInfo("section 12345, mail me@asu.edu or 480.555.0101 please")).toBe("section 12345, mail or please");
  });
});

describe("policy", () => {
  it("applies defaults and merges over the stored policy", () => {
    const first = parsePolicy({ first_name: "Alex" }, null);
    expect(first).toEqual({ ok: true, value: { ...DEFAULT_POLICY, first_name: "Alex" } });
    const stored = first.ok ? first.value : null;
    const second = parsePolicy({ discoverable: "network" }, stored);
    expect(second.ok && second.value.discoverable).toBe("network");
    expect(second.ok && second.value.first_name).toBe("Alex");
    expect(parsePolicy({ first_name: "A", max_suggestions_per_week: 9 }, null).ok).toBe(false);
    expect(parsePolicy({ first_name: "A", discoverable: "everyone" }, null).ok).toBe(false);
  });
});

describe("restrictive sharing", () => {
  it("requires explicit participation and keeps fresh defaults narrow", () => {
    const parsed = parsePolicy(undefined, null);
    expect(parsed.ok && parsed.value).toMatchObject({ participating: false, discoverable: "school", intro: "ask", share_events: false, share_applications: false });
    expect(parsePolicy({ participating: true }, null).ok).toBe(false);
    expect(parsePolicy({ participating: true, first_name: "Alex" }, null).ok).toBe(true);
  });

  it("event and company permissions apply regardless of source or signal type", () => {
    const narrow = { ...policy, share_events: false, share_applications: false };
    for (const source of ["canvas", "calendar", "email", "memory", "student"]) {
      for (const type of ["attending", "working_on", "interested_in"]) {
        const result = parseSignal({ type, entity: { kind: "event", label: "Cubbie Hackathon" }, source }, narrow, NOW);
        expect(result).toEqual({ ok: false, error: "share_events is off" });
      }
      expect(parseSignal({ type: "interested_in", entity: { kind: "company", label: "Acme" }, source }, narrow, NOW)).toEqual({ ok: false, error: "share_applications is off" });
    }
  });

  it("accepts offers and activity approval only from student or memory sources", () => {
    for (const [type, kind, label] of [["can_help_with", "topic", "recursion"], ["open_to", "activity", "study"]]) {
      for (const source of ["canvas", "calendar", "email", undefined]) {
        expect(parseSignal({ type, entity: { kind, label }, source }, policy, NOW).ok).toBe(false);
      }
      for (const source of ["student", "memory"]) {
        expect(parseSignal({ type, entity: { kind, label }, source }, policy, NOW).ok).toBe(true);
      }
    }
  });
});

describe("prefilter score", () => {
  const freeA = [{ start: "2026-10-25T18:00:00.000Z", end: "2026-10-25T21:00:00.000Z" }];
  const freeB = [{ start: "2026-10-25T19:00:00.000Z", end: "2026-10-25T22:00:00.000Z" }];

  it("adds course, assignment due soon, open_to and free overlap", () => {
    expect(prefilterScore(ctx("a", "A", [course]), ctx("b", "B", [course]), NOW)).toBe(0.3);
    expect(prefilterScore(ctx("a", "A", [course, hw4]), ctx("b", "B", [course, hw4]), NOW)).toBe(0.9);
    expect(prefilterScore(ctx("a", "A", [course, hw4, study], freeA), ctx("b", "B", [course, hw4, study], freeB), NOW)).toBe(1);
  });

  it("an assignment due more than 7 days out still counts, without the due-soon bonus", () => {
    const later = sig({ type: "working_on", entity: { kind: "assignment", label: "HW4" }, due: "2026-11-10T00:00:00Z", source: "canvas" });
    expect(prefilterScore(ctx("a", "A", [course, later]), ctx("b", "B", [course, later]), NOW)).toBe(0.8);
  });

  it("counts an event within 14 days and can-help matches", () => {
    const fair = sig({ type: "attending", entity: { kind: "event", label: "Career Fair" }, when: "2026-10-30T10:00:00Z", source: "student" });
    const helps = sig({ type: "can_help_with", entity: { kind: "topic", label: "recursion" }, source: "memory" });
    const needs = sig({ type: "working_on", entity: { kind: "topic", label: "Recursion" }, source: "memory" });
    expect(prefilterScore(ctx("a", "A", [fair, helps]), ctx("b", "B", [fair, needs]), NOW)).toBe(1);
  });

  it("scores undated memory signals: working_on alone reaches the cutoff, events and interests add up", () => {
    const project = sig({ type: "working_on", entity: { kind: "topic", label: "AI project" }, source: "memory" });
    const hackathon = sig({ type: "attending", entity: { kind: "event", label: "Cubbie Hackathon" }, source: "memory" });
    const voice = sig({ type: "interested_in", entity: { kind: "topic", label: "Voice AI" }, source: "memory" });
    expect(prefilterScore(ctx("a", "A", [project]), ctx("b", "B", [project]), NOW)).toBe(0.5);
    expect(prefilterScore(ctx("a", "A", [hackathon]), ctx("b", "B", [hackathon]), NOW)).toBe(0.3);
    expect(prefilterScore(ctx("a", "A", [voice]), ctx("b", "B", [voice]), NOW)).toBe(0.2);
    expect(prefilterScore(ctx("a", "A", [hackathon, voice]), ctx("b", "B", [hackathon, voice]), NOW)).toBe(0.5);
  });

  it("links a course to the other student's assignment for it, by whole words or prefix", () => {
    const cse240 = sig({ type: "enrolled_in", entity: { kind: "course", label: "CSE 240" }, source: "canvas" });
    const work = (label: string, kind = "assignment") =>
      sig({ type: "working_on", entity: { kind, label }, source: "memory" });
    const score = (w: Signal) => prefilterScore(ctx("a", "A", [cse240]), ctx("b", "B", [w]), NOW);
    expect(score(work("CSE 240 Project 1"))).toBe(0.6);
    expect(score(work("Project 1 for CSE240"))).toBe(0.6);
    expect(score(work("CSE240 Project 1", "course"))).toBe(0.6);
    expect(score(work("CSE 2401 Project"))).toBe(0);
    expect(score(work("CSE 2401", "course"))).toBe(0);
    expect(score(work("CSE 310 Project 1"))).toBe(0);
  });
});

describe("rules text", () => {
  it("uses only entities both share, in the reader's own words", () => {
    const privateTopic = sig({ type: "interested_in", entity: { kind: "topic", label: "quantum poetry" }, source: "memory" });
    const text = rulesText(ctx("a", "Alex", [course, hw4, study]), ctx("b", "Jordan", [course, hw4, study, privateTopic]), NOW);
    expect(text).toBe(
      "Someone in your CSE 310 class is working on HW4 too and is open to studying with classmates. Want me to see if you'd both like to connect?",
    );
    expect(text).not.toContain("quantum");
  });
});

describe("guard on model text", () => {
  const extra = sig({ type: "enrolled_in", entity: { kind: "course", label: "MAT 343" }, source: "canvas" });
  const a = ctx("a", "Alex", [course, hw4]);
  const b = ctx("b", "Jordan", [course, hw4, extra]);

  it("accepts text about shared entities", () => {
    expect(guardText("  Someone in CSE 310 is on HW4 too.  Want to connect? ", a, b, NOW)).toBe(
      "Someone in CSE 310 is on HW4 too. Want to connect?",
    );
  });

  it("rejects names, contacts, links, markup and entities only one side has", () => {
    expect(guardText("Jordan is in CSE 310 too. Want to connect?", a, b, NOW)).toBeNull();
    expect(guardText("Someone in CSE 310, email j@asu.edu. Want to connect?", a, b, NOW)).toBeNull();
    expect(guardText("Someone in CSE 310, see https://x.y. Want to connect?", a, b, NOW)).toBeNull();
    expect(guardText("Someone in <b>CSE 310</b>. Want to connect?", a, b, NOW)).toBeNull();
    expect(guardText("Someone in CSE 310 also takes MAT343. Want to connect?", a, b, NOW)).toBeNull();
    expect(guardText("Someone in CSE 310 also takes mat 343. Want to connect?", a, b, NOW)).toBeNull();
    expect(guardText(42, a, b, NOW)).toBeNull();
  });
});

describe("judge adapter", () => {
  it("parses the model's JSON and rejects other shapes", () => {
    expect(parseJudgment('Sure: {"worth": 1.4, "why": "w", "text_for_a": "a", "text_for_b": "b"}')).toEqual({
      worth: 1,
      why: "w",
      text_for_a: "a",
      text_for_b: "b",
    });
    expect(parseJudgment('{"worth": "high"}')).toBeNull();
    expect(parseJudgment("no json here")).toBeNull();
    expect(messageText({ stop_reason: "refusal", content: [] })).toBeNull();
    expect(messageText({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "hi" }] })).toBe("hi");
  });

  it("calls the Messages API with the key, the model and the JSON-only prompt", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fakeFetch: typeof fetch = async (input, init) => {
      seen = { url: String(input), init: init ?? {} };
      const reply = { worth: 0.8, why: "w", text_for_a: "ta", text_for_b: "tb" };
      return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(reply) }] }));
    };
    const judge = anthropicJudge("test-key", "claude-opus-5-5", fakeFetch);
    const out = await judge.judge({ shared: ["enrolled_in:cse310"], a: [], b: [], prefilter: 0.6 });
    expect(out).toEqual({ worth: 0.8, why: "w", text_for_a: "ta", text_for_b: "tb" });
    const call = seen as { url: string; init: RequestInit } | null;
    expect(call?.url).toBe("https://api.anthropic.com/v1/messages");
    const sentHeaders = new Headers(call?.init.headers);
    expect(sentHeaders.get("x-api-key")).toBe("test-key");
    expect(sentHeaders.get("anthropic-version")).toBe("2023-06-01");
    const sent = JSON.parse(String(call?.init.body)) as { model: string; system: string };
    expect(sent.model).toBe("claude-opus-5-5");
    expect(sent.system).toBe(SYSTEM_PROMPT);
    expect(SYSTEM_PROMPT).toContain('"worth"');
    expect(SYSTEM_PROMPT).toContain("Never include a name");
  });

  it("returns null when the API fails", async () => {
    const failing: typeof fetch = async () => new Response("{}", { status: 529 });
    expect(await anthropicJudge("k", "m", failing).judge({ shared: [], a: [], b: [], prefilter: 0 })).toBeNull();
  });

  it("picks the backend from env", () => {
    expect(judgeFromEnv({})).toBeNull();
    expect(judgeFromEnv({ ANTHROPIC_API_KEY: "k", AWS_ACCESS_KEY_ID: "a" })?.name).toBe("anthropic");
    expect(judgeFromEnv({ AWS_ACCESS_KEY_ID: "a" })?.name).toBe("bedrock");
  });
});

describe("time helpers", () => {
  it("writes instants at a zone's offset", () => {
    expect(zoneOffsetMinutes("America/Phoenix", NOW)).toBe(-420);
    expect(zoneOffsetMinutes("UTC", NOW)).toBe(0);
    expect(isoAtOffset("2026-10-26T02:00:00.000Z", -420)).toBe("2026-10-25T19:00:00-07:00");
    expect(isoAtOffset("2026-10-26T02:00:00.000Z", 330)).toBe("2026-10-26T07:30:00+05:30");
  });
});
