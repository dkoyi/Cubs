// Runs the real Python client (supercub/scripts/connect.py) against these handlers,
// served from an in-process HTTP server that exists only for the length of this test.

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleJoin, handleLeave, handleMatches, handleRespond } from "../src/handlers.js";
import type { Deps } from "../src/handlers.js";
import { InMemoryStore } from "../src/store.js";

const SCRIPT = resolve(import.meta.dirname, "../../supercub/scripts/connect.py");
const NOW = Date.parse("2026-10-24T16:00:00.000Z");

const store = new InMemoryStore(() => NOW);
const deps: Deps = { store, now: () => new Date(NOW) };

const routes: Record<string, (request: Request, deps: Deps) => Promise<Response>> = {
  "POST /api/requests": handleJoin,
  "GET /api/matches": handleMatches,
  "POST /api/respond": handleRespond,
  "DELETE /api/me": handleLeave,
};

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
  const handler = routes[`${method} ${new URL(request.url).pathname}`];
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
