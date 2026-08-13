import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_AUTOMATION_PERMISSIONS_HASH } from "../self-evolve-epoch.js";
import {
  V4_SCHEMA_VERSION,
  V4_VERSION_CONTRACT,
  evaluateV4PermissionTransition,
  makeGlobalSettings,
  makeRepoSettings,
  makeV4ConsentState,
  makeV4GlobalSettings,
  makeV4RepoSettings,
  makeV4SettingsBaseline,
  migrateLegacySettingsToV4,
  v4AutomationPermissionsHash,
} from "../self-evolve-schemas.js";

const PROJECT = "a".repeat(64);

test("v0.4 settings are closed over the binary authority surface", () => {
  const baseline = makeV4SettingsBaseline({ projectFingerprint: PROJECT, now: 10 });
  assert.equal(baseline.global.schemaVersion, V4_SCHEMA_VERSION);
  assert.equal(baseline.global.automaticRecommendationsEnabled, true);
  assert.deepEqual(baseline.global.consent, {
    durableObservations: true,
    sanitizedExcerpts: true,
    crossRepoAggregation: true,
  });
  assert.equal(baseline.repo.excluded, false);
  assert.equal(V4_VERSION_CONTRACT.legacyWritableAuthority, false);

  for (const retired of [
    { mode: "auto" },
    { paused: false },
    { repoMode: "inherit" },
    { projectAnalysis: { override: "auto" } },
  ]) {
    assert.throws(() => makeV4GlobalSettings({ ...baseline.global, ...retired }), /unexpected field/u);
  }
  assert.throws(() => makeV4RepoSettings({ ...baseline.repo, mode: "inherit" }), /unexpected field/u);
  assert.throws(() => makeV4ConsentState({ ...baseline.global.consent, passiveCalls: true }), /unexpected field/u);
});

test("every supported legacy mode and pause combination migrates once to On", () => {
  for (const schemaVersion of ["0.2.0", "0.2.1", "0.2.2", "0.3.0"]) {
    for (const mode of ["manual", "auto", "yolo"]) {
      for (const paused of [false, true]) {
        const global = {
          ...makeGlobalSettings({ createdAt: 1, updatedAt: 2, killSwitchActive: true }),
          schemaVersion,
          mode,
          paused,
        };
        const repo = {
          ...makeRepoSettings({ projectFingerprint: PROJECT, excluded: true }),
          schemaVersion,
          mode: mode === "yolo" ? "yolo" : "inherit",
        };
        const migrated = migrateLegacySettingsToV4({ schemaVersion, global, repo }, { projectFingerprint: PROJECT, now: 3 });
        assert.ok(migrated, `${schemaVersion}/${mode}/${paused}`);
        assert.equal(migrated.global.automaticRecommendationsEnabled, true);
        assert.deepEqual(migrated.global.consent, makeV4ConsentState());
        assert.equal(migrated.global.killSwitchActive, true);
        assert.equal(migrated.repo.excluded, true);
        assert.equal("mode" in migrated.global, false);
        assert.equal("paused" in migrated.global, false);
        assert.equal("mode" in migrated.repo, false);
        assert.equal("passiveCalls" in migrated.global.consent, false);
      }
    }
  }
});

test("malformed or unsupported migration input returns no partial grants", () => {
  for (const input of [
    null,
    {},
    { schemaVersion: "9.0.0", global: { automaticRecommendationsEnabled: true } },
    { schemaVersion: "0.3.0", global: { mode: "invalid" }, repo: { projectFingerprint: PROJECT } },
  ]) {
    assert.equal(migrateLegacySettingsToV4(input, { projectFingerprint: PROJECT, now: 1 }), null);
  }
});

test("permission hashes and revocation effects bind exactly the required bundle", () => {
  const allOn = makeV4ConsentState();
  assert.equal(v4AutomationPermissionsHash(allOn), DEFAULT_AUTOMATION_PERMISSIONS_HASH);
  const revoked = { ...allOn, sanitizedExcerpts: false };
  assert.deepEqual(evaluateV4PermissionTransition(allOn, revoked), {
    requiredPermissionRevoked: true,
    stopDurableObservation: false,
    deleteProjectCapsules: true,
    stopGlobalContributions: true,
    invalidateGlobalSupport: true,
    blockGlobalApply: true,
  });
  assert.equal(evaluateV4PermissionTransition(revoked, allOn).requiredPermissionRevoked, false);
});
