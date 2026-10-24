// Runs the real Python client (supercub/scripts/connect.py) against these handlers,
// served from an in-process HTTP server that exists only for the length of this test.

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  handleAnswer,
  handleJoin,
  handleLeave,
  handleMatches,
  handlePutContext,
  handleRespond,
  handleSuggestions,
} from "../src/handlers.js";
import type { Deps } from "../src/handlers.js";
import { InMemoryStore } from "../src/store.js";

const SCRIPT = resolve(import.meta.dirname, "../../supercub/scripts/connect.py");
const CONTEXT_EXAMPLE = resolve(import.meta.dirname, "../../supercub/assets/context-example.json");
const NOW = Date.parse("2026-10-24T16:00:00.000Z");

const store = new InMemoryStore(() => NOW);
const deps: Deps = { store, now: () => new Date(NOW) };

const routes: Record<string, (request: Request, deps: Deps) => Promise<Response>> = {
  "POST /api/requests": handleJoin,
  "GET /api/matches": handleMatches,
  "POST /api/respond": handleRespond,
  "DELETE /api/me": handleLeave,
  "PUT /api/context": handlePutContext,
  "GET /api/suggestions": handleSuggestions,
};

/** Routes with a path parameter, matched after the exact routes. */
const patternRoutes: Array<[string, RegExp, (request: Request, deps: Deps) => Promise<Response>]> = [
  ["POST", /^\/api\/suggestions\/[^/]+\/answer$/, handleAnswer],
];

async function bridge(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
  }
  const method = req.method ?? "GET";
  const request = new Request(`http://localhost${req.url ?? "/"}`, {
    method,
    headers,
    ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
  });
  const pathname = new URL(request.url).pathname;
  const handler =
    routes[`${method} ${pathname}`] ??
    patternRoutes.find(([m, re]) => m === method && re.test(pathname))?.[2];
  const response = handler ? await handler(request, deps) : new Response("{}", { status: 404 });
  res.writeHead(response.status, { "Content-Type": "application/json" });
  res.end(await response.text());
}

let server: Server;
let baseUrl = "";
const dirs: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => void bridge(req, res));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function student(): (...args: string[]) => Promise<{ code: number; out: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "campus-connect-"));
  dirs.push(dataDir);
  return (...args) =>
    new Promise((done) => {
      execFile(
        "python3",
        [SCRIPT, ...args],
        {
          env: {
            ...process.env,
            SKILL_DATA_DIR: dataDir,
            CAMPUS_CONNECT_URL: baseUrl,
            CAMPUS_CONNECT_NOW: new Date(NOW).toISOString(),
            PYTHONDONTWRITEBYTECODE: "1",
          },
        },
        (err, stdout) => done({ code: err ? Number(err.code ?? 1) : 0, out: stdout }),
      );
    });
}

describe("Python client against the real handlers", () => {
  it("runs the whole flow for two students", async () => {
    const alex = student();
    const jordan = student();

    const alexJoin = [
      "join", "--kind", "study", "--name", "Alex", "--contact", "alex@example.edu", "--course", "cse 310",
      "--topic", "hash tables", "--can-help", "recursion",
      "--free", "2026-10-24T11:00-07:00/2026-10-24T14:00-07:00",
    ];
    let r = await alex(...alexJoin);
    expect(r.code).toBe(0);
    expect(r.out).toContain("JOINED");
    expect(r.out).toContain("No match yet");

    // Joining again updates the one request.
    r = await alex(...alexJoin);
    expect(r.out).toContain("UPDATED");
    expect(await store.smembers("pool:study:course:CSE310")).toHaveLength(1);

    // A free time with no zone uses --tz.
    r = await jordan(
      "join", "--kind", "study", "--name", "Jordan", "--contact", "+1 480 555 0199", "--course", "CSE-310",
      "--topic", "hash table collisions", "--can-help", "hash functions, recursion",
      "--tz", "America/Phoenix", "--free", "2026-10-24T12:00/2026-10-24T15:00",
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("NEW MATCH");
    expect(r.out).toContain("Name: Alex");
    // Jordan can help with what Alex needs, so Jordan's result leads with that.
    expect(r.out).toContain("Why: Someone needs your help: You're both free Sat Oct 24, 12 to 2 pm. Alex needs hash, which you offer.");

    r = await alex("check");
    expect(r.out).toContain("NEW MATCH");
    expect(r.out).toContain("Name: Jordan");
    expect(r.out).toContain("Why: You're both free Sat Oct 24, 12 to 2 pm. Jordan can help with hash.");
    expect(r.out).toContain("Sat Oct 24, 12:00 PM to 1:00 PM");
    expect(r.out).not.toContain("555");
    const id = /Match id: (\S+)/.exec(r.out)?.[1] ?? "";
    expect(id).not.toBe("");

    expect((await alex("check")).out).toContain("NOTHING NEW");

    r = await alex("respond", "--match", id, "--accept");
    expect(r.out).toContain("WAITING");
    r = await jordan("respond", "--match", id, "--accept");
    expect(r.out).toContain("CONFIRMED");
    expect(r.out).toContain("alex@example.edu");

    r = await alex("check");
    expect(r.out).toContain("CONFIRMED");
    expect(r.out).toContain("+1 480 555 0199");

    r = await alex("leave");
    expect(r.out).toContain("LEFT");
    expect(store.keys().filter((key) => key.startsWith("auth:"))).toHaveLength(1); // only Jordan is left
    expect((await jordan("status")).out).toContain("No matches yet");
  }, 30_000);

  it("rejects bad input before sending, and errors are one line", async () => {
    const sam = student();
    const before = store.keys().length;
    for (const args of [
      ["--kind", "nap", "--campus", "ASU Tempe", "--topic", "x y", "--free", "2026-10-24T11:00-07:00/2026-10-24T14:00-07:00"],
      ["--kind", "ride", "--campus", "ASU Tempe", "--topic", "PHX", "--free", "2026-10-23T11:00-07:00/2026-10-23T14:00-07:00"],
      ["--kind", "ride", "--campus", "ASU Tempe", "--topic", "PHX", "--free", "2026-10-24T11:00/2026-10-24T14:00"],
    ]) {
      const r = await sam("join", "--name", "Sam", "--contact", "sam@example.edu", ...args);
      expect(r.code).toBe(1);
      expect(r.out.trim().split("\n")).toHaveLength(1);
      expect(r.out).toMatch(/^ERROR\. (UNKNOWN KIND|BAD FREE TIME|NEED TIME ZONE)\./);
    }
    expect(store.keys().length).toBe(before);
  }, 30_000);
});

/** A context file shaped like supercub/assets/context-example.json, with this student's name and contact. */
function contextFile(firstName: string, contact: string): string {
  const dir = mkdtempSync(join(tmpdir(), "supercub-context-"));
  dirs.push(dir);
  const ctx = JSON.parse(readFileSync(CONTEXT_EXAMPLE, "utf8")) as { policy: Record<string, string> };
  ctx.policy = { ...ctx.policy, first_name: firstName, contact };
  const path = join(dir, "context.json");
  writeFileSync(path, JSON.stringify(ctx));
  return path;
}

describe("Python client sync loop against the real handlers", () => {
  it("both students sync, get one ask each, both say yes, and both get the other's contact once", async () => {
    const alex = student();
    const jordan = student();
    const alexFile = contextFile("Alex", "alex@example.edu");
    const jordanFile = contextFile("Jordan", "+1 480 555 0199");

    for (const s of [alex, jordan]) {
      const r = await s("policy", "--participating", "yes");
      expect(r.code).toBe(0);
      expect(r.out).toContain("POLICY SAVED");
    }

    // Alex syncs first: nobody to pair with yet.
    let r = await alex("sync", "--file", alexFile);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("NOTHING NEW");

    // Jordan syncs: discovery pairs them, and Jordan gets the ask.
    r = await jordan("sync", "--file", jordanFile);
    expect(r.code).toBe(0);
    const jordanLines = r.out.trim().split("\n");
    expect(jordanLines[0]).toMatch(/^ASK \S+$/);
    const id = (jordanLines[0] ?? "").slice("ASK ".length);
    expect(jordanLines[1]).toContain("Someone in your CSE 310 class");
    expect(jordanLines[1]).toContain("Want me to see if you'd both like to connect?");
    expect(r.out).not.toContain("Alex");
    expect(r.out).not.toContain("alex@example.edu");

    // Alex's next sync gets the same suggestion.
    r = await alex("sync", "--file", alexFile);
    expect(r.out.trim().split("\n")[0]).toBe(`ASK ${id}`);
    expect(r.out).not.toContain("Jordan");
    expect(r.out).not.toContain("555");

    r = await alex("answer", id, "yes");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("WAITING");

    r = await jordan("answer", id, "yes");
    expect(r.code).toBe(0);
    let lines = r.out.trim().split("\n");
    expect(lines[0]).toBe("AGREED");
    expect(lines[1]).toContain("You're on. Alex said yes too.");
    expect(lines[2]).toBe("alex@example.edu");
    expect(lines[3]).toBe("Calendar times: 2026-10-25T14:00-07:00 to 2026-10-25T15:00-07:00");

    // Alex hears it on the next sync, once.
    r = await alex("sync", "--file", alexFile);
    lines = r.out.trim().split("\n");
    expect(lines[0]).toBe("AGREED");
    expect(lines[1]).toContain("You're on. Jordan said yes too.");
    expect(lines[2]).toBe("+1 480 555 0199");
    expect(lines[3]).toBe("Calendar times: 2026-10-25T14:00-07:00 to 2026-10-25T15:00-07:00");
    expect((await alex("sync", "--file", alexFile)).out.trim()).toBe("NOTHING NEW");

    // Jordan already heard it from the answer, so the next sync has nothing new.
    expect((await jordan("sync", "--file", jordanFile)).out.trim()).toBe("NOTHING NEW");
  }, 30_000);

  it("later prints LATER, and an unknown id prints CLOSED", async () => {
    // Alex and Jordan from the test above are at their weekly cap, so these two are paired with each other.
    const casey = student();
    const dana = student();
    for (const s of [casey, dana]) await s("policy", "--participating", "yes");
    expect((await casey("sync", "--file", contextFile("Casey", "casey@example.edu"))).out.trim()).toBe("NOTHING NEW");
    const r = await dana("sync", "--file", contextFile("Dana", "dana@example.edu"));
    const id = /^ASK (\S+)/.exec(r.out)?.[1] ?? "";
    expect(id).not.toBe("");

    let out = (await dana("answer", id, "later")).out.trim();
    expect(out).toMatch(/^LATER\./);

    out = (await dana("answer", "00000000-0000-4000-8000-000000000000", "yes")).out.trim();
    expect(out).toMatch(/^CLOSED\./);
  }, 30_000);
});
