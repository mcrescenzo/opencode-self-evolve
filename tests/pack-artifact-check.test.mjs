import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  assertApprovedTuiPackageContract,
  assertCurrentTuiArtifact,
  assertGeneratedTuiArtifact,
} from "../scripts/check-tui-artifact.mjs";
import { assertNoForbiddenImports, assertServerEntryContract, assertSpawnSucceeded } from "../scripts/pack-artifact-check.mjs";
import { parseExact118Version, resolveLatestCommon18 } from "../scripts/packed-tui-consumer-matrix.mjs";
import { createIntegration } from "../self-evolve-integration.js";
import * as schemas from "../self-evolve-schemas.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const script = path.join(repoRoot, "scripts", "pack-artifact-check.mjs");

function runPackCheck(root = repoRoot) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SELF_EVOLVE_PACK_ROOT: root },
  });
}

test("pack artifact check passes for the release package", () => {
  const result = runPackCheck();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /deterministic built TUI target validated and root plus explicit server targets imported from a fresh peerless consumer/u);
  assert.match(result.stdout, /Packed artifact SHA-256: [a-f0-9]{64}/u);
  assert.match(result.stdout, /Packed inventory SHA-256: [a-f0-9]{64}/u);
});

test("pack artifact check rejects a forbidden package files entry", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-pack-tamper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageJSON = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  for (const file of ["README.md", "LICENSE", ...packageJSON.files]) {
    cpSync(path.join(repoRoot, file), path.join(root, file), { recursive: true });
  }
  packageJSON.files.push(".env");
  writeFileSync(path.join(root, "package.json"), `${JSON.stringify(packageJSON, null, 2)}\n`);
  writeFileSync(path.join(root, ".env"), "SECRET=synthetic\n");

  const result = runPackCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /forbidden private runtime state: \.env/u);
});

test("pack import scanner rejects prohibited runtime modules", () => {
  assert.throws(
    () => assertNoForbiddenImports("unsafe.js", 'import "node:http";'),
    /unsafe\.js imports prohibited runtime modules: node:http/u,
  );
});

test("pack scanner rejects named server exports and TUI imports", () => {
  assert.doesNotThrow(() => assertServerEntryContract("export default function Plugin() {}\n"));
  assert.throws(() => assertServerEntryContract("export const helper = 1; export default function Plugin() {}\n"), /no named exports/u);
  assert.throws(() => assertServerEntryContract('import "@opencode-ai/plugin/tui"; export default function Plugin() {}\n'), /prohibited TUI/u);
});

test("approved built TUI package contract is exact and rejects dependency drift", () => {
  const packageJSON = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const source = readFileSync(path.join(repoRoot, "self-evolve-tui.tsx"), "utf8");
  assert.equal(assertApprovedTuiPackageContract(packageJSON, source), true);
  assert.throws(
    () => assertApprovedTuiPackageContract({ ...packageJSON, dependencies: { solid: "latest" } }, source),
    /ordinary runtime dependencies are prohibited/u,
  );
  assert.throws(
    () => assertApprovedTuiPackageContract({
      ...packageJSON,
      peerDependencies: { ...packageJSON.peerDependencies, "solid-js": "^1.9.12" },
    }, source),
    /optional peer contract does not match maintainer approval/u,
  );
});

test("generated TUI inventory rejects bundled runtimes and stale content", () => {
  const generated = readFileSync(path.join(repoRoot, "self-evolve-tui.generated.js"), "utf8");
  assert.equal(assertGeneratedTuiArtifact(generated), true);
  assert.equal(assertCurrentTuiArtifact(generated, generated), true);
  assert.throws(() => assertCurrentTuiArtifact(generated, `${generated}\n// stale`), /artifact is stale/u);
  assert.throws(
    () => assertGeneratedTuiArtifact(`${generated}\nfunction createScheduler() {}`),
    /bundled prohibited runtime content/u,
  );
  assert.throws(
    () => assertGeneratedTuiArtifact(`${generated}\nconst legacy = jsxDEV("text", {});`),
    /supported OpenTUI Solid transform/u,
  );
});

test("TUI matrix resolver selects only the latest exact common stable 1.18.x patch", () => {
  assert.deepEqual(parseExact118Version("1.18.12"), { version: "1.18.12", patch: 12 });
  for (const invalid of ["1.18.03", "1.18.4-beta.1", "1.19.0", "v1.18.4", "1.18"]) {
    assert.equal(parseExact118Version(invalid), null);
  }
  assert.equal(
    resolveLatestCommon18(["1.18.3", "1.18.4", "1.18.9", "1.19.0"], ["1.18.3", "1.18.4", "1.18.8", "1.18.9"]),
    "1.18.9",
  );
  assert.throws(() => resolveLatestCommon18(["1.18.2", "1.19.0"], ["1.18.2"]), /no-common-stable/u);
});

test("pack command diagnostics distinguish spawn, signal, and exit failures", () => {
  for (const code of ["ENOENT", "EACCES", "EPERM"]) {
    const error = Object.assign(new Error(`synthetic ${code}`), { code });
    assert.throws(
      () => assertSpawnSucceeded({ error, status: null }, "npm", ["pack"]),
      new RegExp(`could not be executed \\(${code}\\)`),
    );
  }
  assert.throws(
    () => assertSpawnSucceeded({ signal: "SIGTERM", status: null }, "npm", ["pack"]),
    /terminated by signal SIGTERM/u,
  );
  assert.throws(
    () => assertSpawnSucceeded({ status: 7, stdout: "", stderr: "synthetic failure" }, "npm", ["pack"]),
    /exited with status 7[\s\S]*synthetic failure/u,
  );
});

test("integration boot aborts only active orphaned self-evolve analyzer sessions", async () => {
  const aborted = [];
  const records = [];
  const settings = {
    global: schemas.makeGlobalSettings(),
    repo: schemas.makeRepoSettings({ projectFingerprint: "a".repeat(64) }),
  };
  const store = {
    getSettings: () => settings,
    readRecords: () => [],
    appendRecord(record) { records.push(record); return { ok: true }; },
    retain: () => ({ observations: 0 }),
    cleanupExpiredLeases: () => undefined,
    // Recovery (self-evolve-3r4) requires a durable dead-owner proof. Only
    // "orphan-synth" has one; the foreign same-name analyzer does not and must
    // NOT be aborted even though it matches the hidden-agent name filter.
    hostOwnerStatus(id) {
      if (id === "orphan-synth") return { classification: "abortable", nonce: "dead-owner-nonce", reason: "host-owner-process-dead" };
      return { classification: "unknown", reason: "host-owner-not-found" };
    },
    releaseHostOwner(id, nonce) { return nonce === "dead-owner-nonce" ? { ok: true } : { ok: false, absent: true }; },
    close() {},
  };
  const integration = createIntegration({
    store,
    inventory: {},
    privacy: {},
    schemas,
    observation: {},
    synthesisModule: {},
    applier: { recoverPending: () => [], circuitBreakerOpen: () => false, close() {} },
    commands: { createCommandPolicy: () => ({ execute: () => ({}) }) },
    pipeline: { createPipeline: () => ({}) },
    scheduler: { createScheduler: () => ({ setMode() {}, getCircuitBreaker: () => ({ open: false }), dispose() {} }) },
  });
  const ctx = { directory: "/workspace/project", client: { session: {
    list: async () => ({ data: [
      { id: "orphan-synth", agent: "self-evolve-synthesizer", state: "running" },
      { id: "foreign-analyzer", agent: "self-evolve-analyzer", state: "running" },
      { id: "finished-critic", agent: "self-evolve-critic", state: "completed" },
      { id: "working-session", agent: "build", state: "running" },
    ] }),
    abort: async (input) => { aborted.push(input.path?.id ?? input.sessionID ?? input.id ?? input); return { data: {} }; },
  } } };

  const result = await integration.boot({ ctx, hostVersion: "1.18.3" });
  assert.equal(result.ok, true);
  assert.deepEqual(aborted, ["orphan-synth"]);
  assert.equal(result.hiddenSessionRecovery.find((item) => item.id === "orphan-synth").action, "aborted");
  assert.equal(result.hiddenSessionRecovery.find((item) => item.id === "foreign-analyzer").action, "unknown");
  assert.equal(records.some((record) => record.payload.details.abortedHiddenSessions === 1), true);
  await integration.shutdown();
});
