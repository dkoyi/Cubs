// The demo suite deliberately uses fictional fixtures, never the real alumni research bundle.
import { describe, expect, it } from "vitest";
import { DemoEngine } from "../../demo/engine.js";

describe("isolated conversation studio", () => {
  it("creates 100 separate fictional alumni assistants and uses real discovery evidence", async () => {
    const engine = new DemoEngine();
    await engine.reset();
    const state = await engine.snapshot();
    expect(state.personas).toHaveLength(101);
    expect(state.nodes).toHaveLength(100);
    expect(state.researchAvailable).toBe(false);
    expect(state.eligible.length).toBeGreaterThan(0);
    expect(state.messages.some((m) => m.card)).toBe(false);
    await engine.check();
    const discovered = await engine.snapshot();
    expect(discovered.current?.judge).toBe("rules");
    expect(discovered.current?.score).toBeGreaterThanOrEqual(0.5);
    expect(discovered.messages.some((m) => m.card)).toBe(true);
    expect(discovered.messages.some((m) => m.contact)).toBe(false);
    const other = await engine.snapshot(discovered.target);
    expect(other.messages.some((m) => m.card)).toBe(true);
    expect(other.messages.some((m) => m.text.includes("happy to share"))).toBe(true);
  });

  it("releases contacts only after two manually supplied simulated yeses", async () => {
    const engine = new DemoEngine();
    await engine.reset(); await engine.check();
    await engine.respond(engine.selfId, "yes");
    const waiting = await engine.snapshot();
    expect(waiting.current?.ownAnswer).toBe("yes");
    expect(waiting.messages.some((m) => m.contact)).toBe(false);
    await engine.respond(waiting.target, "yes");
    const agreed = await engine.snapshot();
    expect(agreed.current?.status).toBe("agreed");
    expect(agreed.messages.find((m) => m.contact)?.contact).toContain("@example.test");
    expect(agreed.history).toHaveLength(1);
    const other = await engine.snapshot(waiting.target);
    expect(other.messages.some((m) => m.contact)).toBe(true);
  });

  it("retains a connection across simulated years but asks again for a new reason", async () => {
    const engine = new DemoEngine();
    await engine.reset(); await engine.check();
    const first = await engine.snapshot();
    await engine.respond(engine.selfId, "yes"); await engine.respond(first.target, "yes");
    await engine.advance();
    const future = await engine.snapshot();
    expect(future.topic).toBe("climate technology");
    expect(future.current?.id).not.toBe(first.current?.id);
    expect(future.current?.ownAnswer).toBeNull();
    expect(future.current?.otherAnswer).toBeNull();
    expect(future.messages.at(-1)?.text).toContain("connected before");
    expect(future.history).toHaveLength(1);
    expect(future.events.some((event) => event.detail.includes("old intent did not revive"))).toBe(true);
  });

  it("changes candidate availability when the actual participating network grows", async () => {
    const engine = new DemoEngine();
    await engine.reset(); await engine.resizeNetwork(1);
    const small = await engine.snapshot();
    expect(small.nodes.filter((n) => n.active)).toHaveLength(1);
    await engine.resizeNetwork(100);
    const bigger = await engine.snapshot();
    expect(bigger.nodes.filter((n) => n.active)).toHaveLength(100);
    expect(bigger.eligible.length).toBeGreaterThan(small.eligible.length);
  });

  it("does not pretend a general conversation or a detail question is consent", async () => {
    const engine = new DemoEngine();
    await engine.reset(); await engine.check();
    await engine.send(engine.selfId, "Who is it?");
    expect((await engine.snapshot()).current?.ownAnswer).toBeNull();
    await engine.send(engine.selfId, "Can you fly me to the moon?");
    expect((await engine.snapshot()).messages.at(-1)?.text).toContain("guided simulation");
    await engine.send(engine.selfId, "I'm working on climate technology now");
    expect((await engine.snapshot()).context?.signals).toContainEqual(expect.objectContaining({ label: "climate technology" }));
  });

  it("runs a check-in for the selected assistant rather than writing in someone else's chat", async () => {
    const engine = new DemoEngine();
    await engine.reset();
    const initial = await engine.snapshot();
    const person = initial.personas.find((p) => !p.self && p.subject === "finance");
    expect(person).toBeDefined();
    if (!person) return;
    await engine.check(person.id);
    expect((await engine.snapshot(person.id)).messages.length).toBeGreaterThan(2);
    expect((await engine.snapshot()).messages).toHaveLength(initial.messages.length);
  });
});
