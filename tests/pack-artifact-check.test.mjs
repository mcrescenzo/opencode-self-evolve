import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assertNoForbiddenImports, assertServerEntryContract } from "../scripts/pack-artifact-check.mjs";
import { createIntegration } from "../self-evolve-integration.js";
import * as schemas from "../self-evolve-schemas.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
  assert.match(result.stdout, /server and TUI targets imported from a fresh consumer/u);
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
      { id: "finished-critic", agent: "self-evolve-critic", state: "completed" },
      { id: "working-session", agent: "build", state: "running" },
    ] }),
    abort: async (input) => { aborted.push(input.path?.id ?? input.sessionID ?? input.id ?? input); return { data: {} }; },
  } } };

  const result = await integration.boot({ ctx, hostVersion: "1.18.3" });
  assert.equal(result.ok, true);
  assert.deepEqual(aborted, ["orphan-synth"]);
  assert.deepEqual(result.hiddenSessionRecovery, [{ id: "orphan-synth", ok: true }]);
  assert.equal(records.some((record) => record.payload.details.abortedHiddenSessions === 1), true);
  await integration.shutdown();
});
