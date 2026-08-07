import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import SelfEvolvePlugin from "../self-evolve.js";
import { makeGlobalSettings } from "../self-evolve-schemas.js";
import { openStore, projectFingerprintFor } from "../self-evolve-store.js";

const {
  EVENT_DELIVERY_DEDUP_MAX_ENTRIES,
  EVENT_DELIVERY_DEDUP_TTL_MS,
  EVENT_DELIVERY_MAX_PENDING,
  createSemanticEventDeduper,
  semanticEventDedupKey,
} = SelfEvolvePlugin.__test;

function durableFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-event-delivery-"));
  const stateRoot = path.join(root, "state");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(worktree, { recursive: true });
  const projectFingerprint = projectFingerprintFor("", worktree);
  const store = openStore(stateRoot, { projectFingerprint });
  const settings = store.getSettings();
  store.setGlobalSettings(makeGlobalSettings({ ...settings.global, mode: "auto", updatedAt: settings.global.updatedAt + 1 }));
  store.close();
  const ctx = {
    directory: worktree,
    worktree,
    path: { state: stateRoot },
    client: {
      global: { health: async () => ({ data: { healthy: true, version: "1.18.3" } }) },
      path: { get: async () => ({ data: { state: stateRoot, worktree } }) },
      session: {},
    },
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { ctx };
}

function integration(overrides = {}) {
  return {
    async boot() { return { ok: true }; },
    async handleCommand() { return { responseText: "event runtime ready" }; },
    async handleEvent() {},
    async shutdown() {},
    ...overrides,
  };
}

async function waitForStartup(hooks) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const output = { parts: [] };
    await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "event-startup", arguments: "status" }, output);
    if (/event runtime ready/u.test(output.parts.at(-1)?.text ?? "")) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for event runtime startup");
}

async function settleDelivery() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function hostEvent(overrides = {}) {
  return {
    type: "session.idle",
    id: "event-1",
    properties: {
      sessionID: "session-1",
      parentID: "root-1",
      epoch: 3,
      generation: "generation-1",
      projectFingerprint: "a".repeat(64),
    },
    ...overrides,
  };
}

test("semantic keys match fresh wrappers and discriminate real event identity", () => {
  const event = hostEvent();
  assert.equal(semanticEventDedupKey(event), semanticEventDedupKey({ event: structuredClone(event) }));
  assert.notEqual(semanticEventDedupKey(event), semanticEventDedupKey(hostEvent({ id: "event-2" })));
  assert.notEqual(semanticEventDedupKey(event), semanticEventDedupKey(hostEvent({ properties: { ...event.properties, sessionID: "session-2" } })));
  assert.notEqual(semanticEventDedupKey(event), semanticEventDedupKey(hostEvent({ properties: { ...event.properties, epoch: 4 } })));

  const missingID = hostEvent({ id: undefined, properties: { ...event.properties, epoch: undefined, generation: undefined, timestamp: 100 } });
  const replay = structuredClone(missingID);
  const later = structuredClone(missingID);
  later.properties.timestamp = 101;
  assert.match(semanticEventDedupKey(missingID), /^fallback:/u);
  assert.equal(semanticEventDedupKey(missingID), semanticEventDedupKey({ event: replay }));
  assert.notEqual(semanticEventDedupKey(missingID), semanticEventDedupKey(later));
});

test("semantic dedup has a bounded replay window and oldest-entry eviction", () => {
  const dedup = createSemanticEventDeduper();
  assert.equal(dedup.accept("same", 1_000), true);
  assert.equal(dedup.accept("same", 1_000 + EVENT_DELIVERY_DEDUP_TTL_MS - 1), false);
  assert.equal(dedup.accept("same", 1_000 + EVENT_DELIVERY_DEDUP_TTL_MS), true);

  const bounded = createSemanticEventDeduper();
  for (let index = 0; index <= EVENT_DELIVERY_DEDUP_MAX_ENTRIES; index += 1) {
    assert.equal(bounded.accept(`event-${index}`, index), true);
  }
  assert.equal(bounded.size, EVENT_DELIVERY_DEDUP_MAX_ENTRIES);
  assert.equal(bounded.accept("event-0", EVENT_DELIVERY_DEDUP_MAX_ENTRIES + 1), true, "the oldest key must have been evicted");
});

test("event hook returns immediately and contains malformed input and downstream rejection", async (t) => {
  const f = durableFixture(t);
  const diagnostics = [];
  let calls = 0;
  const hooks = await SelfEvolvePlugin(f.ctx, {
    log: (entry) => diagnostics.push(entry),
    pipelineFactory: async () => integration({
      async handleEvent() {
        calls += 1;
        throw new Error("downstream event failure with private trailing detail".repeat(20));
      },
    }),
  });
  t.after(async () => hooks.dispose());
  await waitForStartup(hooks);

  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  assert.equal(hooks.event(hostEvent()), undefined);
  const hostileError = new Proxy({}, { get() { throw new Error("hostile error getter"); } });
  const malformed = new Proxy({}, { get() { throw hostileError; } });
  assert.doesNotThrow(() => hooks.event(malformed));
  await settleDelivery();

  assert.equal(calls, 1);
  assert.equal(unhandled.length, 0);
  assert.ok(diagnostics.some((entry) => entry.action === "event-delivery-failed"));
  assert.ok(diagnostics.some((entry) => entry.action === "event-delivery-malformed"));
  assert.ok(diagnostics.every((entry) => String(entry.error ?? "").length <= 240));
});

test("fresh-wrapper duplicates are delivered once while distinct events are retained", async (t) => {
  const f = durableFixture(t);
  const received = [];
  const hooks = await SelfEvolvePlugin(f.ctx, {
    pipelineFactory: async () => integration({ async handleEvent(event) { received.push(semanticEventDedupKey(event)); } }),
  });
  t.after(async () => hooks.dispose());
  await waitForStartup(hooks);

  const event = hostEvent();
  hooks.event(structuredClone(event));
  hooks.event({ event: structuredClone(event) });
  hooks.event(hostEvent({ id: "event-2" }));
  hooks.event(hostEvent({ id: "event-3", properties: { ...event.properties, sessionID: "session-2", epoch: 4 } }));
  await settleDelivery();

  assert.equal(received.length, 3);
  assert.equal(new Set(received).size, 3);
});

test("duplicate factories coordinate semantic delivery across independent hook windows", async (t) => {
  const f = durableFixture(t);
  let calls = 0;
  const sharedIntegration = integration({ async handleEvent() { calls += 1; } });
  const options = { pipelineFactory: async () => sharedIntegration };
  const first = await SelfEvolvePlugin(f.ctx, options);
  const second = await SelfEvolvePlugin(f.ctx, options);
  t.after(async () => {
    await first.dispose();
    await second.dispose();
  });
  await Promise.all([waitForStartup(first), waitForStartup(second)]);

  first.event(hostEvent());
  second.event({ event: structuredClone(hostEvent()) });
  await settleDelivery();
  assert.equal(calls, 1);
});

test("duplicate factories deliver a new busy-to-idle episode within the replay window", async (t) => {
  const f = durableFixture(t);
  const received = [];
  const sharedIntegration = integration({
    async handleEvent(event) {
      received.push(event.type === "session.idle" ? "idle" : event.properties.status.type);
    },
  });
  const options = { now: () => 10_000, pipelineFactory: async () => sharedIntegration };
  const first = await SelfEvolvePlugin(f.ctx, options);
  const second = await SelfEvolvePlugin(f.ctx, options);
  t.after(async () => {
    await first.dispose();
    await second.dispose();
  });
  await Promise.all([waitForStartup(first), waitForStartup(second)]);

  const deliverToBoth = (event) => {
    first.event(structuredClone(event));
    second.event({ event: structuredClone(event) });
  };
  deliverToBoth(hostEvent({ id: undefined, properties: { sessionID: "episode-session" } }));
  deliverToBoth({
    type: "session.status",
    properties: { sessionID: "episode-session", status: { type: "busy" } },
  });
  deliverToBoth(hostEvent({ id: undefined, properties: { sessionID: "episode-session" } }));
  await settleDelivery();

  assert.deepEqual(received, ["idle", "busy", "idle"]);
});

test("queued delivery drops after dispose and queue saturation remains bounded", async (t) => {
  const disposedFixture = durableFixture(t);
  let disposedCalls = 0;
  const disposedHooks = await SelfEvolvePlugin(disposedFixture.ctx, {
    pipelineFactory: async () => integration({ async handleEvent() { disposedCalls += 1; } }),
  });
  await waitForStartup(disposedHooks);
  disposedHooks.event(hostEvent());
  await disposedHooks.dispose();
  await settleDelivery();
  assert.equal(disposedCalls, 0);

  const saturatedFixture = durableFixture(t);
  const diagnostics = [];
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const saturatedHooks = await SelfEvolvePlugin(saturatedFixture.ctx, {
    log: (entry) => diagnostics.push(entry),
    pipelineFactory: async () => integration({ async handleEvent() { calls += 1; await gate; } }),
  });
  t.after(async () => saturatedHooks.dispose());
  await waitForStartup(saturatedHooks);
  for (let index = 0; index < EVENT_DELIVERY_MAX_PENDING + 5; index += 1) {
    saturatedHooks.event(hostEvent({ id: `saturated-${index}` }));
  }
  await settleDelivery();
  assert.equal(calls, EVENT_DELIVERY_MAX_PENDING);
  assert.ok(diagnostics.some((entry) => entry.action === "event-delivery-saturated"));
  release();
  await settleDelivery();
});
