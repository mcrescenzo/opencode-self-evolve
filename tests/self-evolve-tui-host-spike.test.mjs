import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  CANDIDATE_VERSION,
  LIVE_SPIKE_ENV,
  OPENCODE_BIN_ENV,
  PRODUCT_COMMAND_ID,
  PRODUCT_PLUGIN_ID,
  PRODUCT_ROUTE_ID,
  RECEIPT_SCHEMA_VERSION,
  REQUIRED_OPENCODE_VERSION,
  TIMEOUT_ENV,
  assertOpenCodeVersion,
  assertPublicSafe,
  buildPublicReceipt,
  isolatedEnvironment,
  liveOptions,
  main,
  mutateCandidatePackage,
  parseTimeout,
  spikeConfigs,
  validateCandidatePackage,
  validateStageReceipt,
} from "../scripts/live-tui-host-spike.mjs";

const stageOneKeys = [
  "packedTargetActive",
  "cardAbsentThenPresent",
  "rendererClickOpenedDialog",
  "rendererEnterOpenedDialog",
  "paletteVisible",
  "paletteMetadataOnly",
  "paletteOpenedRoute",
  "routeModeLifecycle",
  "delayedReplacementLease",
  "workspaceWarped",
  "livePathUpdated",
  "pluginNotReinstantiated",
  "pathRebound",
  "pluginDeactivated",
  "pluginReactivated",
  "registrationsExact",
];
const stageTwoKeys = [
  "freshProcess",
  "packedTargetActive",
  "singleRegistration",
  "restartHandoffValid",
  "narrowCardReachable",
  "narrowDialogReachable",
  "narrowRouteReachable",
  "sessionsDeleted",
  "fixturesDeleted",
  "privateHandoffDeleted",
];

const trueRecord = (keys) => Object.fromEntries(keys.map((key) => [key, true]));

function stageReceipt(stage) {
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    stage,
    status: "passed",
    openCodeVersion: REQUIRED_OPENCODE_VERSION,
    productVersion: CANDIDATE_VERSION,
    productActivations: stage === 1 ? 2 : 1,
    ...(stage === 1 ? { cleanupElapsedMs: 25 } : {}),
    proofs: trueRecord(stage === 1 ? stageOneKeys : stageTwoKeys),
    providerPromptHookCalls: 0,
  };
}

function sourcePackage() {
  return {
    name: "@mcrescenzo/opencode-self-evolve",
    version: "0.2.0",
    type: "module",
    engines: { node: ">=22.11.0", opencode: ">=1.18.3 <1.19.0" },
    exports: { ".": "./self-evolve.js", "./tui": "./self-evolve-tui.js" },
    files: ["self-evolve.js", "self-evolve-tui.js"],
    scripts: { test: "node --test tests/*.test.mjs" },
    peerDependencies: { "@opencode-ai/plugin": "~1.18.3" },
    peerDependenciesMeta: { "@opencode-ai/plugin": { optional: true } },
  };
}

test("live spike fails closed on opt-in, binary path, exact version, and timeout bounds", async () => {
  assert.throws(() => liveOptions({}), new RegExp(LIVE_SPIKE_ENV));
  assert.throws(
    () => liveOptions({ [LIVE_SPIKE_ENV]: "1", [OPENCODE_BIN_ENV]: "opencode" }),
    new RegExp(OPENCODE_BIN_ENV),
  );
  assert.deepEqual(liveOptions({
    [LIVE_SPIKE_ENV]: "1",
    [OPENCODE_BIN_ENV]: "/exact/opencode",
    [TIMEOUT_ENV]: "30000",
  }), { opencodeBin: "/exact/opencode", timeoutMs: 30000 });
  assert.equal(parseTimeout(undefined), 120000);
  for (const invalid of ["0", "29999", "300001", "30s", "30000.5", "-30000", " 30000 "]) {
    assert.throws(() => parseTimeout(invalid), new RegExp(TIMEOUT_ENV));
  }
  assert.equal(assertOpenCodeVersion("1.18.3\n"), "1.18.3");
  for (const invalid of ["opencode 1.18.3", "1.18.3-dev", "1.18.4", "1.18.3\nextra", ""]) {
    assert.throws(() => assertOpenCodeVersion(invalid), /1\.18\.3 is required/);
  }

  let stderr = "";
  const exit = await main({ env: {}, streams: { stdout: { write() {} }, stderr: { write(value) { stderr += value; } } } });
  assert.equal(exit, 1);
  assert.match(stderr, /REQUIRED GATE FAILED/);

  stderr = "";
  const missingBinaryExit = await main({
    env: { [LIVE_SPIKE_ENV]: "1", [OPENCODE_BIN_ENV]: "/mnt/private/opencode" },
    streams: { stdout: { write() {} }, stderr: { write(value) { stderr += value; } } },
  });
  assert.equal(missingBinaryExit, 1);
  assert.doesNotMatch(stderr, /\/mnt\/private/);
  assert.match(stderr, /<path>/);
});

test("candidate mutation is disposable, exact-floor, optional-peer, and lifecycle-script free", () => {
  const source = sourcePackage();
  const before = structuredClone(source);
  const candidate = mutateCandidatePackage(source);
  assert.deepEqual(source, before, "the source manifest must not be mutated");
  assert.equal(candidate.version, CANDIDATE_VERSION);
  assert.deepEqual(candidate.engines, { node: ">=22.11.0", opencode: "1.18.3" });
  assert.equal(candidate.exports["."], "./self-evolve.js");
  assert.equal(candidate.exports["./tui"], "./tui.generated.js");
  assert.equal(candidate.files.filter((entry) => entry === "tui.generated.js").length, 1);
  assert.deepEqual(candidate.peerDependencies, {
    "@opencode-ai/plugin": "~1.18.3",
    "@opentui/core": ">=0.4.5 <0.6.0",
    "@opentui/keymap": ">=0.4.5 <0.6.0",
    "@opentui/solid": ">=0.4.5 <0.6.0",
    "solid-js": "1.9.12",
  });
  for (const name of Object.keys(candidate.peerDependencies)) {
    assert.equal(candidate.peerDependenciesMeta[name].optional, true);
  }
  assert.equal(validateCandidatePackage(candidate), candidate);
  assert.throws(() => mutateCandidatePackage({ ...source, scripts: { install: "unsafe" } }), /forbidden install/);
  assert.throws(() => mutateCandidatePackage({ ...source, exports: {} }), /root export/);
  assert.throws(() => validateCandidatePackage({ ...candidate, files: [...candidate.files, "tui.generated.js"] }), /mutation is incomplete/);
});

test("scratch configs preserve witness-first load order and isolated host state", () => {
  const config = spikeConfigs({
    witnessUrl: "file:///consumer/node_modules/.spike/witness.mjs",
    candidateUrl: "file:///consumer/node_modules/@mcrescenzo/opencode-self-evolve",
    workspacePluginUrl: "file:///scratch/workspace-plugin.mjs",
  });
  assert.deepEqual(config.tui.plugin, [
    "file:///consumer/node_modules/.spike/witness.mjs",
    "file:///consumer/node_modules/@mcrescenzo/opencode-self-evolve",
  ]);
  assert.deepEqual(config.server.plugin, ["file:///scratch/workspace-plugin.mjs"]);
  assert.equal(config.server.autoupdate, false);

  const isolated = isolatedEnvironment({
    KEEP: "yes",
    HOME: "/user/home",
    OPENCODE_CONFIG: "/user/config",
    OPENCODE_CONFIG_CONTENT: "secret",
    OPENCODE_CONFIG_DIR: "/user/config-dir",
    OPENAI_API_KEY: "credential",
    HTTPS_PROXY: "https://user:password@example.test",
  }, {
    project: "/scratch/project",
    home: "/scratch/home",
    xdgConfig: "/scratch/config",
    xdgData: "/scratch/data",
    xdgState: "/scratch/state",
    xdgCache: "/scratch/cache",
    npmCache: "/scratch/npm-cache",
  });
  assert.equal(isolated.KEEP, undefined);
  assert.equal(isolated.HOME, "/scratch/home");
  assert.equal(isolated.OPENCODE_CONFIG, undefined);
  assert.equal(isolated.OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(isolated.OPENAI_API_KEY, undefined);
  assert.equal(isolated.HTTPS_PROXY, undefined);
  assert.equal(isolated.OPENCODE_EXPERIMENTAL_WORKSPACES, "true");
  assert.equal(isolated.npm_config_cache, "/scratch/npm-cache");
});

test("stage and public receipts require exact proofs and reject private data", () => {
  const first = stageReceipt(1);
  const second = stageReceipt(2);
  assert.equal(validateStageReceipt(first, 1), first);
  assert.equal(validateStageReceipt(second, 2), second);
  assert.throws(
    () => validateStageReceipt({ ...first, cleanupElapsedMs: 5001 }, 1),
    /cleanup exceeded/,
  );
  assert.throws(
    () => validateStageReceipt({ ...second, proofs: { ...second.proofs, freshProcess: false } }, 2),
    /proofs is incomplete/,
  );
  for (const unsafe of [
    { sessionID: "private" },
    { value: "ses_private" },
    { value: "file:///private/plugin.tsx" },
    { value: "/home/user/project" },
    { apiKey: "private" },
  ]) {
    assert.throws(() => assertPublicSafe(unsafe), /private data|sensitive key/);
  }

  const receipt = buildPublicReceipt({
    stage1: first,
    stage2: second,
    tarballSha256: "a".repeat(64),
    inventorySha256: "b".repeat(64),
    inventoryCount: 24,
    rootServerExportPeerless: true,
    peerlessOptionalPackagesAbsent: true,
    lifecycleScripts: [],
    policy: {
      packageJsonUnchanged: true,
      bunLockUnchanged: true,
      agentsMdUnchanged: true,
      baselineSha256: { packageJson: "c".repeat(64), bunLock: "d".repeat(64), agentsMd: "e".repeat(64) },
    },
    cleanup: { trackedTuiProcessGroupsStopped: true, scratchRemoved: true },
  });
  assert.equal(receipt.peerContract.testedExactFloorOnly, true);
  assert.equal(receipt.peerContract.rangeCompatibilityProven, false);
  assert.equal(receipt.candidate.productionTuiEntryExercised, false);
  assert.equal(receipt.pathLifecycle.observed.livePathUpdatedWithoutReinstantiation, true);
  assert.equal(receipt.proofs.cleanupWithinHostDeadline, true);
  assert.equal(receipt.providerPromptHookCalls, 0);
  assert.doesNotMatch(JSON.stringify(receipt), /ses_|file:\/\/|\/home\//);
  assert.throws(() => buildPublicReceipt({
    stage1: first,
    stage2: second,
    tarballSha256: "a".repeat(64),
    inventorySha256: "b".repeat(64),
    inventoryCount: 1,
    rootServerExportPeerless: true,
    peerlessOptionalPackagesAbsent: true,
    lifecycleScripts: ["install"],
    policy: {
      packageJsonUnchanged: true,
      bunLockUnchanged: true,
      agentsMdUnchanged: true,
      baselineSha256: { packageJson: "c".repeat(64), bunLock: "d".repeat(64), agentsMd: "e".repeat(64) },
    },
    cleanup: { trackedTuiProcessGroupsStopped: true, scratchRemoved: true },
  }), /lifecycle scripts/);
});

test("fixture sources retain exact-host renderer, palette, route, workspace, and cleanup probes", async () => {
  const [harness, tui, witness, workspace] = await Promise.all([
    fs.readFile(new URL("../scripts/live-tui-host-spike.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("./fixtures/self-evolve-tui-host-spike/tui.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("./fixtures/self-evolve-tui-host-spike/witness.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("./fixtures/self-evolve-tui-host-spike/workspace-plugin.mjs", import.meta.url), "utf8"),
  ]);
  for (const required of [
    "npm", "pack", "--json", "--ignore-scripts", "--omit=${name}", '"optional", "peer"',
    "script", "stty cols", "SELF_EVOLVE_TUI_HOST_SPIKE", "sha256File", "policyHashes",
  ]) assert.match(harness, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const required of [
    "@jsxImportSource @opentui/solid", "solid-js", PRODUCT_PLUGIN_ID, PRODUCT_COMMAND_ID,
    PRODUCT_ROUTE_ID, "focusable", "onMouseDown", "onMouseUp", "onKeyDown",
    "api.ui.dialog.replace", "api.mode.push", "onCleanup", "path-rebound", "delayed-noop",
  ]) assert.match(tui, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const required of [
    "createMockMouse", "createMockKeys", "mouse.click", "keys.pressEnter",
    "getCommandEntries", 'namespace: "palette"', "command.palette.show", "workspace.set",
    "api.plugins.deactivate", "api.plugins.activate", "session.sidebar.toggle", "session.delete",
  ]) assert.match(witness, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(workspace, /experimental_workspace\.register/);
  assert.match(workspace, /type: "local"/);
  assert.match(workspace, /"chat\.params"/);
});
