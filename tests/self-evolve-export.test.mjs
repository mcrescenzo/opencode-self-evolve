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
      snapshots: [{ sensitivity: "active-skill-and-rollback-snapshot" }],
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

test("store purge removes sensitive artifacts for every data scope", (t) => {
  for (const scope of ["observations", "proposals", "project", "all"]) {
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
