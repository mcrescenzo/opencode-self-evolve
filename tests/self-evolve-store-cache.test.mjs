import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeAuditEvent, wrapRecord } from "../self-evolve-schemas.js";
import { openStore } from "../self-evolve-store.js";

const PROJECT = "a".repeat(64);
const WRITER = path.join(import.meta.dirname, "fixtures", "store-cache-writer.mjs");
const FIXED_TIME = 1_700_000_000_000;

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function auditRecord(index) {
  const sessionIDHash = BigInt(index).toString(16).padStart(64, "0");
  const details = { action: "session-status", sessionIDHash, status: "retry", epoch: 1 };
  const event = makeAuditEvent({
    id: hash(`cache-writer:${sessionIDHash}`),
    kind: "decision",
    actor: "self-evolve-scheduler",
    timestamp: 1_000,
    payloadHash: hash(JSON.stringify(details)),
    details,
  });
  return wrapRecord("audit-event", event, 1_000);
}

function sourceFor(index) {
  return `${JSON.stringify(auditRecord(index))}\n`;
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-store-cache-"));
  const store = openStore(root, {
    projectName: "cache-test",
    projectFingerprint: PROJECT,
    now: () => 2_000,
  });
  t.after(() => {
    try { store.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return { root, store, auditPath: path.join(store.stateDir, "audit.jsonl") };
}

function waitForFile(filePath, timeoutMs = 10_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (existsSync(filePath)) return resolve(JSON.parse(readFileSync(filePath, "utf8")));
      if (Date.now() - started >= timeoutMs) return reject(new Error(`timed-out-waiting-for:${path.basename(filePath)}`));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function childCompletion(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`store-cache-writer-exit-${code}:${stderr}`)));
  });
}

function runWriter(args) {
  const child = spawn(process.execPath, [WRITER, ...args], { stdio: ["ignore", "ignore", "pipe"] });
  return { child, completion: childCompletion(child) };
}

test("source-byte identity observes every stable equal-length cross-process replacement", { timeout: 15_000 }, async (t) => {
  const { root, store, auditPath } = fixture(t);
  assert.equal(Buffer.byteLength(sourceFor(0)), Buffer.byteLength(sourceFor(1)));
  assert.equal(store.appendRecord(auditRecord(0)).ok, true);
  assert.equal(store.readRecords("audit-event")[0].id, auditRecord(0).id);
  utimesSync(auditPath, new Date(FIXED_TIME), new Date(FIXED_TIME));
  assert.equal(store.readRecords("audit-event")[0].id, auditRecord(0).id);

  const readyPath = path.join(root, "writer-ready.json");
  const stopPath = path.join(root, "writer-stop");
  const resultPath = path.join(root, "writer-result.json");
  const running = runWriter(["race", auditPath, PROJECT, readyPath, stopPath, resultPath, String(FIXED_TIME)]);
  t.after(() => {
    try { writeFileSync(stopPath, "stop", { mode: 0o600 }); } catch {}
    if (running.child.exitCode === null) running.child.kill("SIGKILL");
  });
  await waitForFile(readyPath);

  const deadline = Date.now() + 3_100;
  let stableComparisons = 0;
  while (Date.now() < deadline) {
    const before = readFileSync(auditPath, "utf8");
    const records = store.readRecords("audit-event");
    const after = readFileSync(auditPath, "utf8");
    if (before !== after) continue;
    stableComparisons += 1;
    assert.equal(records.length, 1);
    assert.equal(records[0].id, JSON.parse(after.trim()).id);
  }
  writeFileSync(stopPath, "stop", { mode: 0o600 });
  await running.completion;
  const outcome = await waitForFile(resultPath);
  assert.equal(outcome.ok, true);
  assert.ok(outcome.writes > 10);
  assert.ok(stableComparisons > 10);
});

test("a stat-token cache is provably unsafe on this filesystem — do not substitute it for source-byte identity", async (t) => {
  const { root, store, auditPath } = fixture(t);
  assert.equal(store.appendRecord(auditRecord(0)).ok, true);
  const cachedSource = readFileSync(auditPath, "utf8");
  utimesSync(auditPath, new Date(FIXED_TIME), new Date(FIXED_TIME));
  assert.equal(store.readRecords("audit-event")[0].id, auditRecord(0).id);
  const baseline = statSync(auditPath, { bigint: true });
  const resultPath = path.join(root, "collision-result.json");
  const running = runWriter([
    "collide",
    auditPath,
    PROJECT,
    resultPath,
    String(baseline.dev),
    String(baseline.ino),
    String(baseline.size),
    String(Number(baseline.mtimeMs)),
  ]);
  await running.completion;
  const outcome = await waitForFile(resultPath);
  if (!outcome.matched) {
    t.skip(`filesystem did not reuse the complete stat token after ${outcome.writes} atomic replacements`);
    return;
  }

  const current = statSync(auditPath, { bigint: true });
  assert.deepEqual(
    [current.dev, current.ino, current.size, Number(current.mtimeMs)],
    [baseline.dev, baseline.ino, baseline.size, Number(baseline.mtimeMs)],
  );
  const actualSource = readFileSync(auditPath, "utf8");
  assert.notEqual(actualSource, cachedSource);
  const statTokenCacheResult = cachedSource;
  assert.notEqual(statTokenCacheResult, actualSource, "the forbidden stat-token cache serves stale bytes");
  assert.equal(store.readRecords("audit-event")[0].id, JSON.parse(actualSource.trim()).id);
});

test("separate store instances and a real child append are immediately fresh", async (t) => {
  const { root, store } = fixture(t);
  const second = openStore(root, { projectName: "cache-test", projectFingerprint: PROJECT, now: () => 2_000 });
  t.after(() => {
    try { second.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  assert.equal(store.appendRecord(auditRecord(1)).ok, true);
  assert.deepEqual(second.readRecords("audit-event").map((record) => record.id), [auditRecord(1).id]);

  const resultPath = path.join(root, "append-result.json");
  const running = runWriter(["append", root, PROJECT, resultPath, "2"]);
  await running.completion;
  assert.equal((await waitForFile(resultPath)).ok, true);
  assert.deepEqual(second.readRecords("audit-event").map((record) => record.id), [auditRecord(1).id, auditRecord(2).id]);
});

test("cache lifetime is store-scoped and a reopened store reparses current bytes", async (t) => {
  const { root, store } = fixture(t);
  assert.equal(store.appendRecord(auditRecord(1)).ok, true);
  assert.equal(store.readRecords("audit-event").length, 1);
  assert.equal(store.close().ok, true);

  const resultPath = path.join(root, "reopen-result.json");
  const running = runWriter(["append", root, PROJECT, resultPath, "2"]);
  await running.completion;
  assert.equal((await waitForFile(resultPath)).ok, true);

  const reopened = openStore(root, { projectName: "cache-test", projectFingerprint: PROJECT, now: () => 2_000 });
  t.after(() => {
    try { reopened.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  assert.deepEqual(reopened.readRecords("audit-event").map((record) => record.id), [auditRecord(1).id, auditRecord(2).id]);
});
