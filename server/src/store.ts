// Small key-value store interface with two implementations:
// InMemoryStore for tests, UpstashStore for production (Upstash Redis REST API over fetch).

export interface Store {
  get(key: string): Promise<string | null>;
  /** Set a value, optionally expiring after `ttlSeconds`. */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  /** Set only if the key does not exist, optionally expiring after `ttlSeconds`. Returns true if it was set. */
  setIfAbsent(key: string, value: string, ttlSeconds?: number): Promise<boolean>;
  del(keys: string[]): Promise<void>;
  /** Add to a set, optionally (re)setting the set's expiry. */
  sadd(key: string, member: string, ttlSeconds?: number): Promise<void>;
  srem(key: string, member: string): Promise<void>;
  smembers(key: string): Promise<string[]>;
}

type Clock = () => number;

interface Entry<T> {
  value: T;
  expiresAt: number | null;
}

export class InMemoryStore implements Store {
  private strings = new Map<string, Entry<string>>();
  private sets = new Map<string, Entry<Set<string>>>();

  constructor(private readonly clock: Clock = Date.now) {}

  private expiry(ttlSeconds: number | undefined): number | null {
    return ttlSeconds === undefined ? null : this.clock() + ttlSeconds * 1000;
  }

  private live<T>(map: Map<string, Entry<T>>, key: string): Entry<T> | undefined {
    const entry = map.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= this.clock()) {
      map.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.live(this.strings, key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.strings.set(key, { value, expiresAt: this.expiry(ttlSeconds) });
  }

  async setIfAbsent(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    if (this.live(this.strings, key)) return false;
    this.strings.set(key, { value, expiresAt: this.expiry(ttlSeconds) });
    return true;
  }

  async del(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.strings.delete(key);
      this.sets.delete(key);
    }
  }

  async sadd(key: string, member: string, ttlSeconds?: number): Promise<void> {
    const entry = this.live(this.sets, key) ?? { value: new Set<string>(), expiresAt: null };
    entry.value.add(member);
    if (ttlSeconds !== undefined) entry.expiresAt = this.expiry(ttlSeconds);
    this.sets.set(key, entry);
  }

  async srem(key: string, member: string): Promise<void> {
    this.live(this.sets, key)?.value.delete(member);
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.live(this.sets, key)?.value ?? [])];
  }

  /** Test helper: every key currently stored. */
  keys(): string[] {
    const all = [...this.strings.keys(), ...this.sets.keys()];
    return all.filter((k) => this.live(this.strings, k) || this.live(this.sets, k));
  }
}

type RedisValue = string | number | null | RedisValue[];

function toRedisValue(value: unknown): RedisValue {
  if (typeof value === "string" || typeof value === "number" || value === null) return value;
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return items.map(toRedisValue);
  }
  throw new Error("Upstash returned an unexpected value");
}

export class UpstashStore implements Store {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async command(args: string[]): Promise<RedisValue> {
    const results = await this.pipeline([args]);
    return results[0] ?? null;
  }

  /** Runs commands in one HTTP round trip via Upstash's /pipeline endpoint. */
  private async pipeline(commands: string[][]): Promise<RedisValue[]> {
    const res = await this.fetchFn(`${this.url.replace(/\/$/, "")}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      throw new Error(`Upstash request failed with HTTP ${res.status}`);
    }
    const body: unknown = await res.json();
    if (!Array.isArray(body)) throw new Error("Upstash returned an unexpected response");
    const items: unknown[] = body;
    return items.map((item) => {
      if (typeof item !== "object" || item === null) {
        throw new Error("Upstash returned an unexpected response");
      }
      if ("error" in item && typeof item.error === "string") {
        throw new Error(`Upstash error: ${item.error}`);
      }
      return "result" in item ? toRedisValue(item.result) : null;
    });
  }

  async get(key: string): Promise<string | null> {
    const result = await this.command(["GET", key]);
    return typeof result === "string" ? result : null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const args = ["SET", key, value];
    if (ttlSeconds !== undefined) args.push("EX", String(Math.max(1, Math.ceil(ttlSeconds))));
    await this.command(args);
  }

  async setIfAbsent(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    const args = ["SET", key, value, "NX"];
    if (ttlSeconds !== undefined) args.push("EX", String(Math.max(1, Math.ceil(ttlSeconds))));
    const result = await this.command(args);
    return result === "OK";
  }

  async del(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.command(["DEL", ...keys]);
  }

  async sadd(key: string, member: string, ttlSeconds?: number): Promise<void> {
    const commands = [["SADD", key, member]];
    if (ttlSeconds !== undefined) {
      commands.push(["EXPIRE", key, String(Math.max(1, Math.ceil(ttlSeconds)))]);
    }
    await this.pipeline(commands);
  }

  async srem(key: string, member: string): Promise<void> {
    await this.command(["SREM", key, member]);
  }

  async smembers(key: string): Promise<string[]> {
    const result = await this.command(["SMEMBERS", key]);
    return Array.isArray(result) ? result.filter((m): m is string => typeof m === "string") : [];
  }
}

/** Builds the production store from the env vars Vercel's Upstash integration sets. */
export function storeFromEnv(env: NodeJS.ProcessEnv = process.env): Store | null {
  const url = env.KV_REST_API_URL;
  const token = env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new UpstashStore(url, token);
}
