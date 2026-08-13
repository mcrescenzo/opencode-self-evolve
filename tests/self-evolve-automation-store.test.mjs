import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { ROOT_EPOCH_REINITIALIZE_CONFIRMATION } from "../self-evolve-epoch.js";
import { V4_SCHEMA_VERSION } from "../self-evolve-schemas.js";
import { stateRootIdentity } from "../self-evolve-state-root.js";
import { openStore } from "../self-evolve-store.js";

const PROJECT = "b".repeat(64);
const OTHER_PROJECT = "c".repeat(64);
const PEER = path.join(import.meta.dirname, "fixtures", "automation-state-peer.mjs");

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-automation-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function runPeer(root, operation, argument = "") {
  const resultPath = path.join(root, `automation-result-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PEER, root, PROJECT, operation, resultPath, argument], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      let result = null;
      if (existsSync(resultPath)) result = JSON.parse(readFileSync(resultPath, "utf8"));
      resolve({ code, result, stderr });
    });
  });
}

test("fresh store migrates to the v0.4 On bundle without legacy authority", (t) => {
  const store = openStore(fixture(t), { projectFingerprint: PROJECT, now: () => 10 });
  const state = store.getAutomationState();
  assert.equal(state.ok, true);
  assert.equal(state.enabled, true);
  assert.equal(state.epoch.generation, 1);
  assert.equal(state.global.schemaVersion, V4_SCHEMA_VERSION);
  assert.equal("mode" in state.global, false);
  assert.equal("paused" in state.global, false);
  assert.equal("mode" in state.repo, false);
  assert.equal("passiveCalls" in state.global.consent, false);
  assert.equal(store.updateGlobalSettings((global) => ({ ...global, mode: "auto" })).reason, "retired-v04-control");
  assert.equal(store.updateGlobalSettings((global) => ({ ...global, paused: true })).reason, "retired-v04-control");
  assert.equal(store.updateGlobalSettings((global) => ({
    ...global,
    consent: { ...global.consent, passiveCalls: true },
  })).reason, "retired-v04-control");
  assert.equal(store.updateGlobalSettings((global) => ({
    ...global,
    consent: { ...global.consent, durableObservations: true },
  })).reason, "retired-v04-control");
  assert.equal(store.updateRepoSettings((repo) => ({ ...repo, mode: "auto" })).reason, "retired-v04-control");
});

test("each required permission revocation turns Off and restoration never restarts", (t) => {
  for (const permission of ["durableObservations", "sanitizedExcerpts", "crossRepoAggregation"]) {
    const root = mkdtempSync(path.join(tmpdir(), `self-evolve-automation-${permission}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = openStore(root, { projectFingerprint: PROJECT });
    const revoked = store.transitionAutomation({
      transitionId: `revoke-${permission}`,
      expectedGeneration: 1,
      action: "set-permission",
      permission,
      enabled: false,
    });
    assert.equal(revoked.ok, true, permission);
    assert.equal(revoked.epoch.generation, 2, permission);
    assert.equal(revoked.settings.automaticRecommendationsEnabled, false, permission);
    assert.equal(revoked.settings.consent[permission], false, permission);
    assert.equal(revoked.consentEffects.requiredPermissionRevoked, true, permission);
    assert.equal(revoked.consentEffects.invalidateGlobalSupport, true, permission);
    assert.equal(revoked.auditEvent.details.action, "automation-control", permission);

    const restored = store.transitionAutomation({
      transitionId: `restore-${permission}`,
      expectedGeneration: 2,
      action: "set-permission",
      permission,
      enabled: true,
    });
    assert.equal(restored.epoch.generation, 3, permission);
    assert.equal(restored.settings.automaticRecommendationsEnabled, false, permission);

    const enabled = store.transitionAutomation({
      transitionId: `enable-${permission}`,
      expectedGeneration: 3,
      action: "set-automatic-recommendations",
      enabled: true,
    });
    assert.equal(enabled.epoch.generation, 4, permission);
    assert.equal(enabled.settings.automaticRecommendationsEnabled, true, permission);
    assert.equal(Object.values(enabled.settings.consent).every(Boolean), true, permission);
    store.close();
  }
});

test("binary and permission transitions advance exactly once and preserve future-only Off", (t) => {
  const root = fixture(t);
  let timestamp = 20;
  const store = openStore(root, { projectFingerprint: PROJECT, now: () => timestamp++ });
  const offRequest = {
    transitionId: "off-1",
    expectedGeneration: 1,
    action: "set-automatic-recommendations",
    enabled: false,
  };
  const off = store.transitionAutomation(offRequest);
  assert.equal(off.ok, true);
  assert.equal(off.epoch.generation, 2);
  assert.equal(off.settings.automaticRecommendationsEnabled, false);
  assert.equal(store.transitionAutomation(offRequest).duplicate, true);

  const revoked = store.transitionAutomation({
    transitionId: "revoke-excerpts",
    expectedGeneration: 2,
    action: "set-permission",
    permission: "sanitizedExcerpts",
    enabled: false,
  });
  assert.equal(revoked.epoch.generation, 3);
  assert.equal(revoked.settings.automaticRecommendationsEnabled, false);
  assert.equal(revoked.settings.consent.sanitizedExcerpts, false);
  assert.equal(revoked.consentEffects.deleteProjectCapsules, true);

  const restored = store.transitionAutomation({
    transitionId: "restore-excerpts",
    expectedGeneration: 3,
    action: "set-permission",
    permission: "sanitizedExcerpts",
    enabled: true,
  });
  assert.equal(restored.epoch.generation, 4);
  assert.equal(restored.settings.automaticRecommendationsEnabled, false);

  const on = store.transitionAutomation({
    transitionId: "on-1",
    expectedGeneration: 4,
    action: "set-automatic-recommendations",
    enabled: true,
  });
  assert.equal(on.epoch.generation, 5);
  assert.equal(on.settings.automaticRecommendationsEnabled, true);
  assert.deepEqual(on.settings.consent, {
    durableObservations: true,
    sanitizedExcerpts: true,
    crossRepoAggregation: true,
  });
  store.close();
  const reopened = openStore(root, { projectFingerprint: PROJECT });
  assert.equal(reopened.getAutomationState().epoch.generation, 5);
});

test("two processes accept at most one competing generation transition", async (t) => {
  const root = fixture(t);
  openStore(root, { projectFingerprint: PROJECT }).close();
  const results = await Promise.all([runPeer(root, "off"), runPeer(root, "off")]);
  assert.equal(results.filter((item) => item.result?.ok && item.result?.changed).length, 1, JSON.stringify(results));
  assert.equal(results.filter((item) => item.result?.reason === "stale-automation-generation").length, 1);
  const reopened = openStore(root, { projectFingerprint: PROJECT });
  assert.equal(reopened.getAutomationState().epoch.generation, 2);
  assert.equal(reopened.getAutomationState().enabled, false);
});

test("process death across every automation transition stage converges", async (t) => {
  const points = [
    "automation-before-intent-write",
    "automation-after-intent-write",
    "automation-after-epoch-write",
    "automation-after-settings-write",
    "automation-after-audit-write",
    "automation-after-privacy-effects",
    "automation-after-transaction-remove",
  ];
  for (const point of points) {
    const root = mkdtempSync(path.join(tmpdir(), "self-evolve-automation-crash-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    openStore(root, { projectFingerprint: PROJECT }).close();
    const crashed = await runPeer(root, "off", point);
    assert.equal(crashed.code, 91, point);
    const reopened = openStore(root, { projectFingerprint: PROJECT, staleLockMs: 1, lockTimeoutMs: 10_000 });
    const state = reopened.getAutomationState();
    if (point === "automation-before-intent-write") {
      assert.equal(state.epoch.generation, 1, point);
      assert.equal(state.enabled, true, point);
    } else {
      assert.equal(state.epoch.generation, 2, point);
      assert.equal(state.enabled, false, point);
    }
    reopened.close();
  }
});

test("a different project process recovers the root-global transition", async (t) => {
  const root = fixture(t);
  openStore(root, { projectFingerprint: PROJECT }).close();
  const crashed = await runPeer(root, "off", "automation-after-intent-write");
  assert.equal(crashed.code, 91);
  const peer = openStore(root, {
    projectFingerprint: OTHER_PROJECT,
    staleLockMs: 1,
    lockTimeoutMs: 10_000,
  });
  const state = peer.getAutomationState();
  assert.equal(state.ok, true);
  assert.equal(state.enabled, false);
  assert.equal(state.epoch.generation, 2);
  const sourceAudit = path.join(root, "self-evolve", PROJECT, "audit.jsonl");
  assert.equal(readFileSync(sourceAudit, "utf8").includes("automation-control"), true);
});

test("corrupt v0.4 authority opens Off without overwriting the evidence", (t) => {
  const root = fixture(t);
  openStore(root, { projectFingerprint: PROJECT }).close();
  const filePath = path.join(root, "self-evolve", "global", "automation-settings.json");
  writeFileSync(filePath, "{not-json", "utf8");
  const reopened = openStore(root, { projectFingerprint: PROJECT });
  const state = reopened.getAutomationState();
  assert.deepEqual({ ok: state.ok, enabled: state.enabled, reason: state.reason }, {
    ok: false,
    enabled: false,
    reason: "corrupt-automation-settings",
  });
  assert.equal(readFileSync(filePath, "utf8"), "{not-json");
});

test("authenticated reinitialize restores a fresh On automation generation", (t) => {
  const root = fixture(t);
  const store = openStore(root, { projectFingerprint: PROJECT, now: () => 100 });
  store.transitionAutomation({
    transitionId: "off-before-terminal",
    expectedGeneration: 1,
    action: "set-automatic-recommendations",
    enabled: false,
  });
  store.markRootTerminal({ terminalOperationId: "terminal-for-test" });
  const identity = stateRootIdentity(root);
  const result = store.reinitializeRoot({
    confirmation: ROOT_EPOCH_REINITIALIZE_CONFIRMATION,
    authentication: {
      rootIdentityHash: identity,
      projectFingerprintHash: PROJECT,
      schemaVersion: V4_SCHEMA_VERSION,
      protocolVersion: "dashboard-v3",
      nonce: "fresh-reinitialize-nonce",
      consentSnapshotHash: "c".repeat(64),
      operatorAuthority: "operator",
    },
  });
  assert.equal(result.terminal, false);
  assert.equal(result.automation.enabled, true);
  assert.ok(result.automation.generation > 2);
  const state = store.getAutomationState();
  assert.equal(state.ok, true);
  assert.equal(state.enabled, true);
  assert.deepEqual(state.global.consent, {
    durableObservations: true,
    sanitizedExcerpts: true,
    crossRepoAggregation: true,
  });
});

test("Emergency Stop advances authority without rewriting the On preference", (t) => {
  const store = openStore(fixture(t), { projectFingerprint: PROJECT, now: () => 200 });
  const stopped = store.transitionAutomation({
    transitionId: "emergency-stop-on",
    expectedGeneration: 1,
    action: "set-emergency-stop",
    enabled: true,
  });
  assert.equal(stopped.ok, true, stopped.reason);
  assert.equal(stopped.epoch.generation, 2);
  assert.equal(stopped.settings.automaticRecommendationsEnabled, true);
  assert.equal(stopped.settings.killSwitchActive, true);
  assert.equal(stopped.auditEvent.details.emergencyStopActive, true);

  const cleared = store.transitionAutomation({
    transitionId: "emergency-stop-off",
    expectedGeneration: 2,
    action: "set-emergency-stop",
    enabled: false,
  });
  assert.equal(cleared.ok, true, cleared.reason);
  assert.equal(cleared.epoch.generation, 3);
  assert.equal(cleared.settings.automaticRecommendationsEnabled, true);
  assert.equal(cleared.settings.killSwitchActive, false);
});
