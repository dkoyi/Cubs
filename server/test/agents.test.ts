// Fully fictional fixtures, local storage, fake providers and mock models only.
import { describe, expect, it } from "vitest";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStore } from "../src/store.js";
import { getContext, pendingFor } from "../src/loop.js";
import { AgentRuntime } from "../../agents/runtime.js";
import { addMemory, retrieve, isCurrent } from "../../agents/memory.js";
import type { Memory } from "../../agents/memory.js";
import { FileStore, NamespacedStore } from "../../agents/storage.js";
import { importEmail, readGmailMessage } from "../../agents/email.js";
import { modelFromEnv, AGENT_PROMPT } from "../../agents/model.js";
import { LoopMessageTransport, verifyWebhook } from "../../agents/transport.js";
import type { Transport } from "../../agents/transport.js";
import { acceptWebhook, workInbound } from "../../agents/webhook.js";
import { seedBoxes } from "../../agents/seed.js";
import { networkRequest } from "../../agents/network-http.js";
import { randomBytes, randomUUID } from "node:crypto";

const NOW = new Date("2026-10-25T16:00:00Z");
const DAY = 86400_000;
function setup(transport?: Transport) {
  let now = NOW.getTime();
  const store = new InMemoryStore(() => now);
  const boxes = new NamespacedStore(store, "test-private:"), network = new NamespacedStore(store, "test-network:");
  return { store, boxes, network, runtime: new AgentRuntime(boxes, network, transport, null, () => new Date(now)), advance: (ms: number) => { now += ms; } };
}
async function joinedPair(transport?: Transport) {
  const env = setup(transport);
  const a = await env.runtime.create("Alex Example", "Building healthcare products", transport ? false : true);
  const b = await env.runtime.create("Jordan Example", "Healthcare operator", transport ? false : true);
  for (const [box, type] of [[a, "work"], [b, "offer"]] as const) {
    await env.runtime.configure(box.id, { participating: true, school: "ASU", contact: `${box.name.split(" ")[0]!.toLowerCase()}@example.test`,
      share_intro_profile: true, intro_profile: { name: box.name, headline: box.headline, links: [] } });
    const memory = await env.runtime.remember(box.id, { type, value: "healthcare", source: "student", source_id: "explicit-local-offer-or-work" });
    const activity = await env.runtime.remember(box.id, { type: "activity", value: "advising", source: "student", source_id: "explicit-local-activity" });
    await env.runtime.shareMemory(box.id, memory.id, true); await env.runtime.shareMemory(box.id, activity.id, true);
  }
  return { ...env, a, b };
}

describe("personal memory index", () => {
  it("distinguishes present employment from historical roles with source references", () => {
    const memories: Memory[] = [];
    const old = addMemory(memories, { type: "role", value: "Engineer at Fictional Old Company", source: "profile", source_id: "profile-old", observed_at: "2024-01-01T00:00:00Z" }, NOW);
    const current = addMemory(memories, { type: "role", value: "Founder at Fictional New Company", source: "student", source_id: "statement-current" }, NOW);
    expect(old.status).toBe("superseded");
    expect(retrieve(memories, "What company do I work at?", NOW)[0]?.memory.id).toBe(current.id);
    expect(retrieve(memories, "Where did I work before?", NOW)[0]?.memory.id).toBe(old.id);
    expect(current.shared).toBe(false);
  });
  it("does not infer a help offer from email and does not revive one by reimporting its old source", () => {
    const memories: Memory[] = [];
    expect(() => addMemory(memories, { type: "offer", value: "React", source: "email", source_id: "mail" }, NOW)).toThrow("willingness");
    const offer = addMemory(memories, { type: "offer", value: "React", source: "student", source_id: "actual-offer" }, NOW);
    const future = new Date(NOW.getTime() + 61 * DAY);
    addMemory(memories, { type: "offer", value: "React", source: "student", source_id: "actual-offer" }, future);
    expect(isCurrent(offer, future)).toBe(false);
  });
  it("does not let an older imported role supersede newer employment", () => {
    const memories: Memory[] = [];
    addMemory(memories, { type: "role", value: "Engineer at New Example", source: "student", source_id: "new" }, NOW);
    const older = addMemory(memories, { type: "role", value: "Engineer at Old Example", source: "profile", source_id: "old", observed_at: "2020-01-01T00:00:00Z" }, NOW);
    expect(older.status).toBe("superseded");
    expect(retrieve(memories, "my current role", NOW)[0]?.memory.value).toContain("New Example");
  });
});

describe("durable and separated boxes", () => {
  it("survives a file-store restart with owner-only permissions and expiry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supercub-private-box-test-"));
    const path = join(directory, "store.json");
    const first = new FileStore(path, () => NOW.getTime()); await first.load();
    await first.set("private:one", "fictional-memory"); await first.sadd("people", "person-one"); await first.set("expires", "old", 1);
    const second = new FileStore(path, () => NOW.getTime() + 2000); await second.load();
    expect(await second.get("private:one")).toBe("fictional-memory");
    expect(await second.smembers("people")).toEqual(["person-one"]);
    expect(await second.get("expires")).toBeNull();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  it("only projects specifically approved memories, never jobs or private conversations", async () => {
    const { runtime, network } = setup();
    const box = await runtime.create("Alex Example", "Example builder");
    await runtime.remember(box.id, { type: "role", value: "Engineer at Private Example Company", source: "student", source_id: "private-role" });
    await runtime.receive(box.id, "I'm working on healthcare");
    expect((await runtime.box(box.id)).memories.find((m) => m.type === "work")?.shared).toBe(false);
    await runtime.configure(box.id, { participating: true, school: "ASU" });
    await runtime.receive(box.id, "yes");
    const context = await getContext(network, box.id);
    expect(context?.signals.map((s) => s.entity.label)).toEqual(["healthcare"]);
    expect(JSON.stringify(context)).not.toContain("Private Example Company");
    expect(JSON.stringify(context)).not.toContain("I'm working on");
    const role = (await runtime.box(box.id)).memories.find((m) => m.type === "role")!;
    await expect(runtime.shareMemory(box.id, role.id, true)).rejects.toThrow("Jobs");
  });
  it("retrieves from only the selected person's box and keeps source-derived facts private", async () => {
    const { runtime } = setup();
    const a = await runtime.create("Alex Example", "Example"), b = await runtime.create("Jordan Example", "Example");
    await runtime.remember(a.id, { type: "role", value: "Engineer at Alex Company", source: "student", source_id: "a" });
    await runtime.remember(b.id, { type: "role", value: "Operator at Jordan Company", source: "student", source_id: "b" });
    await runtime.receive(a.id, "What company do I work at?");
    expect((await runtime.box(a.id)).messages.at(-1)?.text).toContain("Alex Company");
    expect((await runtime.box(a.id)).messages.at(-1)?.text).not.toContain("Jordan Company");
    await expect(runtime.shareMemory(a.id, (await runtime.box(b.id)).memories[0]!.id, true)).rejects.toThrow("in this box");
  });
  it("creates 100 persistent fictional identities without joining them or overwriting edited memories", async () => {
    const { runtime } = setup(); await seedBoxes(runtime, 2);
    const alex = (await runtime.list())[0]!;
    await runtime.receive(alex.id, "I work at Updated Fictional Company");
    await seedBoxes(runtime, 100);
    expect(await runtime.list()).toHaveLength(100);
    expect((await runtime.box(alex.id)).memories.some((m) => m.value === "Updated Fictional Company")).toBe(true);
    expect((await runtime.list()).every((b) => b.shared === 0)).toBe(true);
    expect((await runtime.box(alex.id)).policy.participating).toBe(false);
  });
});

describe("private email ingestion", () => {
  it("extracts selected facts with provenance without retaining raw email text or sharing it", async () => {
    const { runtime, boxes, network } = setup();
    const box = await runtime.create("Alex Example", "Example");
    const document = { id: "fictional-mail-1", received_at: NOW.toISOString(), text: "Employer: Engineer at Sample Company\nProject: healthcare\nPrivate source sentence not to persist." };
    await expect(importEmail(runtime, box.id, document)).rejects.toThrow("Approve");
    await runtime.setEmail(box.id, true);
    expect(await importEmail(runtime, box.id, document)).toBe(2);
    const saved = await boxes.get(`box:${box.id}`);
    expect(saved).not.toContain("Private source sentence");
    expect((await runtime.box(box.id)).memories.every((memory) => !memory.shared && memory.source === "email")).toBe(true);
    await runtime.sync(box.id);
    expect((await getContext(network, box.id))?.signals).toEqual([]);
  });
  it("implements the Gmail read-only message protocol with mocked HTTP only", async () => {
    let url = "";
    const fake: typeof fetch = async (input) => {
      url = String(input);
      return new Response(JSON.stringify({ id: "mail-1", internalDate: String(NOW.getTime()), payload: { mimeType: "text/plain", body: { data: Buffer.from("Project: healthcare").toString("base64url") } } }));
    };
    const document = await readGmailMessage("fake-read-only-token", "mail-1", fake);
    expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/mail-1?format=full");
    expect(document.text).toBe("Project: healthcare");
  });
  it("cannot turn model extraction into source-derived offers", async () => {
    const env = setup();
    const runtime = new AgentRuntime(env.boxes, env.network, undefined, { name: "mock", async reply() { return "mock"; }, async extractEmail() {
      return [{ type: "offer", value: "React", source: "student", source_id: "invented" }];
    } }, () => NOW);
    const box = await runtime.create("Alex", "Example"); await runtime.setEmail(box.id, true);
    await runtime.setEmailAI(box.id, true);
    await importEmail(runtime, box.id, { id: "mail", received_at: NOW.toISOString(), text: "Unstructured fictional email." }, true);
    expect((await runtime.box(box.id)).memories).toEqual([]);
  });
  it("does not let a newly imported source inherit sharing approval for an identical fact", async () => {
    const { runtime, a, network } = await joinedPair();
    await runtime.setEmail(a.id, true);
    await importEmail(runtime, a.id, { id: "new-source", received_at: NOW.toISOString(), text: "Project: healthcare" });
    expect((await runtime.box(a.id)).memories.find((m) => m.value === "healthcare")?.shared).toBe(false);
    expect((await getContext(network, a.id))?.signals.some((s) => s.entity.label === "healthcare")).toBe(false);
  });
});

describe("agent consent and actual schedules", () => {
  it("interoperates with a separate Cubbie-compatible client on the same lab network", async () => {
    const { runtime, network } = setup();
    const own = await runtime.create("Alex Example", "Example builder");
    await runtime.configure(own.id, { participating: true, first_name: "Alex", school: "ASU", contact: "alex@example.test" });
    for (const input of [{ type: "work", value: "healthcare" }, { type: "activity", value: "advising" }] as const) {
      const memory = await runtime.remember(own.id, { ...input, source: "student", source_id: "explicit-test-fact" });
      await runtime.shareMemory(own.id, memory.id, true);
    }
    const id = randomUUID(), token = randomBytes(32).toString("base64url");
    const request = (path: string, method = "GET", body?: unknown, person: string = id) => new Request(`https://lab.test/api/${path}`, { method,
      headers: { "X-Student-Id": person, Authorization: `Bearer ${token}`, "X-Supercub-Delivery": "acknowledged" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const put = await networkRequest(request("context", "PUT", { policy: { participating: true, first_name: "Jordan", school: "ASU", contact: "jordan@example.test" },
      signals: [{ type: "can_help_with", entity: { kind: "topic", label: "healthcare" }, source: "student" },
        { type: "open_to", entity: { kind: "activity", label: "advising" }, source: "student" }] }), network, () => NOW);
    expect(put?.status).toBe(200);
    await runtime.check(own.id); await runtime.receive(own.id, "yes");
    const result = await networkRequest(request("suggestions"), network, () => NOW);
    const pending = await result!.json() as { ask: { id: string } };
    const agreed = await networkRequest(request(`suggestions/${pending.ask.id}/answer`, "POST", { answer: "yes" }), network, () => NOW);
    expect(await agreed!.json()).toMatchObject({ status: "agreed", contact: "alex@example.test" });
    await runtime.check(own.id);
    expect((await runtime.box(own.id)).messages.at(-1)?.text).toContain("jordan@example.test");
    expect((await networkRequest(request("context", "GET", undefined, own.id), network, () => NOW))?.status).toBe(401);
    expect(await networkRequest(request("boxes"), network, () => NOW)).toBeNull();
  });

  it("requires two explicit answers and never treats a request for details as acceptance", async () => {
    const { runtime, a, b } = await joinedPair();
    await runtime.check(a.id); await runtime.check(b.id);
    await runtime.receive(a.id, "Who is it?");
    expect((await runtime.box(a.id)).pending_intro).not.toBeNull();
    await runtime.receive(a.id, "yes");
    expect((await runtime.box(a.id)).messages.at(-1)?.text).not.toContain("jordan@example.test");
    await runtime.receive(b.id, "yes"); await runtime.check(a.id);
    expect((await runtime.box(a.id)).messages.at(-1)?.text).toContain("jordan@example.test");
    expect((await runtime.box(b.id)).messages.at(-1)?.text).toContain("alex@example.test");
  });
  it("runs a due bounded check-in unattended and cancels it on opt-out", async () => {
    const { runtime, a, b, advance } = await joinedPair();
    await runtime.schedule(a.id, 60, 600); await runtime.schedule(b.id, 60, 600);
    advance(61_000);
    expect(await runtime.tick()).toBe(2);
    expect((await runtime.box(a.id)).pending_intro).not.toBeNull();
    expect((await runtime.box(b.id)).pending_intro).not.toBeNull();
    await runtime.configure(a.id, { participating: false });
    expect((await runtime.box(a.id)).schedule).toBeNull();
    advance(601_000); await runtime.tick();
    expect((await runtime.box(b.id)).schedule).toBeNull();
  });
  it("keeps memory-sharing acceptance separate from introduction acceptance and deduplicates inbound IDs", async () => {
    const { runtime, a } = await joinedPair();
    await runtime.check(a.id);
    await runtime.receive(a.id, "I'm interested in climate technology", "incoming-1");
    await runtime.receive(a.id, "yes", "incoming-2");
    const before = (await runtime.box(a.id)).messages.length;
    await runtime.receive(a.id, "yes", "incoming-2");
    expect((await runtime.box(a.id)).messages).toHaveLength(before);
    expect((await runtime.box(a.id)).memories.some((m) => m.value === "climate technology" && m.shared)).toBe(true);
  });
  it("does not reuse an old introduction question after an unrelated memory conversation", async () => {
    const { runtime, a } = await joinedPair();
    await runtime.check(a.id);
    await runtime.receive(a.id, "What company do I work at?");
    await runtime.receive(a.id, "yes");
    expect((await runtime.box(a.id)).messages.at(-1)?.text).toContain("isn't a pending question");
    expect((await runtime.box(a.id)).outbox.some((o) => o.suggestion?.kind === "agreed")).toBe(false);
  });
});

describe("iMessage connector", () => {
  it("omits a dedicated sender in sandbox and requires the contact's 24-hour inbound window", async () => {
    let payload = "";
    const fake: typeof fetch = async (_url, init) => { payload = String(init?.body); return new Response(JSON.stringify({ message_id: "sandbox-receipt" })); };
    const transport = new LoopMessageTransport("fake-key", new Set(["+15555550101"]), fake, true);
    const message = { id: "sandbox-message", text: "Hello", contact: "+15555550101", sender: null };
    expect(transport.canSend(message)).toBe(false);
    await expect(transport.send(message)).rejects.toThrow("24-hour");
    expect(transport.canSend({ ...message, last_inbound_at: new Date(Date.now() - 25 * 3600_000).toISOString() })).toBe(false);
    expect((await transport.send({ ...message, last_inbound_at: new Date().toISOString() })).status).toBe("queued");
    expect(JSON.parse(payload)).toEqual({ contact: "+15555550101", text: "Hello", passthrough: "sandbox-message" });
  });
  it("routes authenticated shared-sandbox sender callbacks to only the bound contact's box", async () => {
    const { runtime, store } = setup();
    const jobs = new NamespacedStore(store, "test-sandbox-jobs:");
    const box = await runtime.create("Sandbox Pilot", "Example", false);
    await runtime.bindMessaging(box.id, "+15555550101", "__sandbox__");
    const secret = "sandbox-test-secret-at-least-32-characters";
    const request = new Request("https://lab.test/webhooks/loopmessage", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({
      event: "message_inbound", message_type: "text", sender: "provider-shared-sandbox-sender", contact: "+15555550101", text: "Hello", message_id: "sandbox-inbound", webhook_id: "sandbox-event",
    }) });
    expect((await acceptWebhook(request, secret, runtime, jobs, true)).status).toBe(200);
    await workInbound(runtime, jobs);
    expect((await runtime.box(box.id)).messaging.last_inbound_at).toBe(NOW.toISOString());
    expect((await runtime.box(box.id)).messages.some((m) => m.sender === "person" && m.text === "Hello")).toBe(true);
  });
  it("queues authenticated delivery callbacks for deferred processing", async () => {
    const { runtime, store } = setup();
    const jobs = new NamespacedStore(store, "test-delivery-jobs:");
    const secret = "test-secret-at-least-32-characters";
    const request = new Request("https://lab.test/webhooks/loopmessage", { method: "POST", headers: { authorization: `Bearer ${secret}` },
      body: JSON.stringify({ event: "message_delivered", message_id: "future-receipt", webhook_id: "callback-1" }) });
    expect((await acceptWebhook(request, secret, runtime, jobs)).status).toBe(200);
    expect(await jobs.smembers("pending")).toHaveLength(1);
    await workInbound(runtime, jobs);
    expect(await jobs.smembers("pending")).toEqual([]);
  });
  it("uses the documented LoopMessage wire format and does not call queued delivery delivered", async () => {
    let seen: RequestInit | undefined;
    const fake: typeof fetch = async (url, init) => { expect(String(url)).toBe("https://a.loopmessage.com/api/v1/message/send/"); seen = init; return new Response(JSON.stringify({ message_id: "provider-message" })); };
    const transport = new LoopMessageTransport("fake-api-key", new Set(["+15555550101"]), fake);
    const receipt = await transport.send({ id: "outbox-1", text: "Hello", contact: "+15555550101", sender: "test-sender" });
    expect(receipt.status).toBe("queued");
    expect(new Headers(seen?.headers).get("Authorization")).toBe("fake-api-key");
    expect(JSON.parse(String(seen?.body))).toEqual({ contact: "+15555550101", sender: "test-sender", text: "Hello", passthrough: "outbox-1" });
    await expect(transport.send({ id: "x", text: "Hello", contact: "+15555550102", sender: "sender" })).rejects.toThrow("allowlisted");
  });
  it("acknowledges only a delivery webhook, not the send response", async () => {
    const transport: Transport = { name: "loopmessage", async send(message) { return { id: `provider-${message.id}`, status: "queued" }; } };
    const { runtime, network, a, b } = await joinedPair(transport);
    await runtime.bindMessaging(a.id, "+15555550101", "sender"); await runtime.bindMessaging(b.id, "+15555550102", "sender");
    await runtime.check(a.id);
    const box = await runtime.box(a.id);
    const outbound = box.outbox.find((o) => o.suggestion?.kind === "ask")!;
    expect(outbound.state).toBe("queued");
    expect((await pendingFor(network, a.id, NOW, true)).ask).not.toBeNull();
    await runtime.delivery(outbound.provider_id!, true);
    expect((await pendingFor(network, a.id, NOW, true)).ask).toBeNull();
  });
  it("authenticates, persists and deduplicates provider events before processing, with exact box routing", async () => {
    const { runtime, store } = setup();
    const jobs = new NamespacedStore(store, "test-jobs:");
    const box = await runtime.create("Pilot Example", "Example", false);
    await runtime.bindMessaging(box.id, "+15555550101", "sender");
    const secret = "test-webhook-secret-at-least-32-characters";
    const body = { event: "message_inbound", message_type: "text", sender: "sender", contact: "+15555550101", text: "I'm interested in robotics", message_id: "m1", webhook_id: "w1" };
    const request = (auth: string) => new Request("https://lab.test/webhooks/loopmessage", { method: "POST", headers: { authorization: auth }, body: JSON.stringify(body) });
    expect((await acceptWebhook(request("wrong"), secret, runtime, jobs)).status).toBe(401);
    expect((await acceptWebhook(request(`Bearer ${secret}`), secret, runtime, jobs)).status).toBe(200);
    await acceptWebhook(request(`Bearer ${secret}`), secret, runtime, jobs);
    expect(await jobs.smembers("pending")).toHaveLength(1);
    expect((await runtime.box(box.id)).memories).toEqual([]);
    await workInbound(runtime, jobs);
    expect((await runtime.box(box.id)).memories).toHaveLength(1);
    expect((await runtime.box(box.id)).memories[0]?.shared).toBe(false);
    await expect(runtime.routeInbound("+15555550101", "different-sender")).resolves.toBeNull();
    expect(verifyWebhook(`Bearer ${secret}`, secret)).toBe(true);
  });
  it("refuses to attach a fictional identity to a real messaging contact", async () => {
    const { runtime } = setup(); const box = await runtime.create("Fictional Person", "Example");
    await expect(runtime.bindMessaging(box.id, "+15555550101", "sender")).rejects.toThrow("Synthetic boxes");
  });
  it("routes sender-less documented callbacks only when the contact binding is unique", async () => {
    const { runtime } = setup();
    const a = await runtime.create("First Pilot", "Example", false), b = await runtime.create("Second Pilot", "Example", false);
    await runtime.bindMessaging(a.id, "+15555550101", "sender-a");
    expect(await runtime.routeInbound("+15555550101")).toBe(a.id);
    await runtime.bindMessaging(b.id, "+15555550101", "sender-b");
    expect(await runtime.routeInbound("+15555550101")).toBeNull();
    expect(await runtime.routeInbound("+15555550101", "sender-a")).toBe(a.id);
  });
});

describe("optional generative replies", () => {
  it("is disabled by default and sends only selected private memories to a mocked model", async () => {
    expect(modelFromEnv({})).toBeNull();
    expect(() => modelFromEnv({ SUPERCUB_AGENT_AI: "anthropic" })).toThrow("MODEL");
    let payload = "";
    const fake: typeof fetch = async (_url, init) => { payload = String(init?.body); return new Response(JSON.stringify({ content: [{ type: "text", text: "You're currently at Example Company." }] })); };
    const model = modelFromEnv({ SUPERCUB_AGENT_AI: "anthropic", SUPERCUB_AGENT_MODEL: "mock-model", ANTHROPIC_API_KEY: "fake-key" }, fake)!;
    const memories: Memory[] = [];
    const memory = addMemory(memories, { type: "role", value: "Engineer at Example Company", source: "student", source_id: "source-1" }, NOW);
    expect(await model.reply("Alex", "Where do I work?", [memory])).toContain("Example Company");
    expect(payload).toContain(AGENT_PROMPT.replace(/\n/g, "\\n").slice(0, 80));
    expect(payload).not.toContain("fake-key");
  });
});
