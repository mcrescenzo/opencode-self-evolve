import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AUTOMATION_EPOCH_INVALID_REASON,
  AUTOMATION_EPOCH_SCHEMA_VERSION,
  DEFAULT_AUTOMATION_PERMISSIONS_HASH,
  IMPLICIT_AUTOMATION_EPOCH,
  automationEpochFilePath,
  createAutomationEpochManager,
  parseAutomationEpochRecord,
} from "../self-evolve-epoch.js";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-automation-epoch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("automation epoch is an independent On generation when absent", (t) => {
  const manager = createAutomationEpochManager({ stateRoot: fixture(t), now: () => 100 });
  assert.deepEqual(manager.read(), IMPLICIT_AUTOMATION_EPOCH);
  assert.deepEqual(manager.readAuthority(), {
    ok: true,
    enabled: true,
    generation: 1,
    permissionsHash: DEFAULT_AUTOMATION_PERMISSIONS_HASH,
  });
});

test("automation epoch parser is exact and fail-closed", () => {
  for (const source of ["", "{}", "[]", "{bad", JSON.stringify({ schemaVersion: "wrong" })]) {
    assert.throws(() => parseAutomationEpochRecord(source), /automation-epoch-(?:corrupt|unsupported)/u);
  }
});

test("accepted automation transitions advance once and identical retry is idempotent", (t) => {
  const root = fixture(t);
  let timestamp = 200;
  const manager = createAutomationEpochManager({ stateRoot: root, now: () => timestamp++ });
  const transitionHash = hash("off-request");
  const first = manager.transition({
    transitionId: "request-off-1",
    transitionHash,
    expectedGeneration: 1,
    enabled: false,
    permissionsHash: DEFAULT_AUTOMATION_PERMISSIONS_HASH,
    rootIdentityHash: hash("root"),
  });
  assert.equal(first.duplicate, false);
  assert.equal(first.record.generation, 2);
  assert.equal(first.record.enabled, false);

  const retry = manager.transition({
    transitionId: "request-off-1",
    transitionHash,
    expectedGeneration: 1,
    enabled: false,
    permissionsHash: DEFAULT_AUTOMATION_PERMISSIONS_HASH,
    rootIdentityHash: hash("root"),
  });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.record.generation, 2);
  assert.throws(() => manager.transition({
    transitionId: "request-off-1",
    transitionHash: hash("conflict"),
    expectedGeneration: 2,
    enabled: true,
    permissionsHash: DEFAULT_AUTOMATION_PERMISSIONS_HASH,
  }), /automation-transition-conflict/u);
  assert.throws(() => manager.transition({
    transitionId: "request-on-stale",
    transitionHash: hash("stale"),
    expectedGeneration: 1,
    enabled: true,
    permissionsHash: DEFAULT_AUTOMATION_PERMISSIONS_HASH,
  }), /stale-automation-generation/u);
});

test("automation stamps compare against a fresh exact generation", (t) => {
  const manager = createAutomationEpochManager({ stateRoot: fixture(t), now: () => 300 });
  const first = manager.stamp();
  assert.equal(manager.compare(first), true);
  manager.transition({
    transitionId: "request-off-2",
    transitionHash: hash("off-2"),
    expectedGeneration: 1,
    enabled: false,
    permissionsHash: DEFAULT_AUTOMATION_PERMISSIONS_HASH,
  });
  assert.equal(manager.compare(first), false);
  assert.equal(manager.compare(manager.stamp()), true);
});

test("malformed automation epoch exposes no partial authority", (t) => {
  const root = fixture(t);
  writeFileSync(automationEpochFilePath(root), JSON.stringify({ schemaVersion: AUTOMATION_EPOCH_SCHEMA_VERSION, enabled: true }), "utf8");
  const manager = createAutomationEpochManager({ stateRoot: root });
  assert.deepEqual(manager.readAuthority(), {
    ok: false,
    enabled: false,
    generation: null,
    permissionsHash: null,
    reason: AUTOMATION_EPOCH_INVALID_REASON,
  });
  assert.equal(manager.compare({}), false);
});
