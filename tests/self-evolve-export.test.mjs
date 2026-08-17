import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createSensitiveExportManager,
  readLatestSensitiveExport,
} from "../self-evolve-export.js";
import { openStore } from "../self-evolve-store.js";

const PROJECT = "a".repeat(64);

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-export-"));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("sensitive export streams to one private artifact and publishes bounded metadata", (t) => {
  const root = fixture(t);
  const manager = createSensitiveExportManager({
    stateRoot: root,
    projectFingerprint: PROJECT,
    now: () => 1_000,
  });
  const result = manager.run({
    scope: "project",
    archive: {
      schemaVersion: 2,
      projectFingerprint: PROJECT,
      records: [{ kind: "observation", payload: { summary: "sanitized" } }],
      snapshots: [{ classification: "sensitive-skill-snapshot" }],
    },
  });
  assert.equal(result.ok, true);
  const source = readFileSync(result.path);
  assert.equal(lstatSync(result.path).mode & 0o777, 0o600);
  assert.equal(source.length, result.bytes);
  assert.equal(createHash("sha256").update(source).digest("hex"), result.sha256);
  assert.match(source.toString("utf8"), /sensitive-self-evolve-archive/u);
  assert.deepEqual(readLatestSensitiveExport({
    stateRoot: root,
    projectFingerprint: PROJECT,
    now: 1_001,
  }), result);
  assert.equal(readdirSync(manager.root).some((name) => name.endsWith(".tmp")), false);
  assert.equal(existsSync(path.join(manager.root, "active.lock")), false);
});

test("size failure removes temporary state and stale artifacts are cleaned", (t) => {
  const root = fixture(t);
  let timestamp = 2_000;
  const manager = createSensitiveExportManager({
    stateRoot: root,
    projectFingerprint: PROJECT,
    now: () => timestamp,
    ttlMs: 100,
    maxArtifactBytes: 128,
  });
  const failed = manager.run({
    scope: "observations",
    archive: { records: [{ payload: { summary: "x".repeat(512) } }] },
  });
  assert.deepEqual(failed, { ok: false, reason: "export-size-exceeded" });
  assert.deepEqual(readdirSync(manager.root), []);

  const second = createSensitiveExportManager({
    stateRoot: root,
    projectFingerprint: PROJECT,
    now: () => timestamp,
    ttlMs: 100,
  });
  const saved = second.run({ scope: "proposals", archive: { records: [] } });
  assert.equal(saved.ok, true);
  timestamp = 2_101;
  assert.equal(second.cleanup().removed >= 2, true);
  assert.equal(readLatestSensitiveExport({
    stateRoot: root,
    projectFingerprint: PROJECT,
    now: timestamp,
  }), null);
});

test("artifact admission includes the final newline at exact byte boundaries", (t) => {
  const archive = { records: [] };
  const baselineRoot = fixture(t);
  const baseline = createSensitiveExportManager({
    stateRoot: baselineRoot,
    projectFingerprint: PROJECT,
    now: () => 2_200,
  }).run({ scope: "project", archive });
  assert.equal(baseline.ok, true);
  assert.equal(readFileSync(baseline.path).at(-1), 0x0a);

  const exactRoot = fixture(t);
  const exactManager = createSensitiveExportManager({
    stateRoot: exactRoot,
    projectFingerprint: PROJECT,
    now: () => 2_200,
    maxArtifactBytes: baseline.bytes,
  });
  assert.equal(exactManager.run({ scope: "project", archive }).ok, true);

  const exceededRoot = fixture(t);
  const exceededManager = createSensitiveExportManager({
    stateRoot: exceededRoot,
    projectFingerprint: PROJECT,
    now: () => 2_200,
    maxArtifactBytes: baseline.bytes - 1,
  });
  assert.deepEqual(exceededManager.run({ scope: "project", archive }), {
    ok: false,
    reason: "export-size-exceeded",
  });
  assert.deepEqual(readdirSync(exceededManager.root), []);
});

test("aggregate quota admits owned temp, one artifact representation, and metadata exactly once", (t) => {
  const archive = { records: [] };
  const timestamp = 2_300;
  const occupiedSource = "occupied";
  const occupiedBytes = Buffer.byteLength(occupiedSource);
  const baselineRoot = fixture(t);
  const baseline = createSensitiveExportManager({
    stateRoot: baselineRoot,
    projectFingerprint: PROJECT,
    now: () => timestamp,
  }).run({ scope: "project", archive });
  assert.equal(baseline.ok, true);
  const aggregateBytes = occupiedBytes + baseline.bytes + lstatSync(`${baseline.path}.meta.json`).size;

  const exactRoot = fixture(t);
  const exactManager = createSensitiveExportManager({
    stateRoot: exactRoot,
    projectFingerprint: PROJECT,
    now: () => timestamp,
    temporaryQuotaBytes: aggregateBytes,
  });
  const exactOccupiedPath = path.join(exactManager.root, `.${timestamp}-${process.pid}-${"e".repeat(32)}-occupied.json.tmp`);
  writeFileSync(exactOccupiedPath, occupiedSource, { mode: 0o600 });
  assert.equal(exactManager.run({ scope: "project", archive }).ok, true);

  const exceededRoot = fixture(t);
  const exceededManager = createSensitiveExportManager({
    stateRoot: exceededRoot,
    projectFingerprint: PROJECT,
    now: () => timestamp,
    temporaryQuotaBytes: aggregateBytes - 1,
  });
  const exceededOccupiedPath = path.join(exceededManager.root, `.${timestamp}-${process.pid}-${"e".repeat(32)}-occupied.json.tmp`);
  writeFileSync(exceededOccupiedPath, occupiedSource, { mode: 0o600 });
  assert.deepEqual(exceededManager.run({ scope: "project", archive }), {
    ok: false,
    reason: "export-temporary-quota-exceeded",
  });
  assert.deepEqual(readdirSync(exceededManager.root), [path.basename(exceededOccupiedPath)]);
});

test("a post-publication failure removes the sensitive artifact before reporting failure", (t) => {
  const root = fixture(t);
  const manager = createSensitiveExportManager({
    stateRoot: root,
    projectFingerprint: PROJECT,
    now: () => 2_500,
    faultInjection(stage) {
      if (stage === "export-after-publication") throw new Error("injected-metadata-failure");
    },
  });
  assert.deepEqual(manager.run({ scope: "all", archive: { records: [] } }), {
    ok: false,
    reason: "injected-metadata-failure",
  });
  assert.deepEqual(readdirSync(manager.root), []);
});

test("concurrent cleanup preserves an expired live owner's lock and temporary file", (t) => {
  const root = fixture(t);
  let timestamp = 3_000;
  let competingManager;
  let foreignTemporaryPath;
  const manager = createSensitiveExportManager({
    stateRoot: root,
    projectFingerprint: PROJECT,
    now: () => timestamp,
    ttlMs: 100,
    processIsAlive: (pid) => pid === process.pid,
    faultInjection(stage) {
      if (stage !== "export-after-temporary-open") return;
      timestamp = 3_101;
      competingManager = createSensitiveExportManager({
        stateRoot: root,
        projectFingerprint: PROJECT,
        now: () => timestamp,
        ttlMs: 100,
        processIsAlive: (pid) => pid === process.pid,
      });
      assert.equal(competingManager.cleanup().removed, 0);
      assert.equal(readdirSync(manager.root).filter((name) => name.endsWith(".tmp")).length, 1);
      assert.equal(existsSync(path.join(manager.root, "active.lock")), true);
      foreignTemporaryPath = path.join(manager.root, `.3000-${process.pid}-${"d".repeat(32)}-foreign.json.tmp`);
      writeFileSync(foreignTemporaryPath, "foreign", { mode: 0o600 });
    },
  });

  assert.equal(manager.run({ scope: "project", archive: { records: [] } }).ok, true);
  assert.ok(competingManager);
  assert.equal(existsSync(path.join(manager.root, "active.lock")), false);
  assert.equal(existsSync(foreignTemporaryPath), true);
});

test("purge refuses a live export owner without removing its lock or temporary file", (t) => {
  const root = fixture(t);
  let competingManager;
  const manager = createSensitiveExportManager({
    stateRoot: root,
    projectFingerprint: PROJECT,
    now: () => 3_500,
    faultInjection(stage, { temporaryPath } = {}) {
      if (stage !== "export-after-temporary-open") return;
      competingManager = createSensitiveExportManager({ stateRoot: root, projectFingerprint: PROJECT, now: () => 3_500 });
      assert.throws(() => competingManager.purge(), /export-job-active/u);
      assert.equal(existsSync(path.join(manager.root, "active.lock")), true);
      assert.equal(existsSync(temporaryPath), true);
    },
  });

  assert.equal(manager.run({ scope: "project", archive: { records: [] } }).ok, true);
  assert.ok(competingManager);
  assert.equal(competingManager.purge().ok, true);
  assert.equal(existsSync(manager.root), false);
});

test("expired ownership is recovered only with conservative dead-owner proof", (t) => {
  const root = fixture(t);
  const manager = createSensitiveExportManager({ stateRoot: root, projectFingerprint: PROJECT, now: () => 4_000 });
  const lockPath = path.join(manager.root, "active.lock");
  const nonce = "b".repeat(32);
  const temporaryPath = path.join(manager.root, `.3900-424242-${nonce}-artifact.json.tmp`);
  writeFileSync(lockPath, `${JSON.stringify({ pid: 424242, issuedAt: 3_900, expiresAt: 3_999, nonce })}\n`, { mode: 0o600 });
  writeFileSync(temporaryPath, "private", { mode: 0o600 });

  const uncertain = createSensitiveExportManager({
    stateRoot: root,
    projectFingerprint: PROJECT,
    now: () => 4_000,
    ttlMs: 100,
    processIsAlive: () => true,
  });
  assert.equal(uncertain.cleanup().removed, 0);
  assert.equal(existsSync(lockPath), true);
  assert.equal(existsSync(temporaryPath), true);

  const recovered = createSensitiveExportManager({
    stateRoot: root,
    projectFingerprint: PROJECT,
    now: () => 4_000,
    ttlMs: 100,
    processIsAlive: () => false,
  });
  assert.equal(existsSync(lockPath), false);
  assert.equal(existsSync(temporaryPath), false);
  assert.equal(recovered.cleanup().removed, 0);
});

test("release is nonce-bound and failure cleanup removes only owned files", (t) => {
  const root = fixture(t);
  let foreignTemporaryPath;
  const manager = createSensitiveExportManager({
    stateRoot: root,
    projectFingerprint: PROJECT,
    now: () => 5_000,
    faultInjection(stage) {
      if (stage !== "export-after-publication") return;
      const lockPath = path.join(manager.root, "active.lock");
      writeFileSync(lockPath, `${JSON.stringify({
        pid: process.pid,
        issuedAt: 5_000,
        expiresAt: 6_000,
        nonce: "c".repeat(32),
      })}\n`, { mode: 0o600 });
      foreignTemporaryPath = path.join(manager.root, `.5000-${process.pid}-${"c".repeat(32)}-foreign.json.tmp`);
      writeFileSync(foreignTemporaryPath, "foreign", { mode: 0o600 });
      throw new Error("injected-owner-loss");
    },
  });

  assert.deepEqual(manager.run({ scope: "all", archive: { records: [] } }), {
    ok: false,
    reason: "injected-owner-loss",
  });
  assert.equal(existsSync(path.join(manager.root, "active.lock")), true);
  assert.equal(existsSync(foreignTemporaryPath), true);
  assert.equal(readdirSync(manager.root).some((name) => name.endsWith(".json") && !name.endsWith(".meta.json")), false);
});

test("store purge removes sensitive artifacts for every data scope", (t) => {
  for (const scope of ["observations", "proposals", "global-recommendations", "project", "all"]) {
    const root = fixture(t);
    const store = openStore(root, { projectFingerprint: PROJECT, projectName: "export-purge" });
    const manager = createSensitiveExportManager({ stateRoot: root, projectFingerprint: PROJECT });
    const saved = manager.run({ scope: "project", archive: { records: [] } });
    assert.equal(saved.ok, true);
    assert.equal(store.purge({ scope }).ok, true);
    assert.equal(existsSync(manager.root), false, scope);
  }
});

test("foreign or permissive export artifacts fail closed", (t) => {
  const root = fixture(t);
  const manager = createSensitiveExportManager({ stateRoot: root, projectFingerprint: PROJECT });
  const invalid = path.join(manager.root, "invalid.json.meta.json");
  writeFileSync(invalid, "{}\n", { mode: 0o644 });
  assert.throws(() => readLatestSensitiveExport({
    stateRoot: root,
    projectFingerprint: PROJECT,
  }), /export-metadata-rejected/u);
});

test("sensitive export authorization rejects cross-project archives before artifact creation", (t) => {
  const root = fixture(t);
  const manager = createSensitiveExportManager({ stateRoot: root, projectFingerprint: PROJECT });
  assert.deepEqual(manager.run({
    scope: "project",
    archive: { projectFingerprint: "b".repeat(64), records: [] },
  }), { ok: false, reason: "cross-project-export-forbidden" });
  assert.deepEqual(readdirSync(manager.root), []);
});

test("sensitive export schema rejects forbidden identity metadata in the global member", (t) => {
  const root = fixture(t);
  const manager = createSensitiveExportManager({ stateRoot: root, projectFingerprint: PROJECT });
  assert.deepEqual(manager.run({
    scope: "all",
    archive: {
      projectFingerprint: PROJECT,
      records: [],
      projects: [{ projectFingerprint: PROJECT, records: [], capsules: [], snapshots: [] }],
      global: { recommendations: [{ projectFingerprint: PROJECT }] },
    },
  }), { ok: false, reason: "forbidden-global-identity" });
  assert.deepEqual(readdirSync(manager.root), []);
});

test("BH-6 a lock write that fails mid-acquire never wedges later export jobs", (t) => {
  const root = fixture(t);
  let failLockWrite = true;
  const manager = createSensitiveExportManager({
    stateRoot: root,
    projectFingerprint: PROJECT,
    now: () => 1_000,
    faultInjection: (point) => {
      if (point === "export-after-lock-write" && failLockWrite) throw new Error("export-lock-write-interrupted");
    },
  });

  assert.throws(() => manager.purge(), /export-lock-write-interrupted/u);

  // The failed acquire must not leave an unreclaimable lock behind: the record it
  // wrote may be truncated, and an unparseable lock is never removed by cleanup.
  failLockWrite = false;
  assert.equal(manager.purge().ok, true, "a later export job must still be able to acquire the lock");
});
