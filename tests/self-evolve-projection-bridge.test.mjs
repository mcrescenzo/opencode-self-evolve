import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BRIDGE_SCHEMA_VERSION,
  cleanupBridge,
  publishControlState,
  publishUiProjection,
  readControlState,
  readProjectInbox,
  readUiProjection,
} from "../self-evolve-bridge.js";
import { makeRepoSettings } from "../self-evolve-schemas.js";
import { openStore } from "../self-evolve-store.js";
import { stateRootIdentity } from "../self-evolve-state-root.js";
import {
  UI_ACTION_CAPABILITIES,
  UI_CAPABILITIES,
  UI_DASHBOARD_CAPABILITIES,
  UI_DASHBOARD_VERSION,
  UI_OPERATION_PROTOCOL_VERSION,
  UI_PROJECTION_VERSION,
  UI_PROTOCOL_LIMITS,
  hashUiProtocol,
  makeUiDashboard,
} from "../self-evolve-ui-protocol.js";

const PROJECT = "a".repeat(64);
const NOW = 1_000_000;
const CURRENT = "b".repeat(64);
const PROPOSED = "c".repeat(64);
const FIXTURE = new URL("./fixtures/ui-projection-publisher.mjs", import.meta.url);

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-ui-publication-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function overflow(includedCount) {
  return { truncated: false, includedCount, omittedCount: 0, omittedBytes: 0, reason: "none" };
}

function clientOffer(overrides = {}) {
  return {
    projectionVersions: [UI_PROJECTION_VERSION],
    operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION],
    capabilities: UI_CAPABILITIES,
    ...overrides,
  };
}

function bundle(root, {
  generation = "d".repeat(64),
  proposalId = "proposal-1",
  issuedAt = NOW,
  includeActions = true,
  includeDashboard = false,
  retentionDays = 30,
} = {}) {
  const rootIdentity = stateRootIdentity(root);
  const expiresAt = issuedAt + 60_000;
  const detailBody = {
    projectionVersion: UI_PROJECTION_VERSION,
    projectFingerprint: PROJECT,
    stateRootIdentity: rootIdentity,
    generation,
    proposalId,
    revision: 1,
    issuedAt,
    expiresAt,
    summary: {
      state: "pending",
      target: {
        relativePath: "demo/SKILL.md",
        currentHash: CURRENT,
        proposedContentHash: PROPOSED,
      },
      effectiveMode: "auto",
      rationale: "Bounded deterministic evidence supports this review.",
      risk: "low",
      criticScoreBasisPoints: 9_500,
      criticPassed: true,
      validDeterministic: true,
      injectionFlagged: false,
      tokenImpact: { estimatedTokens: 32, budgetTokens: 8_000 },
      eligibility: {
        eligible: true,
        reasons: ["all-thresholds-met"],
        checks: [{ name: "minIncidents", met: true, actual: 3, required: 3 }],
      },
      rollback: { eligible: false, reason: "not-applied", appliedHash: null },
      operation: { status: "idle", requestId: null, reason: null, updatedAt: null },
    },
    diff: {
      kind: "unified",
      lines: ["--- demo/SKILL.md", "+++ demo/SKILL.md", "-old", "+new"],
      overflow: overflow(4),
    },
    evidence: [],
    audit: [],
    allowedActions: includeActions ? [{
      action: "reject-proposal",
      capability: UI_ACTION_CAPABILITIES["reject-proposal"],
      nonce: "reject-nonce",
      expiresAt: issuedAt + 30_000,
    }] : [],
    overflow: {
      evidence: overflow(0),
      audit: overflow(0),
      allowedActions: overflow(includeActions ? 1 : 0),
    },
  };
  const detail = { ...detailBody, detailHash: hashUiProtocol("review-detail", detailBody) };
  const indexBody = {
    projectionVersion: UI_PROJECTION_VERSION,
    projectFingerprint: PROJECT,
    stateRootIdentity: rootIdentity,
    generation,
    issuedAt,
    expiresAt,
    capabilities: UI_CAPABILITIES,
    status: {
      state: "ready",
      reason: null,
      storedMode: "auto",
      effectiveMode: "auto",
      paused: false,
      killSwitchActive: false,
      repoExcluded: false,
      circuitBreakerOpen: false,
    },
    budgets: {
      passiveCallsPerHour: 6,
      synthesisPerDay: 24,
      tokensPerSynthesis: 8_000,
      concurrentObservationsPerProject: 1,
      concurrentSynthesesGlobal: 1,
      idleDebounceMs: 1_500,
      storageQuotaMiB: 8,
    },
    reviews: [{
      proposalId,
      state: "pending",
      target: "demo/SKILL.md",
      attention: "normal",
      updatedAt: issuedAt,
      detailRevision: 1,
      detailHash: detail.detailHash,
    }],
    operations: [],
    allowedActions: includeActions ? [{
      action: "set-paused",
      capability: UI_ACTION_CAPABILITIES["set-paused"],
      nonce: "pause-nonce",
      expiresAt: issuedAt + 30_000,
    }] : [],
    overflow: {
      reviews: overflow(1),
      operations: overflow(0),
      allowedActions: overflow(includeActions ? 1 : 0),
    },
  };
  const index = { ...indexBody, projectionHash: hashUiProtocol("projection-index", indexBody) };
  const dashboardBody = {
    dashboardVersion: UI_DASHBOARD_VERSION,
    projectFingerprint: PROJECT,
    stateRootIdentity: rootIdentity,
    generation,
    indexHash: index.projectionHash,
    generatedAt: issuedAt,
    capabilities: UI_DASHBOARD_CAPABILITIES,
    automation: { state: "ready", reason: null },
    blockers: [],
    inFlight: { active: false, count: 0, stage: null, startedAt: null },
    lastCycle: null,
    nextEligibleAt: null,
    usage: {
      passive: { used: 0, limit: 6, remaining: 6, resetAt: null },
      synthesis: { used: 0, limit: 24, remaining: 24, resetAt: null },
      storage: { usedBytes: 0, limitBytes: 8_388_608, remainingBytes: 8_388_608 },
    },
    rollout: {
      ready: false,
      synthesesObserved: 0,
      minSynthesesObserved: 10,
      successRateBasisPoints: 0,
      minSuccessRateBasisPoints: 8_000,
    },
    settings: {
      globalMode: "auto",
      repositoryMode: "inherit",
      effectiveMode: "auto",
      paused: false,
      killSwitchActive: false,
      repositoryExcluded: false,
      consent: {
        passiveCalls: true,
        durableObservations: true,
        sanitizedExcerpts: false,
        crossRepoAggregation: false,
      },
      approvedSkillFolderCount: 1,
    },
    retention: { observationsDays: retentionDays, operationalDays: retentionDays * 3 },
    supportedControls: ["set-paused"],
    activity: [],
    overflow: { activity: overflow(0) },
  };
  const dashboardV1Body = {
    ...dashboardBody,
    dashboardVersion: 1,
    retention: { observationsDays: retentionDays, operationalDays: 90 },
  };
  return {
    index,
    details: [detail],
    ...(includeDashboard
      ? {
          dashboard: { ...dashboardBody, dashboardHash: hashUiProtocol("dashboard", dashboardBody) },
          dashboardV1: { ...dashboardV1Body, dashboardHash: hashUiProtocol("dashboard", dashboardV1Body) },
        }
      : {}),
    offer: clientOffer(),
    now: issuedAt,
  };
}

function projectionRoot(root) {
  return path.join(root, "self-evolve", "bridge", PROJECT, "ui-projections");
}

function detailPath(root, generation) {
  const directory = path.join(projectionRoot(root), "generations", generation, "details");
  const names = readdirSync(directory);
  assert.equal(names.length, 1);
  return path.join(directory, names[0]);
}

function dashboardPath(root, generation, version = UI_DASHBOARD_VERSION) {
  return path.join(projectionRoot(root), "generations", generation, `dashboard-v${version}.json`);
}

function runPublisher(root, bundlePath) {
  return new Promise((resolve, reject) => {
    const resultPath = `${bundlePath}.result`;
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [FIXTURE.pathname, root, bundlePath, resultPath], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0) reject(new Error(`publisher failed (${code ?? signal}): ${stderr}`));
      else {
        try {
          resolve(JSON.parse(readFileSync(resultPath, "utf8")));
        } catch (error) {
          reject(new Error(`publisher result receipt was invalid: stderr=${JSON.stringify(stderr)}`, {
            cause: error,
          }));
        }
      }
    });
  });
}

test("publication is atomic, private, negotiated, and preserves the legacy inbox fallback", (t) => {
  const root = fixture(t);
  assert.equal(readUiProjection(root, PROJECT, { clientOffer: clientOffer() }).mode, "legacy");
  const value = bundle(root);
  const published = publishUiProjection(root, value);
  assert.equal(published.index.projectionHash, value.index.projectionHash);
  const files = [
    path.join(projectionRoot(root), "protocol-offer.json"),
    path.join(projectionRoot(root), "index.json"),
    detailPath(root, value.index.generation),
  ];
  assert.equal(files.every((file) => (readFileSync(file), true)), true);
  assert.equal(files.every((file) => (statMode(file) === 0o600)), true);
  assert.equal(statMode(projectionRoot(root)), 0o700);

  const native = readUiProjection(root, PROJECT, {
    now: NOW,
    clientOffer: clientOffer(),
    detailProposalIds: ["proposal-1"],
  });
  assert.equal(native.mode, "native");
  assert.equal(native.index.projectionHash, value.index.projectionHash);
  assert.equal(native.details[0].detailHash, value.details[0].detailHash);
  assert.deepEqual(native.effectiveIndexActions.map((action) => action.action), ["set-paused"]);
  assert.deepEqual(native.effectiveDetailActions["proposal-1"].map((action) => action.action), ["reject-proposal"]);

  const readOnly = readUiProjection(root, PROJECT, {
    now: NOW,
    clientOffer: clientOffer({ operationProtocolVersions: [] }),
    detailProposalIds: ["proposal-1"],
  });
  assert.equal(readOnly.mode, "read-only");
  assert.deepEqual(readOnly.effectiveIndexActions, []);
  assert.deepEqual(readOnly.effectiveDetailActions["proposal-1"].map((action) => action.action), ["reject-proposal"]);

  const oldTui = readUiProjection(root, PROJECT, {
    now: NOW,
    clientOffer: clientOffer({ projectionVersions: [2] }),
  });
  assert.equal(oldTui.mode, "legacy");
  assert.equal(oldTui.index, null);
  assert.deepEqual(readProjectInbox(root, PROJECT, { now: NOW }), []);
});

test("control-state publication uses Release A wire 0.2.1 and current readers accept it", (t) => {
  const root = fixture(t);
  const rootIdentity = stateRootIdentity(root);
  const state = publishControlState(root, {
    schemaVersion: "0.2.2",
    projectFingerprint: PROJECT,
    actor: "self-evolve-integration",
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    settingsUpdatedAt: NOW - 1,
    settingsVersion: "3".repeat(64),
    stateRootIdentity: rootIdentity,
    nonce: "release-a-control-state",
    mode: "manual",
    effectiveMode: "manual",
    allowedSkillRoots: [],
    consent: {
      passiveCalls: false,
      durableObservations: false,
      sanitizedExcerpts: false,
      crossRepoAggregation: false,
    },
    repoExcluded: false,
  });
  const controlStatePath = path.join(root, "self-evolve", "bridge", PROJECT, "control-state.json");
  const bytes = readFileSync(controlStatePath, "utf8");
  assert.equal(state.schemaVersion, BRIDGE_SCHEMA_VERSION);
  assert.equal(JSON.parse(bytes).schemaVersion, "0.2.1");
  assert.equal(readControlState(root, PROJECT, { now: NOW }).schemaVersion, "0.2.1");
  assert.match(bytes, /^\{"schemaVersion":"0\.2\.1","projectFingerprint"/u);
  assert.doesNotMatch(bytes, /0\.2\.2/u);
});

test("dashboard sidecars publish before the index, prefer v2, and degrade without invalidating core review", (t) => {
  const root = fixture(t);
  const first = bundle(root, { generation: "7".repeat(64) });
  publishUiProjection(root, first);
  const enhanced = bundle(root, { generation: "8".repeat(64), includeDashboard: true });
  assert.throws(() => publishUiProjection(root, {
    ...enhanced,
    __testFaultInjection(point) {
      if (point === "ui-projection-after-dashboard") throw new Error("fixture-after-dashboard");
    },
  }), /fixture-after-dashboard/u);
  assert.equal(readUiProjection(root, PROJECT, {
    now: NOW,
    clientOffer: clientOffer(),
  }).index.generation, first.index.generation);

  publishUiProjection(root, enhanced);
  const dashboardFile = dashboardPath(root, enhanced.index.generation);
  const dashboardV1File = dashboardPath(root, enhanced.index.generation, 1);
  assert.equal(statMode(dashboardFile), 0o600);
  assert.equal(statMode(dashboardV1File), 0o600);
  const read = readUiProjection(root, PROJECT, {
    now: NOW,
    clientOffer: clientOffer(),
    detailProposalIds: ["proposal-1"],
  });
  assert.equal(read.dashboard.dashboardHash, enhanced.dashboard.dashboardHash);
  assert.equal(read.dashboard.dashboardVersion, UI_DASHBOARD_VERSION);
  assert.equal(read.dashboard.indexHash, read.index.projectionHash);
  assert.equal(read.dashboardError, null);
  const dashboardWithReducedCoreOffer = readUiProjection(root, PROJECT, {
    now: NOW,
    clientOffer: clientOffer({
      capabilities: UI_CAPABILITIES.filter((capability) => capability !== "operation-export-v1"),
    }),
  });
  assert.equal(dashboardWithReducedCoreOffer.dashboard.dashboardHash, enhanced.dashboard.dashboardHash);
  assert.equal(dashboardWithReducedCoreOffer.dashboardError, null);

  writeFileSync(dashboardFile, "{}\n", { mode: 0o600 });
  const invalidV2 = readUiProjection(root, PROJECT, {
    now: NOW,
    clientOffer: clientOffer(),
    detailProposalIds: ["proposal-1"],
  });
  assert.equal(invalidV2.index.projectionHash, enhanced.index.projectionHash);
  assert.equal(invalidV2.details[0].detailHash, enhanced.details[0].detailHash);
  assert.equal(invalidV2.dashboard, null);
  assert.match(invalidV2.dashboardError, /ui-dashboard/u);
  assert.equal(Buffer.byteLength(invalidV2.dashboardError, "utf8") <= UI_PROTOCOL_LIMITS.reasonBytes, true);

  unlinkSync(dashboardFile);
  const fallback = readUiProjection(root, PROJECT, {
    now: NOW,
    clientOffer: clientOffer(),
  });
  assert.equal(fallback.dashboard.dashboardVersion, 1);
  assert.equal(fallback.dashboardError, null);

  writeFileSync(dashboardV1File, "{}\n", { mode: 0o600 });
  const degraded = readUiProjection(root, PROJECT, {
    now: NOW,
    clientOffer: clientOffer(),
    detailProposalIds: ["proposal-1"],
  });
  assert.equal(degraded.index.projectionHash, enhanced.index.projectionHash);
  assert.equal(degraded.details[0].detailHash, enhanced.details[0].detailHash);
  assert.equal(degraded.dashboard, null);
  assert.match(degraded.dashboardError, /ui-dashboard/u);
  const cleaned = cleanupBridge(root, PROJECT, { now: NOW });
  assert.equal(cleaned.ok, true);
  assert.equal(existsSync(dashboardFile), false);
  assert.equal(existsSync(dashboardV1File), false);
  assert.equal(existsSync(path.join(projectionRoot(root), "index.json")), true);

  const { dashboardHash: _hash, ...wrongBody } = enhanced.dashboard;
  const wrongBindingBody = { ...wrongBody, indexHash: "f".repeat(64) };
  assert.throws(() => publishUiProjection(root, {
    ...enhanced,
    dashboard: {
      ...wrongBindingBody,
      dashboardHash: hashUiProtocol("dashboard", wrongBindingBody),
    },
  }), /stale-projection/u);
});

test("dashboard sidecars preserve old-server and old-TUI retention compatibility", (t) => {
  const oldServerRoot = fixture(t);
  const oldServerBundle = bundle(oldServerRoot, {
    generation: "5".repeat(64),
    includeDashboard: true,
    retentionDays: 10,
  });
  const { dashboardV1: oldDashboard, ...oldServerValues } = oldServerBundle;
  publishUiProjection(oldServerRoot, { ...oldServerValues, dashboard: oldDashboard });

  const currentReader = readUiProjection(oldServerRoot, PROJECT, {
    now: NOW,
    clientOffer: clientOffer(),
  });
  assert.equal(currentReader.dashboard.dashboardVersion, 1);
  assert.deepEqual(currentReader.dashboard.retention, {
    observationsDays: 10,
    operationalDays: 90,
  });
  assert.equal(currentReader.dashboardError, null);

  const currentServerRoot = fixture(t);
  const currentServerBundle = bundle(currentServerRoot, {
    generation: "6".repeat(64),
    includeDashboard: true,
    retentionDays: 3_650,
  });
  publishUiProjection(currentServerRoot, currentServerBundle);
  const current = readUiProjection(currentServerRoot, PROJECT, {
    now: NOW,
    clientOffer: clientOffer(),
  });
  assert.equal(current.dashboard.dashboardVersion, UI_DASHBOARD_VERSION);
  assert.deepEqual(current.dashboard.retention, {
    observationsDays: 3_650,
    operationalDays: 10_950,
  });

  const v1Value = JSON.parse(readFileSync(
    dashboardPath(currentServerRoot, current.index.generation, 1),
    "utf8",
  ));
  const oldTuiDashboard = makeUiDashboard(v1Value, {
    projectFingerprint: PROJECT,
    stateRootIdentity: stateRootIdentity(currentServerRoot),
    generation: current.index.generation,
    indexHash: current.index.projectionHash,
    now: NOW,
  });
  assert.equal(oldTuiDashboard.dashboardVersion, 1);
  assert.deepEqual(oldTuiDashboard.retention, {
    observationsDays: 3_650,
    operationalDays: 90,
  });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(
    path.join(projectionRoot(currentServerRoot), "protocol-offer.json"),
    "utf8",
  ))), ["projectionVersions", "operationProtocolVersions", "capabilities"]);
});

test("publication permits a non-writable shared state-root mode but rejects writable roots before creating artifacts", (t) => {
  const readableRoot = fixture(t);
  chmodSync(readableRoot, 0o755);
  publishUiProjection(readableRoot, bundle(readableRoot));
  assert.equal(statMode(projectionRoot(readableRoot)), 0o700);

  const writableRoot = fixture(t);
  chmodSync(writableRoot, 0o733);
  assert.throws(() => publishUiProjection(writableRoot, bundle(writableRoot)), /permissions-rejected/u);
  assert.equal(existsSync(projectionRoot(writableRoot)), false);

  const writableAncestorRoot = fixture(t);
  const projectBridge = path.join(writableAncestorRoot, "self-evolve", "bridge", PROJECT);
  mkdirSync(projectBridge, { recursive: true, mode: 0o700 });
  chmodSync(path.join(writableAncestorRoot, "self-evolve", "bridge"), 0o733);
  assert.throws(() => publishUiProjection(writableAncestorRoot, bundle(writableAncestorRoot)), /ancestor-permissions-rejected/u);
  assert.equal(existsSync(projectionRoot(writableAncestorRoot)), false);
});

function statMode(filePath) {
  return statSync(filePath).mode & 0o777;
}

test("interrupted generation replacement leaves the prior index readable and converges on retry", (t) => {
  const root = fixture(t);
  const first = bundle(root, { generation: "1".repeat(64) });
  const second = bundle(root, { generation: "2".repeat(64), includeDashboard: true });
  publishUiProjection(root, first);
  const fsyncedBeforeIndex = [];
  const directoryChainBeforeIndex = [];
  const durabilityOrder = [];
  assert.throws(() => publishUiProjection(root, {
    ...second,
    __testAfterDirectoryFsync({ filePath }) {
      const relative = path.relative(projectionRoot(root), filePath).split(path.sep).join("/");
      fsyncedBeforeIndex.push(relative);
      durabilityOrder.push(`file:${relative}`);
    },
    __testAfterDirectoryChainFsync({ directory }) {
      directoryChainBeforeIndex.push(directory);
      durabilityOrder.push(`directory:${directory}`);
    },
    __testFaultInjection(point) {
      if (point === "ui-projection-before-index") {
        durabilityOrder.push("before-index");
        throw new Error("fixture-before-index");
      }
    },
  }), /fixture-before-index/u);
  const projection = projectionRoot(root);
  const generationRoot = path.join(projection, "generations", second.index.generation);
  assert.deepEqual(directoryChainBeforeIndex, [
    path.join(generationRoot, "details"),
    generationRoot,
    path.join(projection, "generations"),
    projection,
    path.join(root, "self-evolve", "bridge", PROJECT),
    path.join(root, "self-evolve", "bridge"),
    path.join(root, "self-evolve"),
    root,
  ]);
  assert.equal(fsyncedBeforeIndex.some((file) => /\/details\/[a-f0-9]{64}\.json$/u.test(file)), true);
  assert.equal(fsyncedBeforeIndex.includes(`generations/${second.index.generation}/dashboard-v1.json`), true);
  assert.equal(fsyncedBeforeIndex.includes(`generations/${second.index.generation}/dashboard-v2.json`), true);
  assert.equal(fsyncedBeforeIndex.at(-1), "protocol-offer.json");
  assert.equal(fsyncedBeforeIndex.includes("index.json"), false);
  assert.equal(durabilityOrder.indexOf(`directory:${root}`) < durabilityOrder.indexOf("file:protocol-offer.json"), true);
  assert.equal(durabilityOrder.at(-1), "before-index");
  assert.equal(readUiProjection(root, PROJECT, {
    now: NOW,
    clientOffer: clientOffer(),
  }).index.generation, first.index.generation);
  assert.deepEqual(
    readdirSync(path.join(projectionRoot(root), "generations")).sort(),
    [first.index.generation, second.index.generation].sort(),
  );
  const fsyncedOnCommit = [];
  publishUiProjection(root, {
    ...second,
    __testAfterDirectoryFsync({ filePath }) {
      fsyncedOnCommit.push(path.relative(projectionRoot(root), filePath).split(path.sep).join("/"));
    },
  });
  assert.equal(fsyncedOnCommit.at(-1), "index.json");
  assert.equal(readUiProjection(root, PROJECT, {
    now: NOW,
    clientOffer: clientOffer(),
  }).index.generation, second.index.generation);
  assert.deepEqual(readdirSync(path.join(projectionRoot(root), "generations")), [second.index.generation]);

  const orphan = path.join(projectionRoot(root), "generations", second.index.generation, "details", ".abandoned-write.tmp");
  writeFileSync(orphan, "partial", { mode: 0o600 });
  publishUiProjection(root, second);
  assert.equal(existsSync(orphan), false);
});

test("publication and reads reject cross-root and cross-project artifacts", (t) => {
  const firstRoot = fixture(t);
  const secondRoot = fixture(t);
  const value = bundle(firstRoot);
  assert.throws(() => publishUiProjection(secondRoot, value), /cross-root/u);
  publishUiProjection(firstRoot, value);
  assert.throws(() => readUiProjection(firstRoot, PROJECT, {
    now: NOW,
    stateRootIdentity: "f".repeat(64),
    clientOffer: clientOffer(),
  }), /cross-root/u);

  const foreignProject = "e".repeat(64);
  const { detailHash: _detailHash, ...detailBody } = value.details[0];
  const foreignDetailBody = { ...detailBody, projectFingerprint: foreignProject };
  const foreignDetail = {
    ...foreignDetailBody,
    detailHash: hashUiProtocol("review-detail", foreignDetailBody),
  };
  const malformed = {
    ...value,
    details: [foreignDetail],
  };
  assert.throws(() => publishUiProjection(firstRoot, malformed), /cross-project/u);
});

test("readers reject missing, mismatched, replaced, hard-linked, and permissive artifacts", (t) => {
  const cases = [
    ["missing detail", (root, value) => rmSync(detailPath(root, value.index.generation)), /detail-unavailable/u],
    ["mismatched detail", (root, value) => writeFileSync(detailPath(root, value.index.generation), "{}\n"), /ui-review-detail/u],
    ["permissive detail", (root, value) => chmodSync(detailPath(root, value.index.generation), 0o644), /mode-rejected/u],
    ["hard-linked detail", (root, value) => linkSync(detailPath(root, value.index.generation), path.join(root, "linked-detail")), /hardlink-rejected/u],
  ];
  for (const [label, mutate, pattern] of cases) {
    const root = mkdtempSync(path.join(tmpdir(), "self-evolve-ui-defense-"));
    try {
      const value = bundle(root);
      publishUiProjection(root, value);
      mutate(root, value);
      assert.throws(() => readUiProjection(root, PROJECT, {
        now: NOW,
        clientOffer: clientOffer(),
        detailProposalIds: ["proposal-1"],
      }), pattern, label);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const root = fixture(t);
  const value = bundle(root);
  publishUiProjection(root, value);
  const outside = path.join(root, "outside-index");
  writeFileSync(outside, `${JSON.stringify(value.index)}\n`);
  rmSync(path.join(projectionRoot(root), "index.json"));
  symlinkSync(outside, path.join(projectionRoot(root), "index.json"));
  assert.throws(() => readUiProjection(root, PROJECT, {
    now: NOW,
    clientOffer: clientOffer(),
  }), /path-rejected|symlink/u);
});

test("an index inode replaced during a read is rejected even when bytes are identical", (t) => {
  const root = fixture(t);
  const value = bundle(root);
  publishUiProjection(root, value);
  assert.throws(() => readUiProjection(root, PROJECT, {
    now: NOW,
    clientOffer: clientOffer(),
    detailProposalIds: ["proposal-1"],
    __testAfterIndexRead() {
      publishUiProjection(root, value);
    },
  }), /index-replaced/u);
});

test("a protocol offer inode replaced during a read is rejected even when bytes are identical", (t) => {
  const root = fixture(t);
  const value = bundle(root);
  publishUiProjection(root, value);
  const offerPath = path.join(projectionRoot(root), "protocol-offer.json");
  assert.throws(() => readUiProjection(root, PROJECT, {
    now: NOW,
    clientOffer: clientOffer(),
    detailProposalIds: ["proposal-1"],
    __testAfterDetailsRead() {
      const replacement = path.join(projectionRoot(root), ".offer-replacement.tmp");
      writeFileSync(replacement, readFileSync(offerPath), { mode: 0o600 });
      renameSync(replacement, offerPath);
    },
  }), /offer-replaced/u);
});

test("quota pressure refuses a growing projection before any artifact file is published", (t) => {
  const root = fixture(t);
  const store = openStore(root, { projectFingerprint: PROJECT, projectName: "quota" });
  store.close();
  const settingsPath = path.join(root, "self-evolve", PROJECT, "settings.json");
  writeFileSync(settingsPath, `${JSON.stringify(makeRepoSettings({
    projectFingerprint: PROJECT,
    budgets: { storageQuotaMiB: 0 },
  }))}\n`, { mode: 0o600 });
  assert.throws(() => publishUiProjection(root, bundle(root)), /byte-quota-exceeded/u);
  assert.equal(existsSync(path.join(projectionRoot(root), "index.json")), false);
});

test("cleanup removes expired projections and project/all purge remove every derived artifact", (t) => {
  const root = fixture(t);
  const store = openStore(root, { projectFingerprint: PROJECT, projectName: "purge", now: () => NOW });
  publishUiProjection(root, bundle(root));
  assert.equal(existsSync(projectionRoot(root)), true);
  const cleanup = cleanupBridge(root, PROJECT, { now: NOW + 60_001 });
  assert.equal(cleanup.ok, true);
  assert.equal(cleanup.removed >= 3, true);
  assert.equal(existsSync(projectionRoot(root)), false);

  publishUiProjection(root, bundle(root));
  assert.equal(store.purge({ scope: "project" }).ok, true);
  assert.equal(existsSync(path.join(root, "self-evolve", "bridge", PROJECT)), false);
  publishUiProjection(root, bundle(root));
  assert.equal(store.purge({ scope: "all" }).ok, true);
  assert.equal(existsSync(path.join(root, "self-evolve")), false);
});

test("derived projections remain quota-covered but are explicitly excluded from user exports", (t) => {
  const root = fixture(t);
  const store = openStore(root, { projectFingerprint: PROJECT, projectName: "export", now: () => NOW });
  const value = bundle(root);
  publishUiProjection(root, value);
  const archive = store.exportProject();
  const serialized = JSON.stringify(archive);
  assert.doesNotMatch(serialized, new RegExp(value.index.projectionHash, "u"));
  assert.doesNotMatch(serialized, /Bounded deterministic evidence supports this review/u);
  assert.equal(store.getProjectUsage().bytesUsed > 0, true);
});

test("real processes serialize write bursts and leave one fully readable generation", async (t) => {
  const root = fixture(t);
  const bundlePaths = [];
  for (const digit of ["3", "4", "5", "6"]) {
    const value = bundle(root, { generation: digit.repeat(64) });
    const filePath = path.join(root, `bundle-${digit}.json`);
    writeFileSync(filePath, JSON.stringify(value));
    bundlePaths.push(filePath);
  }
  const results = await Promise.all(bundlePaths.map((filePath) => runPublisher(root, filePath)));
  assert.equal(new Set(results.map((result) => result.generation)).size, 4);
  const read = readUiProjection(root, PROJECT, {
    now: NOW,
    clientOffer: clientOffer(),
    detailProposalIds: ["proposal-1"],
  });
  assert.equal(results.some((result) => result.generation === read.index.generation), true);
  assert.equal(read.details[0].detailHash, read.index.reviews[0].detailHash);
  assert.deepEqual(readdirSync(path.join(projectionRoot(root), "generations")), [read.index.generation]);
});
