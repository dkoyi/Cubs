import { describe, expect, it } from "vitest";
import { UpstashStore } from "../src/store.js";

interface Call {
  url: string;
  auth: string | null;
  commands: unknown;
}

function fakeFetch(results: unknown[], calls: Call[]): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      auth: headers.get("authorization"),
      commands: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify(results.shift()), { status: 200 });
  };
}

describe("UpstashStore", () => {
  it("sends Redis commands to the REST pipeline endpoint with the token", async () => {
    const calls: Call[] = [];
    const store = new UpstashStore(
      "https://example.upstash.io/",
      "tok",
      fakeFetch([[{ result: "OK" }], [{ result: "v" }], [{ result: 1 }, { result: 1 }], [{ result: ["a", "b"] }]], calls),
    );
    await store.set("k", "v", 60);
    expect(await store.get("k")).toBe("v");
    await store.sadd("s", "a", 120);
    expect(await store.smembers("s")).toEqual(["a", "b"]);

    expect(calls.map((c) => c.url)).toEqual(Array(4).fill("https://example.upstash.io/pipeline"));
    expect(calls[0]?.auth).toBe("Bearer tok");
    expect(calls[0]?.commands).toEqual([["SET", "k", "v", "EX", "60"]]);
    expect(calls[2]?.commands).toEqual([["SADD", "s", "a"], ["EXPIRE", "s", "120"]]);
  });

  it("reports SET NX results and Redis errors", async () => {
    const calls: Call[] = [];
    const store = new UpstashStore(
      "https://example.upstash.io",
      "tok",
      fakeFetch([[{ result: "OK" }], [{ result: null }], [{ error: "WRONGTYPE" }]], calls),
    );
    expect(await store.setIfAbsent("k", "v", 90)).toBe(true);
    expect(await store.setIfAbsent("k", "v")).toBe(false);
    await expect(store.get("k")).rejects.toThrow("WRONGTYPE");
    expect(calls[0]?.commands).toEqual([["SET", "k", "v", "NX", "EX", "90"]]);
    expect(calls[1]?.commands).toEqual([["SET", "k", "v", "NX"]]);
  });
});
