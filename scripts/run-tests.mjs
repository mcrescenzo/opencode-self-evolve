// Runs the test suite inside a disposable TMPDIR sandbox.
//
// Tests create scratch directories with mkdtempSync(tmpdir(), ...) and several forget to remove
// them, so a bare `node --test` leaked ~218 directories per run into the shared /tmp. Pointing
// TMPDIR at a per-run sandbox makes that structurally impossible to escape: whatever a test forgets
// is removed with the sandbox, and the leftover count is reported so regressions stay visible
// instead of silently accumulating on developer machines.
//
// Individual tests should still clean up after themselves; this is the backstop, not a substitute.

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(repoRoot, "tests");

const testFiles = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join(testDir, name));

if (!testFiles.length) {
  console.error("no test files found in tests/");
  process.exit(1);
}

const sandbox = mkdtempSync(path.join(tmpdir(), "self-evolve-testrun-"));

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  let leaked = 0;
  try { leaked = readdirSync(sandbox).length; } catch { leaked = 0; }
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }
  if (leaked) console.error(`\nnote: tests left ${leaked} entr${leaked === 1 ? "y" : "ies"} in the temp sandbox; removed with it.`);
}

const child = spawn(process.execPath, ["--test", ...process.argv.slice(2), ...testFiles], {
  cwd: repoRoot,
  stdio: "inherit",
  env: { ...process.env, TMPDIR: sandbox, TMP: sandbox, TEMP: sandbox },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { child.kill(signal); });
}

child.on("error", (error) => { cleanup(); console.error(error.message); process.exit(1); });
child.on("close", (code, signal) => {
  cleanup();
  if (signal) { process.kill(process.pid, signal); return; }
  process.exit(code ?? 1);
});
