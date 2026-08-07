import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";

import {
  LIVE_EVIDENCE_ENV,
  OPENCODE_BIN_ENV,
  OUTPUT_ENV,
  RECEIPT_SCHEMA_VERSION,
  RELEASE_A_TUI_COMMIT,
  TIMEOUT_ENV,
  alignedTuiPackages,
  assertPublicSafe,
  assertSupportedOpenCodeVersion,
  buildPublicReport,
  liveOptions,
  main,
  parseTimeout,
  validateInstalledPackageGraph,
  validateStageReceipt,
} from "../scripts/release-b-operator-evidence.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function expectedStage() {
  return {
    stage: 3,
    columns: 64,
    rows: 20,
    frameNames: ["startup-sidebar", "narrow-home", "narrow-settings"],
    proofNames: [
      "noAmbientUiBeforeActivation",
      "productionTuiEntryActive",
      "productionTuiPackedArtifactPath",
      "narrowLayoutRenderedWithoutHorizontalOverflow",
      "restartFreshProcess",
      "restartUsedDistinctProject",
    ],
  };
}

function stageReceipt() {
  const expected = expectedStage();
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    status: "passed",
    stage: expected.stage,
    pid: 123,
    openCodeVersion: "1.18.9",
    columns: expected.columns,
    rows: expected.rows,
    proofs: Object.fromEntries(expected.proofNames.map((name) => [name, true])),
    frames: expected.frameNames.map((name) => ({
      name,
      columns: expected.columns,
      rows: expected.rows,
      frame: `Self-evolve ${name}`,
      sha256: sha256(`Self-evolve ${name}`),
      maximumLineColumns: 32,
    })),
  };
}

test("operator evidence is opt-in, bounded, and accepts the supported 1.18 range", async () => {
  assert.throws(() => liveOptions({}), new RegExp(LIVE_EVIDENCE_ENV));
  assert.throws(
    () => liveOptions({ [LIVE_EVIDENCE_ENV]: "1", [OPENCODE_BIN_ENV]: "opencode" }),
    new RegExp(OPENCODE_BIN_ENV),
  );
  assert.throws(() => liveOptions({
    [LIVE_EVIDENCE_ENV]: "1",
    [OPENCODE_BIN_ENV]: "/opt/opencode",
    [OUTPUT_ENV]: "relative.json",
  }), new RegExp(OUTPUT_ENV));
  assert.deepEqual(liveOptions({
    [LIVE_EVIDENCE_ENV]: "1",
    [OPENCODE_BIN_ENV]: "/opt/opencode",
    [OUTPUT_ENV]: "/tmp/release-b.json",
    [TIMEOUT_ENV]: "30000",
  }), {
    opencodeBin: "/opt/opencode",
    outputPath: "/tmp/release-b.json",
    timeoutMs: 30000,
  });
  assert.equal(parseTimeout(undefined), 120000);
  for (const invalid of ["0", "29999", "300001", "30s", "30000.5", "-1", " 30000 "]) {
    assert.throws(() => parseTimeout(invalid), new RegExp(TIMEOUT_ENV));
  }
  for (const supported of ["1.18.3", "1.18.9", "1.18.10\n"]) {
    assert.equal(assertSupportedOpenCodeVersion(supported), supported.trim());
  }
  for (const unsupported of ["1.18.2", "1.19.0", "1.18.3-dev", "opencode 1.18.9", ""]) {
    assert.throws(() => assertSupportedOpenCodeVersion(unsupported), />=1\.18\.3/);
  }

  let stderr = "";
  assert.equal(await main({
    env: {},
    streams: {
      stdout: { write() {} },
      stderr: { write(value) { stderr += value; } },
    },
  }), 1);
  assert.match(stderr, /REQUIRED GATE FAILED/);
});

test("operator evidence aligns OpenTUI to the installed OpenCode SDK floor", () => {
  assert.deepEqual(alignedTuiPackages({
    name: "@opencode-ai/plugin",
    peerDependencies: {
      "@opentui/core": ">=0.4.5",
      "@opentui/keymap": ">=0.4.5",
      "@opentui/solid": ">=0.4.5",
    },
  }), {
    "@opentui/core": "0.4.5",
    "@opentui/keymap": "0.4.5",
    "@opentui/solid": "0.4.5",
    "solid-js": "1.9.12",
  });
  assert.throws(() => alignedTuiPackages({
    name: "@opencode-ai/plugin",
    peerDependencies: {
      "@opentui/core": ">=0.4.5",
      "@opentui/keymap": "^0.4.5",
      "@opentui/solid": ">=0.4.5",
    },
  }), /unsupported OpenCode peer range/);
});

test("installed production graph validation binds candidate and compatible peers", () => {
  const manifests = {
    "@mcrescenzo/opencode-self-evolve": {
      name: "@mcrescenzo/opencode-self-evolve",
      version: "0.2.0",
      exports: { "./tui": "./self-evolve-tui.generated.js" },
    },
    "@opencode-ai/plugin": {
      name: "@opencode-ai/plugin",
      version: "1.18.9",
      peerDependencies: {
        "@opentui/core": ">=0.4.5",
        "@opentui/keymap": ">=0.4.5",
        "@opentui/solid": ">=0.4.5",
      },
    },
    "@opentui/core": { name: "@opentui/core", version: "0.4.6" },
    "@opentui/keymap": { name: "@opentui/keymap", version: "0.4.6" },
    "@opentui/solid": { name: "@opentui/solid", version: "0.4.6" },
    "solid-js": { name: "solid-js", version: "1.9.12" },
  };
  assert.deepEqual(validateInstalledPackageGraph(manifests, "0.2.0"), {
    "@opentui/core": "0.4.6",
    "@opentui/keymap": "0.4.6",
    "@opentui/solid": "0.4.6",
    "solid-js": "1.9.12",
  });
  assert.throws(
    () => validateInstalledPackageGraph({
      ...manifests,
      "@opentui/core": { name: "@opentui/core", version: "0.4.4" },
    }, "0.2.0"),
    /incompatible/,
  );
  assert.throws(
    () => validateInstalledPackageGraph(manifests, "0.2.1"),
    /candidate identity/,
  );
});

test("stage validation binds exact frame order, hashes, proofs, and width", () => {
  const expected = expectedStage();
  const receipt = stageReceipt();
  const validated = validateStageReceipt(receipt, expected);
  assert.equal(validated.pid, undefined);
  assert.deepEqual(validated.frames.map(({ name }) => name), expected.frameNames);

  assert.throws(
    () => validateStageReceipt({
      ...receipt,
      proofs: { ...receipt.proofs, restartFreshProcess: false },
    }, expected),
    /proofs is incomplete/,
  );
  assert.throws(
    () => validateStageReceipt({
      ...receipt,
      frames: receipt.frames.map((frame, index) => index === 0
        ? { ...frame, maximumLineColumns: 65 }
        : frame),
    }, expected),
    /render evidence is incomplete/,
  );
  assert.throws(
    () => validateStageReceipt({
      ...receipt,
      frames: receipt.frames.map((frame, index) => index === 0
        ? { ...frame, frame: `${frame.frame}!` }
        : frame),
    }, expected),
    /render evidence is incomplete/,
  );
});

test("public report records production coverage without claiming independent review", () => {
  const stage = validateStageReceipt(stageReceipt(), expectedStage());
  const legacyStage = {
    ...stage,
    stage: 4,
    proofs: { legacyTuiIgnoredAdditiveDashboard: true },
  };
  const report = buildPublicReport({
    openCodeVersion: "1.18.9",
    candidateVersion: "0.2.0",
    exactTuiPackages: {
      "@opentui/core": "0.4.5",
      "@opentui/keymap": "0.4.5",
      "@opentui/solid": "0.4.5",
      "solid-js": "1.9.12",
    },
    candidate: {
      tarballSha256: "a".repeat(64),
      inventorySha256: "b".repeat(64),
      inventoryCount: 35,
    },
    releaseATui: {
      sourceCommit: RELEASE_A_TUI_COMMIT,
      tuiSha256: "c".repeat(64),
    },
    stages: [stage, stage, stage, legacyStage],
    policy: {
      packageJsonUnchanged: true,
      bunLockUnchanged: true,
      agentsMdUnchanged: true,
    },
    trackedTuiProcessGroupsStopped: true,
    scratchRemoved: true,
  });
  assert.equal(report.productionTuiEntryExercised, true);
  assert.deepEqual(report.releaseATui, {
    sourceCommit: RELEASE_A_TUI_COMMIT,
    tuiSha256: "c".repeat(64),
    ignoredAdditiveDashboard: true,
  });
  assert.equal(report.limitations.automatedLocalOperatorWitness, true);
  assert.equal(report.limitations.independentHumanReview, false);
  assert.equal(report.limitations.publicationOrRelease, false);
  assert.throws(() => assertPublicSafe({ sessionID: "private" }), /sensitive key/);
  assert.throws(() => assertPublicSafe({ frame: "ses_private" }), /private data/);
  assert.throws(() => assertPublicSafe({ frame: "/home/private/repo" }), /private data/);
});

test("live fixture uses the production target and renderer-level operator input", async () => {
  const [runner, witness] = await Promise.all([
    fs.readFile(new URL("../scripts/release-b-operator-evidence.mjs", import.meta.url), "utf8"),
    fs.readFile(
      new URL("./fixtures/release-b-operator-evidence/witness.mjs", import.meta.url),
      "utf8",
    ),
  ]);
  for (const required of [
    "npm",
    "pack",
    "--ignore-scripts",
    "script",
    "stty cols",
    "self-evolve-tui.generated.js",
    RELEASE_A_TUI_COMMIT,
    "git",
    "archive",
    "SELF_EVOLVE_RELEASE_B_PACKAGE_ROOT",
    "productionTuiEntryExercised: true",
  ]) {
    assert.match(runner, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  }
  for (const required of [
    "createMockMouse",
    "createMockKeys",
    "api.plugins.list",
    "mouse.click",
    'keys.pressKey("RETURN")',
    'keys.pressKey(" ")',
    'keys.pressKey("ESCAPE")',
    "api.keymap.dispatchCommand(COMMAND_ID)",
    'const PRODUCT_ID = "mcrescenzo.self-evolve"',
    "buildUiProjection",
    "legacyTuiIgnoredAdditiveDashboard",
    "maximumLineColumns",
  ]) {
    assert.match(witness, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  }
});

test("the mixed-version witness stays pinned to the strict Release A 0.2.1 contract", async () => {
  const [schemas, bridge] = await Promise.all([
    fs.readFile(new URL("../self-evolve-schemas.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../self-evolve-bridge.js", import.meta.url), "utf8"),
  ]);
  assert.match(schemas, /export const SCHEMA_VERSION = "0\.2\.2";/u);
  assert.match(bridge, /export const BRIDGE_SCHEMA_VERSION = "0\.2\.1";/u);
  assert.match(bridge, /value !== BRIDGE_SCHEMA_VERSION && value !== "0\.2\.2"/u);
  assert.equal(RELEASE_A_TUI_COMMIT, "6a1014a608800b038e8efdf21445b03c161f1a9f");
});
