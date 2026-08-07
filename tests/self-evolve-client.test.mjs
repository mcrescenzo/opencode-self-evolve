import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupSession,
  createSession,
  listSessions,
  promptSession,
  readSessionMessages,
} from "../self-evolve-client.js";

function context(session) {
  return { directory: "/workspace/project", client: { session } };
}

test("OpenCode client adapter uses 1.18.3 request shapes and normalizes responses", async () => {
  const calls = [];
  const ctx = context({
    async create(input) { calls.push(["create", input]); return { data: { id: "hidden" } }; },
    async messages(input) { calls.push(["messages", input]); return { data: { messages: [{ id: "one" }] } }; },
    async prompt(input) { calls.push(["prompt", input]); return { data: { parts: [{ type: "text", text: "ok" }] } }; },
    async list(input) { calls.push(["list", input]); return { data: { sessions: [{ id: "hidden" }] } }; },
    async abort(input) { calls.push(["abort", input]); return { data: {} }; },
  });
  assert.equal((await createSession(ctx, { title: "hidden" })).data.id, "hidden");
  assert.deepEqual(await readSessionMessages(ctx, "root", 10), [{ id: "one" }]);
  await promptSession(ctx, "hidden", { parts: [] });
  assert.deepEqual(await listSessions(ctx), [{ id: "hidden" }]);
  await cleanupSession(ctx, "hidden");
  assert.deepEqual(calls.map(([name]) => name), ["create", "messages", "prompt", "list", "abort"]);
  assert.deepEqual(calls[0][1], { body: { title: "hidden" }, query: { directory: "/workspace/project" } });
  assert.deepEqual(calls[1][1], { path: { id: "root" }, query: { directory: "/workspace/project", limit: 10 } });
});

test("read-only compatibility fallback occurs after rejection but never after timeout", async () => {
  const rejectedCalls = [];
  const rejected = context({
    async messages(input) {
      rejectedCalls.push(input);
      if (input.path?.id) return { error: { message: "unsupported shape" } };
      return { data: [{ id: "fallback" }] };
    },
  });
  assert.deepEqual(await readSessionMessages(rejected, "root", 5), [{ id: "fallback" }]);
  assert.equal(rejectedCalls.length, 2);

  const timeoutCalls = [];
  const timed = context({
    async messages(input) {
      timeoutCalls.push(input);
      return await new Promise(() => {});
    },
  });
  await assert.rejects(
    readSessionMessages(timed, "root", 5, { timeoutMs: 2 }),
    /session\.messages timed out/u,
  );
  assert.equal(timeoutCalls.length, 1);
});

test("session mutations use one request shape and preserve permissions on host errors", async (t) => {
  const permission = [{ permission: "*", pattern: "*", action: "deny" }];
  const failures = [
    ["auth", async () => { throw new Error("authentication failed"); }, /authentication failed/u],
    ["transport", async () => { throw new Error("transport failed"); }, /transport failed/u],
    ["provider", async () => ({ error: { message: "provider failed" } }), /provider failed/u],
    ["result", async () => ({ error: { message: "result failed" } }), /result failed/u],
  ];

  for (const [name, fail, expected] of failures) {
    await t.test(`create ${name} error invokes once`, async () => {
      const calls = [];
      const ctx = context({
        async create(input) { calls.push(input); return fail(); },
      });
      const body = { title: "hidden", permission };
      await assert.rejects(createSession(ctx, body), expected);
      assert.deepEqual(calls, [{ body, query: { directory: "/workspace/project" } }]);
      assert.strictEqual(calls[0].body.permission, permission);
    });

    await t.test(`prompt ${name} error invokes once`, async () => {
      const calls = [];
      const ctx = context({
        async prompt(input) { calls.push(input); return fail(); },
      });
      const body = { parts: [], permission };
      await assert.rejects(promptSession(ctx, "hidden", body), expected);
      assert.deepEqual(calls, [{
        path: { id: "hidden" },
        query: { directory: "/workspace/project" },
        body,
      }]);
      assert.strictEqual(calls[0].body.permission, permission);
    });
  }
});

test("hanging prompt and cleanup are bounded and late rejection is handled", async () => {
  let rejectLate;
  const prompt = new Promise((_, reject) => { rejectLate = reject; });
  const ctx = context({
    async prompt() { return await prompt; },
    async abort() { return await new Promise(() => {}); },
  });
  await assert.rejects(promptSession(ctx, "hidden", {}, { timeoutMs: 2 }), /timed out/u);
  rejectLate(new Error("late prompt rejection"));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(cleanupSession(ctx, "hidden", { timeoutMs: 2 }), /timed out/u);
});

test("cancelled session creation is terminal and cleans a late-created orphan", async () => {
  const controller = new AbortController();
  let resolveCreate;
  const created = new Promise((resolve) => { resolveCreate = resolve; });
  const cleaned = [];
  const ctx = context({ async create() { return await created; } });
  const pending = createSession(ctx, { title: "hidden" }, {
    timeoutMs: 1_000,
    signal: controller.signal,
    onLateResolve(result) { cleaned.push(result.data.id); },
  });
  controller.abort();
  await assert.rejects(pending, /cancelled/u);
  resolveCreate({ data: { id: "late-hidden" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cleaned, ["late-hidden"]);
});

test("cleanup falls back to interrupt only when abort is unavailable", async () => {
  const calls = [];
  const ctx = context({
    async interrupt(input) { calls.push(input); return { data: {} }; },
  });
  await cleanupSession(ctx, "hidden");
  assert.deepEqual(calls, [{ path: { id: "hidden" }, query: { directory: "/workspace/project" } }]);
});

test("known-session cleanup is bounded and does not retry host errors", async () => {
  const calls = [];
  const ctx = context({
    async abort(input) {
      calls.push(input);
      return { error: { message: "abort rejected" } };
    },
  });
  await assert.rejects(cleanupSession(ctx, "hidden", { timeoutMs: 20 }), /abort rejected/u);
  assert.deepEqual(calls, [{ path: { id: "hidden" }, query: { directory: "/workspace/project" } }]);
});

test("readSessionMessages treats a non-positive or invalid limit as zero and never returns the whole transcript", async () => {
  const ctx = context({
    async messages() { return { data: { messages: [{ id: "one" }, { id: "two" }, { id: "three" }] } }; },
  });
  assert.deepEqual(await readSessionMessages(ctx, "root", 0), []);
  assert.deepEqual(await readSessionMessages(ctx, "root", -2), []);
  assert.deepEqual(await readSessionMessages(ctx, "root", 1.7), []);
  assert.deepEqual(await readSessionMessages(ctx, "root", 2), [{ id: "two" }, { id: "three" }]);
});
