import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openStore } from "../self-evolve-store.js";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "fixtures", "bridge-server.mjs");
const CLIENT = path.join(HERE, "fixtures", "bridge-tui-client.mjs");
const CONTROL_CLIENT = path.join(HERE, "fixtures", "bridge-control-client.mjs");
const FLOOD_CLIENT = path.join(HERE, "fixtures", "bridge-flood-client.mjs");
const PROJECT = "e".repeat(64);

async function startServer(stateRoot, skillRoot) {
  const child = spawn(process.execPath, [SERVER, stateRoot, PROJECT, skillRoot], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`server-ready-timeout: ${stderr}`)), 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("READY\n")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("exit", (code) => reject(new Error(`server-exited-${code}: ${stderr}`)));
  });
  return child;
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function client(stateRoot, action, proposalId, replayFile) {
  const args = [CLIENT, stateRoot, PROJECT, action, proposalId];
  if (replayFile) args.push(replayFile);
  const { stdout } = await execFileAsync(process.execPath, args, { timeout: 10_000 });
  return JSON.parse(stdout.trim());
}

async function controlClient(stateRoot, operation, value = "", extra = "") {
  const { stdout } = await execFileAsync(process.execPath, [CONTROL_CLIENT, stateRoot, PROJECT, operation, value, extra], { timeout: 10_000 });
  return JSON.parse(stdout.trim());
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
  assert.equal((await controlClient(root, "mode", "yolo", skillRoot)).response.ok, true);
  for (const key of ["passiveCalls", "durableObservations", "sanitizedExcerpts", "crossRepoAggregation"]) {
    assert.equal((await controlClient(root, "consent", `${key}=true`)).response.ok, true, key);
  }
  assert.equal((await controlClient(root, "exclude", "true")).response.ok, true);
  assert.equal((await controlClient(root, "exclude", "false")).response.ok, true);
  const allowlist = await controlClient(root, "allowlist", secondRoot);
  assert.equal(allowlist.response.ok, true);
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
  store.close();

  server = await startServer(root, skillRoot);
  const afterRestart = await controlClient(root, "exclude", "true");
  assert.equal(afterRestart.state.mode, "yolo");
  assert.deepEqual(afterRestart.state.allowedSkillRoots, [secondRoot]);
  assert.equal(afterRestart.response.ok, true);
});

test("concurrent mailbox publishers cannot exceed the shared project file cap", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-bridge-flood-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = openStore(root, { projectFingerprint: PROJECT });
  t.after(() => store.close());

  const results = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
    const { stdout } = await execFileAsync(process.execPath, [FLOOD_CLIENT, root, PROJECT, `worker-${index}`, "40"], { timeout: 10_000 });
    return JSON.parse(stdout.trim());
  }));
  const requestDir = path.join(root, "self-evolve", "bridge", PROJECT, "requests");
  const published = fs.readdirSync(requestDir).filter((name) => name.endsWith(".json")).length;
  assert.equal(results.reduce((sum, result) => sum + result.published, 0), published);
  assert.ok(published > 0 && published <= 64);
  assert.ok(results.some((result) => result.rejected > 0));
  assert.doesNotThrow(() => store.writeSnapshot("after-flood.before", "store remains writable"));

  const skillRoot = path.join(root, "skills");
  fs.mkdirSync(skillRoot, { recursive: true });
  const server = await startServer(root, skillRoot);
  t.after(() => stopServer(server));
  const responseDir = path.join(root, "self-evolve", "bridge", PROJECT, "responses");
  for (let attempt = 0; attempt < 300 && fs.readdirSync(requestDir).length > 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.readdirSync(requestDir).length, 0);
  assert.ok(fs.readdirSync(responseDir).length > 0);
  assert.equal(fs.existsSync(path.join(root, "self-evolve", "bridge", PROJECT, "control-state.json")), true);
});
