import { randomBytes, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { handleJoin, handleLeave, handleMatches, handleRespond } from "../src/handlers.js";
import type { Deps } from "../src/handlers.js";
import type { MatchView, RequestView } from "../src/service.js";
import { InMemoryStore } from "../src/store.js";

const BASE = "https://campus-connect.test";

interface Student {
  id: string;
  token: string;
}

function newStudent(): Student {
  return { id: randomUUID(), token: randomBytes(32).toString("base64url") };
}

function headers(s: Student): Record<string, string> {
  return {
    "X-Student-Id": s.id,
    Authorization: `Bearer ${s.token}`,
    "Content-Type": "application/json",
  };
}

const post = (path: string, s: Student, body: unknown): Request =>
  new Request(`${BASE}${path}`, { method: "POST", headers: headers(s), body: JSON.stringify(body) });

const get = (path: string, s: Student): Request =>
  new Request(`${BASE}${path}`, { method: "GET", headers: headers(s) });

const del = (path: string, s: Student): Request =>
  new Request(`${BASE}${path}`, { method: "DELETE", headers: headers(s) });

interface JoinBody {
  request: RequestView;
  match: MatchView | null;
  updated: boolean;
}
interface MatchesBody {
  requests: RequestView[];
  matches: MatchView[];
}
interface RespondBody {
  match: MatchView;
}
interface ErrorBody {
  error: string;
  status?: string;
}

async function body<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

let nowMs = Date.parse("2026-10-24T16:00:00.000Z");
let store: InMemoryStore;
let deps: Deps;

beforeEach(() => {
  nowMs = Date.parse("2026-10-24T16:00:00.000Z");
  store = new InMemoryStore(() => nowMs);
  deps = { store, now: () => new Date(nowMs) };
});

const alexJoin = {
  first_name: "Alex",
  contact: "+1 480 555 0101",
  kind: "study",
  group: "cse 310",
  topic: "hash tables",
  can_help: ["recursion"],
  free: [{ start: "2026-10-24T11:00:00-07:00", end: "2026-10-24T14:00:00-07:00" }],
};

const jordanJoin = {
  first_name: "Jordan",
  contact: "jordan@example.edu",
  kind: "study",
  group: "CSE310",
  topic: "Hash table collisions",
  can_help: ["hash functions"],
  free: [{ start: "2026-10-24T19:00:00Z", end: "2026-10-24T22:00:00Z" }],
};

describe("two-student flow", () => {
  it("joins, proposes, hides contact until both accept, then leave deletes everything", async () => {
    const alex = newStudent();
    const jordan = newStudent();

    // Alex joins first: nobody to match yet.
    let res = await handleJoin(post("/api/requests", alex, alexJoin), deps);
    expect(res.status).toBe(200);
    const first = await body<JoinBody>(res);
    expect(first.match).toBeNull();
    expect(first.request.status).toBe("open");

    // Jordan joins the same course written differently: a match is proposed.
    res = await handleJoin(post("/api/requests", jordan, jordanJoin), deps);
    expect(res.status).toBe(200);
    const second = await body<JoinBody>(res);
    expect(second.match).not.toBeNull();
    expect(second.request.status).toBe("matched");
    const matchId = second.match?.id ?? "";
    // Overlap is 19:00-21:00 UTC, so the meeting is the first hour of it.
    expect(second.match?.time).toEqual({ start: "2026-10-24T19:00:00.000Z", end: "2026-10-24T20:00:00.000Z" });

    // Both see the proposal, neither sees a contact.
    for (const [s, other] of [[alex, "Jordan"], [jordan, "Alex"]] as const) {
      const view = await body<MatchesBody>(await handleMatches(get("/api/matches", s), deps));
      expect(view.matches).toHaveLength(1);
      const m = view.matches[0];
      expect(m?.id).toBe(matchId);
      expect(m?.status).toBe("needs_your_answer");
      expect(m?.other.first_name).toBe(other);
      expect(m?.other.contact).toBeUndefined();
      expect(m?.reason).toContain("You're both free Sat Oct 24, ");
      expect(m?.reason).toContain(other);
      expect(m?.shared_words).toEqual(["hash"]);
    }

    // Alex accepts: still no contact, now waiting on Jordan.
    res = await handleRespond(post("/api/respond", alex, { match_id: matchId, accept: true }), deps);
    expect(res.status).toBe(200);
    const afterAlex = await body<RespondBody>(res);
    expect(afterAlex.match.status).toBe("waiting_for_other");
    expect(afterAlex.match.other.contact).toBeUndefined();

    // Jordan accepts: both now see each other's contact.
    res = await handleRespond(post("/api/respond", jordan, { match_id: matchId, accept: true }), deps);
    const afterJordan = await body<RespondBody>(res);
    expect(afterJordan.match.status).toBe("confirmed");
    expect(afterJordan.match.other.contact).toBe("+1 480 555 0101");

    const alexView = await body<MatchesBody>(await handleMatches(get("/api/matches", alex), deps));
    expect(alexView.matches[0]?.status).toBe("confirmed");
    expect(alexView.matches[0]?.other.contact).toBe("jordan@example.edu");
    expect(alexView.matches[0]?.other).not.toHaveProperty("due");

    // Responding again to a confirmed match is refused.
    res = await handleRespond(post("/api/respond", alex, { match_id: matchId, accept: false }), deps);
    expect(res.status).toBe(409);

    // Alex leaves: nothing about Alex remains, and Jordan no longer sees the match.
    res = await handleLeave(del("/api/me", alex), deps);
    expect(res.status).toBe(200);
    const leftovers = store.keys().filter((key) => key.includes(alex.id));
    expect(leftovers).toEqual([]);
    for (const key of store.keys()) {
      const raw = await store.get(key);
      if (raw !== null) expect(raw).not.toContain("Alex");
      expect((await store.smembers(key)).includes(alex.id)).toBe(false);
    }
    const jordanView = await body<MatchesBody>(await handleMatches(get("/api/matches", jordan), deps));
    expect(jordanView.matches).toEqual([]);
  });

  it("declining frees both students, and they are not proposed to each other again", async () => {
    const a = newStudent();
    const b = newStudent();
    const c = newStudent();
    await handleJoin(post("/api/requests", a, alexJoin), deps);
    const joined = await body<JoinBody>(await handleJoin(post("/api/requests", b, jordanJoin), deps));
    const matchId = joined.match?.id ?? "";

    const res = await handleRespond(post("/api/respond", b, { match_id: matchId, accept: false }), deps);
    expect((await body<RespondBody>(res)).match.status).toBe("declined");

    // A still sees the declined match, and no new match with B.
    let view = await body<MatchesBody>(await handleMatches(get("/api/matches", a), deps));
    expect(view.matches.map((m) => m.status)).toEqual(["declined"]);
    expect(view.requests[0]?.status).toBe("open");

    // Joining again from either side does not bring them back together.
    expect((await body<JoinBody>(await handleJoin(post("/api/requests", a, alexJoin), deps))).match).toBeNull();
    expect((await body<JoinBody>(await handleJoin(post("/api/requests", b, jordanJoin), deps))).match).toBeNull();

    // A third student joins and gets matched with whoever fits.
    await handleJoin(post("/api/requests", c, { ...jordanJoin, first_name: "Casey", contact: "casey@example.edu" }), deps);
    view = await body<MatchesBody>(await handleMatches(get("/api/matches", c), deps));
    expect(view.matches).toHaveLength(1);
    expect(view.matches[0]?.status).toBe("needs_your_answer");
  });

  it("does not propose classmates with nothing in common", async () => {
    const a = newStudent();
    const b = newStudent();
    await handleJoin(post("/api/requests", a, alexJoin), deps);
    const res = await handleJoin(
      post("/api/requests", b, { ...jordanJoin, topic: "sorting algorithms", can_help: ["graphs"] }),
      deps,
    );
    const joined = await body<JoinBody>(res);
    expect(joined.match).toBeNull();
    expect(joined.request.status).toBe("open");
  });

  it("a pending match expires once its meeting time starts, and the pair can be proposed again", async () => {
    const a = newStudent();
    const b = newStudent();
    const tomorrow = { start: "2026-10-25T19:00:00Z", end: "2026-10-25T21:00:00Z" };
    await handleJoin(post("/api/requests", a, { ...alexJoin, free: [...alexJoin.free, tomorrow] }), deps);
    const joined = await body<JoinBody>(
      await handleJoin(post("/api/requests", b, { ...jordanJoin, free: [...jordanJoin.free, tomorrow] }), deps),
    );
    const firstId = joined.match?.id ?? "";
    // Past today's overlap, so the next shared hour is tomorrow.
    nowMs = Date.parse("2026-10-24T20:30:00.000Z");
    const view = await body<MatchesBody>(await handleMatches(get("/api/matches", a), deps));
    expect(view.matches[0]?.id).toBe(firstId);
    expect(view.matches[0]?.status).toBe("expired");
    // Nobody said no, so the same two students get a fresh proposal at a later time.
    expect(view.matches).toHaveLength(2);
    expect(view.matches[1]?.id).not.toBe(firstId);
    expect(view.matches[1]?.status).toBe("needs_your_answer");
    expect(view.matches[1]?.other.first_name).toBe("Jordan");
    expect(view.matches[1]?.time).toEqual({ start: "2026-10-25T19:00:00.000Z", end: "2026-10-25T20:00:00.000Z" });
  });

  it("two students free right now get a pending proposal about 30 minutes out", async () => {
    nowMs = Date.parse("2026-10-24T16:07:00.000Z");
    const free = [{ start: "2026-10-24T16:07:00Z", end: "2026-10-24T19:07:00Z" }];
    const a = newStudent();
    const b = newStudent();
    await handleJoin(post("/api/requests", a, { ...alexJoin, free }), deps);
    const joined = await body<JoinBody>(await handleJoin(post("/api/requests", b, { ...jordanJoin, free }), deps));
    expect(joined.match?.status).toBe("needs_your_answer");
    // 16:07 plus 30 minutes is 16:37, rounded up to 16:45.
    expect(joined.match?.time).toEqual({ start: "2026-10-24T16:45:00.000Z", end: "2026-10-24T17:45:00.000Z" });
    const view = await body<MatchesBody>(await handleMatches(get("/api/matches", a), deps));
    expect(view.matches.map((m) => m.status)).toEqual(["needs_your_answer"]);
  });

  it("a match cancelled because a student left does not block a later proposal", async () => {
    const a = newStudent();
    const b = newStudent();
    await handleJoin(post("/api/requests", a, alexJoin), deps);
    const joined = await body<JoinBody>(await handleJoin(post("/api/requests", b, jordanJoin), deps));
    expect(joined.match).not.toBeNull();

    expect((await handleLeave(del("/api/me", b), deps)).status).toBe(200);
    expect((await body<MatchesBody>(await handleMatches(get("/api/matches", a), deps))).matches).toEqual([]);

    // The same student joins again later and is proposed to A again.
    const again = await body<JoinBody>(await handleJoin(post("/api/requests", b, jordanJoin), deps));
    expect(again.match?.status).toBe("needs_your_answer");
    expect(again.match?.other.first_name).toBe("Alex");
  });

  it("ignores a due date sent by an older client and never shares it", async () => {
    const a = newStudent();
    const b = newStudent();
    const res = await handleJoin(post("/api/requests", a, { ...alexJoin, due: "HW3 due Oct 28" }), deps);
    expect(res.status).toBe(200);
    const joined = await body<JoinBody>(await handleJoin(post("/api/requests", b, jordanJoin), deps));
    expect(joined.match?.other).not.toHaveProperty("due");
    for (const key of store.keys()) {
      const raw = await store.get(key);
      if (raw !== null) expect(raw).not.toContain("HW3");
    }
  });

  it("reports a request as expired after its last free window", async () => {
    const a = newStudent();
    await handleJoin(post("/api/requests", a, alexJoin), deps);
    nowMs = Date.parse("2026-10-24T22:00:00.000Z");
    const view = await body<MatchesBody>(await handleMatches(get("/api/matches", a), deps));
    expect(view.requests[0]?.status).toBe("expired");
  });

  it("answering an expired match says it is expired", async () => {
    const a = newStudent();
    const b = newStudent();
    await handleJoin(post("/api/requests", a, alexJoin), deps);
    const joined = await body<JoinBody>(await handleJoin(post("/api/requests", b, jordanJoin), deps));
    nowMs = Date.parse("2026-10-24T19:30:00.000Z"); // the proposed 19:00 start has passed
    const res = await handleRespond(post("/api/respond", a, { match_id: joined.match?.id, accept: true }), deps);
    expect(res.status).toBe(409);
    expect(await body<ErrorBody>(res)).toEqual({ error: "This match is already expired.", status: "expired" });
  });
});

describe("kinds and groups", () => {
  const rideFrom = (campus: string, destination: string, free: Array<{ start: string; end: string }>) => ({
    ...alexJoin,
    kind: "ride",
    group: campus,
    topic: destination,
    can_help: [],
    free,
  });

  it("matches two rides from the same campus to the same place with 30 minutes of overlap", async () => {
    const a = newStudent();
    const b = newStudent();
    await handleJoin(post("/api/requests", a, rideFrom("ASU Tempe", "PHX airport", [{ start: "2026-10-24T18:00:00Z", end: "2026-10-24T18:45:00Z" }])), deps);
    const res = await handleJoin(
      post("/api/requests", b, rideFrom("Arizona State University Tempe campus", "phx airport", [{ start: "2026-10-24T18:15:00Z", end: "2026-10-24T20:00:00Z" }])),
      deps,
    );
    const joined = await body<JoinBody>(res);
    expect(joined.match?.kind).toBe("ride");
    expect(joined.match?.group).toBe("Arizona State University Tempe campus");
    expect(joined.match?.other.topic).toBe("PHX airport");
    expect(joined.match?.time).toEqual({ start: "2026-10-24T18:15:00.000Z", end: "2026-10-24T18:45:00.000Z" });
    expect(joined.request).toMatchObject({ kind: "ride", status: "matched" });
  });

  it("keeps kinds apart and keeps campuses apart", async () => {
    const a = newStudent();
    const b = newStudent();
    const c = newStudent();
    const free = [{ start: "2026-10-24T18:00:00Z", end: "2026-10-24T20:00:00Z" }];
    await handleJoin(post("/api/requests", a, { ...alexJoin, kind: "buddy", group: "ASU Tempe", topic: "gym", free }), deps);
    const otherKind = await body<JoinBody>(
      await handleJoin(post("/api/requests", b, { ...alexJoin, kind: "project", group: "ASU Tempe", topic: "gym", free }), deps),
    );
    expect(otherKind.match).toBeNull();
    const otherCampus = await body<JoinBody>(
      await handleJoin(post("/api/requests", c, { ...alexJoin, kind: "buddy", group: "ASU Polytechnic", topic: "gym", free }), deps),
    );
    expect(otherCampus.match).toBeNull();
  });

  it("matches hackathon teammates from different schools by event name", async () => {
    const a = newStudent();
    const b = newStudent();
    const free = [{ start: "2026-10-24T18:00:00Z", end: "2026-10-24T20:00:00Z" }];
    const teammate = { ...alexJoin, kind: "project", group_type: "event", free };
    await handleJoin(post("/api/requests", a, { ...teammate, group: "Cubbie Hackathon", topic: "need a designer", can_help: ["backend"] }), deps);
    const joined = await body<JoinBody>(
      await handleJoin(post("/api/requests", b, { ...teammate, group: "cubbie hackathon 2026", topic: "need backend", can_help: ["design"] }), deps),
    );
    expect(joined.match).toMatchObject({ kind: "project", group_type: "event", group: "cubbie hackathon 2026" });
    expect(joined.request.group_type).toBe("event");
  });

  it("tells each side why, and flags the side whose offer covers the other's need", async () => {
    const helper = newStudent();
    const asker = newStudent();
    const free = [{ start: "2026-10-24T18:00:00-07:00", end: "2026-10-24T20:00:00-07:00" }];
    await handleJoin(post("/api/requests", helper, { ...alexJoin, first_name: "Maya", topic: "graphs", can_help: ["hash tables"], free }), deps);
    const joined = await body<JoinBody>(
      await handleJoin(post("/api/requests", asker, { ...jordanJoin, topic: "hash tables", can_help: [], free }), deps),
    );
    expect(joined.match?.reason).toBe("You're both free Sat Oct 24, 6 to 8 pm. Maya can help with hash tables.");
    expect(joined.match?.you_can_help).toBe(false);
    const helperView = await body<MatchesBody>(await handleMatches(get("/api/matches", helper), deps));
    expect(helperView.matches[0]?.reason).toBe("You're both free Sat Oct 24, 6 to 8 pm. Jordan needs hash tables, which you offer.");
    expect(helperView.matches[0]?.you_can_help).toBe(true);
  });

  it("matches two students who want food at the same time on the same campus", async () => {
    const a = newStudent();
    const b = newStudent();
    const free = [{ start: "2026-10-24T18:00:00Z", end: "2026-10-24T20:00:00Z" }];
    const meal = { ...alexJoin, kind: "food", group: "ASU Tempe", can_help: [], free };
    await handleJoin(post("/api/requests", a, { ...meal, topic: "tacos" }), deps);
    const joined = await body<JoinBody>(await handleJoin(post("/api/requests", b, { ...meal, topic: "anything" }), deps));
    expect(joined.match).toMatchObject({ kind: "food", group_type: "campus" });
  });

  it("joining twice in the same pool updates the one request instead of adding another", async () => {
    const a = newStudent();
    const first = await body<JoinBody>(await handleJoin(post("/api/requests", a, alexJoin), deps));
    expect(first.updated).toBe(false);
    const second = await body<JoinBody>(
      await handleJoin(post("/api/requests", a, { ...alexJoin, group: "CSE-310", topic: "heaps" }), deps),
    );
    expect(second.updated).toBe(true);
    const view = await body<MatchesBody>(await handleMatches(get("/api/matches", a), deps));
    expect(view.requests).toEqual([expect.objectContaining({ group: "CSE-310", topic: "heaps" })]);
    expect(await store.smembers("pool:study:course:CSE310")).toEqual([a.id]);
    expect(store.keys().filter((key) => key.startsWith(`req:${a.id}`))).toEqual([`req:${a.id}:study:course:CSE310`]);
  });

  it("a student who left can join again with a fresh identity and be matched", async () => {
    const a = newStudent();
    const b = newStudent();
    await handleJoin(post("/api/requests", a, alexJoin), deps);
    await handleLeave(del("/api/me", a), deps);
    const fresh = newStudent();
    const rejoined = await body<JoinBody>(await handleJoin(post("/api/requests", fresh, alexJoin), deps));
    expect(rejoined.updated).toBe(false);
    const joined = await body<JoinBody>(await handleJoin(post("/api/requests", b, jordanJoin), deps));
    expect(joined.match?.other.first_name).toBe("Alex");
    expect(store.keys().filter((key) => key.includes(a.id))).toEqual([]);
  });
});

describe("auth", () => {
  it("trusts the first token and rejects a different one later", async () => {
    const s = newStudent();
    expect((await handleMatches(get("/api/matches", s), deps)).status).toBe(200);
    const impostor = { id: s.id, token: randomBytes(32).toString("base64url") };
    const res = await handleMatches(get("/api/matches", impostor), deps);
    expect(res.status).toBe(401);
  });

  it("keeps an identity bound to its original token after years of inactivity", async () => {
    const s = newStudent();
    expect((await handleMatches(get("/api/matches", s), deps)).status).toBe(200);
    expect(await store.get(`auth:${s.id}`)).not.toBeNull();
    nowMs += 3 * 365 * 24 * 3600 * 1000;
    expect(await store.get(`auth:${s.id}`)).not.toBeNull();
    expect((await handleMatches(get("/api/matches", { ...s, token: randomBytes(32).toString("base64url") }), deps)).status).toBe(401);
    expect((await handleMatches(get("/api/matches", s), deps)).status).toBe(200);
  });

  it("requires a student id and a token", async () => {
    const res = await handleMatches(new Request(`${BASE}/api/matches`), deps);
    expect(res.status).toBe(400);
    const noToken = new Request(`${BASE}/api/matches`, { headers: { "X-Student-Id": randomUUID() } });
    expect((await handleMatches(noToken, deps)).status).toBe(401);
  });

  it("cannot answer someone else's match", async () => {
    const a = newStudent();
    const b = newStudent();
    await handleJoin(post("/api/requests", a, alexJoin), deps);
    const joined = await body<JoinBody>(await handleJoin(post("/api/requests", b, jordanJoin), deps));
    const res = await handleRespond(
      post("/api/respond", newStudent(), { match_id: joined.match?.id, accept: true }),
      deps,
    );
    expect(res.status).toBe(404);
  });
});

describe("validation", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["missing name", { ...alexJoin, first_name: "" }, "first_name"],
    ["bad contact", { ...alexJoin, contact: "call me" }, "contact"],
    ["long topic", { ...alexJoin, topic: "x".repeat(201) }, "topic"],
    ["no time zone", { ...alexJoin, free: [{ start: "2026-10-24T18:00", end: "2026-10-24T20:00" }] }, "time zone"],
    ["end before start", { ...alexJoin, free: [{ start: "2026-10-24T20:00:00Z", end: "2026-10-24T18:00:00Z" }] }, "end after"],
    ["past only", { ...alexJoin, free: [{ start: "2026-10-23T18:00:00Z", end: "2026-10-23T20:00:00Z" }] }, "past"],
    [
      "too many windows",
      { ...alexJoin, free: Array.from({ length: 11 }, () => ({ start: "2026-10-24T18:00:00Z", end: "2026-10-24T20:00:00Z" })) },
      "at most 10",
    ],
    ["can_help not a list", { ...alexJoin, can_help: "recursion" }, "can_help"],
    ["missing kind", { ...alexJoin, kind: undefined }, "kind must be one of: study, project, ride, buddy, food"],
    ["campus for study", { ...alexJoin, group_type: "campus" }, "group_type for study must be course or event"],
    ["course for a ride", { ...alexJoin, kind: "ride", group_type: "course" }, "group_type for ride must be campus or event"],
    ["unknown kind", { ...alexJoin, kind: "carpool" }, "kind must be one of"],
    ["missing group", { ...alexJoin, group: undefined }, "group must be the course"],
    ["punctuation-only campus", { ...alexJoin, kind: "ride", group: "--" }, "group must be the campus"],
  ];

  for (const [name, payload, fragment] of cases) {
    it(`rejects ${name}`, async () => {
      const res = await handleJoin(post("/api/requests", newStudent(), payload), deps);
      expect(res.status).toBe(400);
      expect((await body<ErrorBody>(res)).error).toContain(fragment);
    });
  }

  it("rejects invalid JSON", async () => {
    const s = newStudent();
    const req = new Request(`${BASE}/api/requests`, { method: "POST", headers: headers(s), body: "{nope" });
    expect((await handleJoin(req, deps)).status).toBe(400);
  });

  it("rejects a bad respond body", async () => {
    const res = await handleRespond(post("/api/respond", newStudent(), { match_id: "x", accept: "yes" }), deps);
    expect(res.status).toBe(400);
  });
});
