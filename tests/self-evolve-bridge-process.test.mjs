import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { openStore } from "../self-evolve-store.js";
import {
  consumeDecisionRequests,
  createDecisionRequest,
  pollDecisionResponse,
} from "../self-evolve-bridge.js";
import { SCHEMA_VERSION } from "../self-evolve-schemas.js";

const execFileAsync = promisify(execFile);
const HERE = import.meta.dirname;
const SERVER = path.join(HERE, "fixtures", "bridge-server.mjs");
const CLIENT = path.join(HERE, "fixtures", "bridge-tui-client.mjs");
const CONTROL_CLIENT = path.join(HERE, "fixtures", "bridge-control-client.mjs");
const FLOOD_CLIENT = path.join(HERE, "fixtures", "bridge-flood-client.mjs");
const HARDLINK_CRASH = path.join(HERE, "fixtures", "bridge-hardlink-crash.mjs");
const PROJECT = "e".repeat(64);
let resultOrdinal = 0;

function resultFile(stateRoot, label) {
  resultOrdinal += 1;
  return path.join(stateRoot, `.${label}-${process.pid}-${resultOrdinal}.json`);
}

async function startServer(stateRoot, skillRoot) {
  const readyFile = resultFile(stateRoot, "bridge-server-ready");
  const child = spawn(process.execPath, [SERVER, stateRoot, PROJECT, skillRoot, readyFile], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (fs.existsSync(readyFile)) {
        clearInterval(poll);
        fs.rmSync(readyFile, { force: true });
        resolve();
      } else if (Date.now() - started >= 5_000) {
        clearInterval(poll);
        child.kill("SIGTERM");
        reject(new Error(`server-ready-timeout: ${stderr}`));
      }
    }, 10);
    poll.unref?.();
    child.once("exit", (code) => {
      clearInterval(poll);
      reject(new Error(`server-exited-${code}: ${stderr}`));
    });
  });
  return child;
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function client(stateRoot, action, proposalId, replayFile) {
  const output = resultFile(stateRoot, "bridge-client");
  const args = [CLIENT, stateRoot, PROJECT, action, proposalId, replayFile ?? "", output];
  await execFileAsync(process.execPath, args, { timeout: 10_000 });
  const result = JSON.parse(fs.readFileSync(output, "utf8"));
  fs.rmSync(output, { force: true });
  return result;
}

async function controlClient(stateRoot, operation, value = "", extra = "") {
  const output = resultFile(stateRoot, "control-client");
  await execFileAsync(process.execPath, [CONTROL_CLIENT, stateRoot, PROJECT, operation, value, extra, output], { timeout: 10_000 });
  const result = JSON.parse(fs.readFileSync(output, "utf8"));
  fs.rmSync(output, { force: true });
  return result;
}

test("production filesystem path works across processes, restart, replay, and cleanup", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-bridge-process-"));
  const skillRoot = path.join(root, "skills");
  fs.mkdirSync(skillRoot, { recursive: true });
  let server = await startServer(root, skillRoot);
  t.after(async () => {
    await stopServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const applied = await client(root, "apply", "proposal-apply");
  assert.equal(applied.response.ok, true);
  assert.equal(applied.requestMode, 0o600);
  assert.equal(applied.responseMode, 0o600);
  assert.equal("proposedContent" in applied.request, false);
  assert.equal(applied.inbox.find((item) => item.id === "proposal-apply").state, "applied");

  const replayPath = path.join(root, "replay.json");
  fs.writeFileSync(replayPath, JSON.stringify(applied.request), { mode: 0o600 });
  const replay = await client(root, "replay", "proposal-apply", replayPath);
  assert.equal(replay.response.ok, false);
  assert.match(replay.response.reason, /nonce|stale|replay|binding/u);

  await stopServer(server);
  server = await startServer(root, skillRoot);
  const rolledBack = await client(root, "undo", "proposal-apply");
  assert.equal(rolledBack.response.ok, true);
  assert.equal(rolledBack.inbox.some((item) => item.id === "proposal-apply"), false);

  const rejected = await client(root, "reject", "proposal-reject");
  assert.equal(rejected.response.ok, true);
  assert.equal(rejected.inbox.some((item) => item.id === "proposal-reject"), false);

  await stopServer(server);
  const store = openStore(root, { projectFingerprint: PROJECT });
  assert.equal(store.getRecord("proposal", "proposal-apply").payload.state, "rolled-back");
  assert.equal(store.getRecord("proposal", "proposal-reject").payload.state, "rejected");
  assert.equal(store.readRecords("decision").filter((record) => record.payload.proposalId === "proposal-apply" && record.payload.newState === "approved").length, 1);
  store.close();

  const bridgeRoot = path.join(root, "self-evolve", "bridge", PROJECT);
  assert.equal(fs.existsSync(path.join(bridgeRoot, "consumer.lock")), false);
  assert.equal(fs.readdirSync(path.join(bridgeRoot, "requests")).length, 0);
});

test("a process death after hard-link publication recovers the request and response exactly once", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-bridge-hardlink-crash-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const timestamp = Date.now();
  const request = createDecisionRequest({
    projectFingerprint: PROJECT,
    proposal: {
      id: "process-crash-proposal",
      skillTarget: { currentHash: "a".repeat(64) },
      proposedContentHash: "b".repeat(64),
      decisionVersion: 0,
      state: "pending",
      decisionNonce: "process-crash-nonce",
    },
    newState: "rejected",
    timestamp,
    requestId: "process-crash-request",
  });
  const bridgeRoot = path.join(root, "self-evolve", "bridge", PROJECT);
  const requestDirectory = path.join(bridgeRoot, "requests");
  const responseDirectory = path.join(bridgeRoot, "responses");
  fs.mkdirSync(requestDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(responseDirectory, { recursive: true, mode: 0o700 });
  for (const directory of ["control-requests", "control-responses", "operation-requests", "operation-responses"]) {
    fs.mkdirSync(path.join(bridgeRoot, directory), { mode: 0o700 });
  }
  const requestSource = path.join(root, "request-source.json");
  const requestPath = path.join(requestDirectory, `${request.requestId}.json`);
  fs.writeFileSync(requestSource, `${JSON.stringify(request)}\n`, { mode: 0o600 });
  await assert.rejects(
    execFileAsync(process.execPath, [HARDLINK_CRASH, requestPath, requestSource]),
    (error) => error.code === 86,
  );
  const requestTemp = fs.readdirSync(requestDirectory).find((name) => name.endsWith(".tmp"));
  assert.equal(fs.statSync(requestPath).nlink, 2);

  let effects = 0;
  const first = await consumeDecisionRequests({
    stateRoot: root,
    projectFingerprint: PROJECT,
    now: () => timestamp,
    validateAndDecide: async () => { effects += 1; return { ok: true }; },
  });
  assert.equal(first.processed.length, 1);
  assert.equal(effects, 1);
  assert.equal(fs.existsSync(path.join(requestDirectory, requestTemp)), false);

  const responsePath = path.join(responseDirectory, `${request.requestId}.json`);
  const response = pollDecisionResponse(root, PROJECT, request.requestId);
  const responseSource = path.join(root, "response-source.json");
  fs.unlinkSync(responsePath);
  fs.writeFileSync(responseSource, `${JSON.stringify({
    ...response,
    schemaVersion: SCHEMA_VERSION,
  })}\n`, { mode: 0o600 });
  fs.writeFileSync(requestPath, `${JSON.stringify(request)}\n`, { mode: 0o600, flag: "wx" });
  await assert.rejects(
    execFileAsync(process.execPath, [HARDLINK_CRASH, responsePath, responseSource]),
    (error) => error.code === 86,
  );
  const responseTemp = fs.readdirSync(responseDirectory).find((name) => name.endsWith(".tmp"));
  assert.equal(fs.statSync(responsePath).nlink, 2);

  const recovered = await consumeDecisionRequests({
    stateRoot: root,
    projectFingerprint: PROJECT,
    now: () => timestamp,
    validateAndDecide: async () => { effects += 1; return { ok: true }; },
  });
  assert.equal(recovered.processed.length, 1);
  assert.equal(effects, 1);
  assert.equal(fs.existsSync(requestPath), false);
  assert.equal(fs.existsSync(path.join(responseDirectory, responseTemp)), false);
  assert.equal(fs.statSync(responsePath).nlink, 1);
});

test("fresh TUI clients use authenticated server controls and persist every allowlisted setting", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-control-process-"));
  const skillRoot = path.join(root, "skills");
  const secondRoot = path.join(root, "other-skills");
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.mkdirSync(secondRoot, { recursive: true });
  let server = await startServer(root, skillRoot);
  t.after(async () => {
    await stopServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.equal((await controlClient(root, "mode", "manual")).response.ok, true);
  assert.equal((await controlClient(root, "mode", "auto")).response.ok, true);
  for (const key of ["passiveCalls", "durableObservations", "sanitizedExcerpts", "crossRepoAggregation"]) {
    assert.equal((await controlClient(root, "consent", `${key}=true`)).response.ok, true, key);
  }
  const yolo = await controlClient(root, "mode", "yolo", skillRoot);
  assert.equal(yolo.response.ok, true, yolo.response.reason);
  assert.equal((await controlClient(root, "exclude", "true")).response.ok, true);
  assert.equal((await controlClient(root, "exclude", "false")).response.ok, true);
  assert.equal((await controlClient(root, "repo-mode", "auto")).response.ok, true);
  assert.equal((await controlClient(root, "repo-mode", "inherit")).response.ok, true);
  const allowlist = await controlClient(root, "allowlist", secondRoot);
  assert.equal(allowlist.response.ok, true, allowlist.response.reason);
  assert.deepEqual(allowlist.next.allowedSkillRoots, [secondRoot]);

  assert.equal((await controlClient(root, "consent", "crossRepoAggregation=false")).response.ok, true);
  assert.equal((await controlClient(root, "consent", "sanitizedExcerpts=false")).response.ok, true);
  assert.equal((await controlClient(root, "consent", "passiveCalls=false")).response.ok, true);
  assert.equal((await controlClient(root, "consent", "durableObservations=false")).response.ok, true);

  const replayPath = path.join(root, "control-replay.json");
  fs.writeFileSync(replayPath, JSON.stringify(allowlist.request), { mode: 0o600 });
  const replay = await controlClient(root, "replay", "", replayPath);
  assert.equal(replay.response.ok, false);
  assert.match(replay.response.reason, /replay|nonce/u);

  const current = replay.next ?? allowlist.next;
  const rawCases = [
    { requestId: "raw-stale", settingsUpdatedAt: current.settingsUpdatedAt + 1 },
    { requestId: "raw-cross", projectFingerprint: "f".repeat(64) },
    { requestId: "raw-unknown", action: "run-command", payload: {} },
    { requestId: "raw-malformed", action: "update-allowlist", payload: { allowlist: [skillRoot] } },
  ];
  for (const changes of rawCases) {
    const rawPath = path.join(root, `${changes.requestId}.json`);
    const raw = {
      schemaVersion: current.schemaVersion,
      requestId: changes.requestId,
      projectFingerprint: PROJECT,
      actor: "self-evolve-tui",
      timestamp: Date.now(),
      settingsUpdatedAt: current.settingsUpdatedAt,
      settingsVersion: current.settingsVersion,
      nonce: current.nonce,
      action: "set-mode",
      payload: { mode: "manual" },
      ...changes,
    };
    fs.writeFileSync(rawPath, JSON.stringify(raw), { mode: 0o600 });
    const rejected = await controlClient(root, "raw", "", rawPath);
    assert.equal(rejected.response.ok, false, changes.requestId);
  }

  await stopServer(server);
  const store = openStore(root, { projectFingerprint: PROJECT });
  const settings = store.getSettings();
  assert.equal(settings.global.mode, "yolo");
  assert.deepEqual(settings.global.allowedSkillRoots, [secondRoot]);
  assert.deepEqual(settings.global.consent, { passiveCalls: false, durableObservations: false, sanitizedExcerpts: false, crossRepoAggregation: false });
  assert.equal(settings.repo.excluded, false);
  assert.equal(settings.repo.mode, "inherit");
  store.close();

  server = await startServer(root, skillRoot);
  const afterRestart = await controlClient(root, "exclude", "true");
  assert.equal(afterRestart.state.mode, "yolo");
  assert.deepEqual(afterRestart.state.allowedSkillRoots, [secondRoot]);
  assert.equal(afterRestart.response.ok, true);
});

test("concurrent mailbox publishers cannot exceed the shared project file cap", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-bridge-flood-"));
  const store = openStore(root, { projectFingerprint: PROJECT });
  let server;
  t.after(async () => {
    try {
      if (server) await stopServer(server);
    } finally {
      try { store.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
  });

  const results = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
    const output = resultFile(root, `flood-client-${index}`);
    await execFileAsync(process.execPath, [FLOOD_CLIENT, root, PROJECT, `worker-${index}`, "40", output], { timeout: 10_000 });
    return JSON.parse(fs.readFileSync(output, "utf8"));
  }));
  const requestDir = path.join(root, "self-evolve", "bridge", PROJECT, "requests");
  const published = fs.readdirSync(requestDir).filter((name) => name.endsWith(".json")).length;
  assert.equal(results.reduce((sum, result) => sum + result.published, 0), published);
  assert.ok(published > 0 && published <= 64);
  assert.ok(results.some((result) => result.rejected > 0));
  assert.doesNotThrow(() => store.writeSnapshot("after-flood.before", "store remains writable"));

  const skillRoot = path.join(root, "skills");
  fs.mkdirSync(skillRoot, { recursive: true });
  server = await startServer(root, skillRoot);
  const responseDir = path.join(root, "self-evolve", "bridge", PROJECT, "responses");
  for (let attempt = 0; attempt < 300 && fs.readdirSync(requestDir).length > 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.readdirSync(requestDir).length, 0);
  assert.ok(fs.readdirSync(responseDir).length > 0);
  assert.equal(fs.existsSync(path.join(root, "self-evolve", "bridge", PROJECT, "control-state.json")), true);
});
