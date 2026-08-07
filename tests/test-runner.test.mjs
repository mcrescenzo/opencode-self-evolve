import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const RUNNER = path.resolve(import.meta.dirname, "../scripts/run-tests.mjs");

function runFixture(t, fixture) {
  const outer = mkdtempSync(path.join(tmpdir(), "self-evolve-runner-test-"));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [RUNNER], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      TMPDIR: outer,
      TMP: outer,
      TEMP: outer,
      SELF_EVOLVE_TEST_FILES: JSON.stringify([`tests/fixtures/test-runner/${fixture}.mjs`]),
    },
  });
  assert.deepEqual(readdirSync(outer), [], "the wrapper must remove its nested sandbox");
  return result;
}

test("test wrapper accepts a clean focused run", (t) => {
  const result = runFixture(t, "clean");
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /unexplained temp sandbox entries/u);
});

test("test wrapper rejects and names residue after a successful child run", (t) => {
  const result = runFixture(t, "leak-success");
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /unexplained temp sandbox entries \(1\): "leaked-success"/u);
});

test("test wrapper reports residue without masking a child test failure", (t) => {
  const result = runFixture(t, "leak-failure");
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /injected child failure/u);
  assert.match(result.stderr, /unexplained temp sandbox entries \(1\): "leaked-failure"/u);
});
