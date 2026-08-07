// Runs the test suite inside a disposable TMPDIR sandbox.
//
// Every test owns its temporary resources. The sandbox is a containment backstop and verification
// boundary: any unexplained top-level entry fails the run, and the sandbox is always removed.

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(repoRoot, "tests");

const requestedFiles = process.env.SELF_EVOLVE_TEST_FILES;
const testFiles = requestedFiles
  ? JSON.parse(requestedFiles).map((name) => path.resolve(repoRoot, name))
  : readdirSync(testDir)
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
  if (cleaned) return [];
  cleaned = true;
  let entries = [];
  try { entries = readdirSync(sandbox).sort(); } catch { entries = []; }
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }
  return entries;
}

const childEnv = { ...process.env, TMPDIR: sandbox, TMP: sandbox, TEMP: sandbox, NODE_DISABLE_COMPILE_CACHE: "1" };
delete childEnv.NODE_COMPILE_CACHE;
delete childEnv.NODE_TEST_CONTEXT;
const child = spawn(process.execPath, ["--test", ...process.argv.slice(2), ...testFiles], {
  cwd: repoRoot,
  stdio: "inherit",
  env: childEnv,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { child.kill(signal); });
}

child.on("error", (error) => { cleanup(); console.error(error.message); process.exit(1); });
child.on("close", (code, signal) => {
  const entries = cleanup();
  if (entries.length) {
    const shown = entries.slice(0, 32).map((name) => JSON.stringify(name)).join(", ");
    const omitted = entries.length > 32 ? `, ... ${entries.length - 32} more` : "";
    console.error(`\nunexplained temp sandbox entries (${entries.length}): ${shown}${omitted}`);
  }
  if (signal) { process.kill(process.pid, signal); return; }
  process.exit(entries.length ? 1 : (code ?? 1));
});
