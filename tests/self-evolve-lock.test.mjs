import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { withStateMutationLock } from "../self-evolve-lock.js";

const workerPath = fileURLToPath(new URL("./fixtures/mutation-lock-worker.mjs", import.meta.url));

function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) resolve();
      else if (Date.now() >= deadline) reject(new Error("test-barrier-timeout"));
      else setTimeout(check, 2);
    };
    check();
  });
}

function spawnWorker(args) {
  const child = spawn(process.execPath, [workerPath, ...args], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`worker failed (${code ?? signal}): ${stderr}`));
    });
  });
  return { child, exited };
}

test("reentrant mutation locks reject asynchronous actions", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => withStateMutationLock(root, () => withStateMutationLock(root, () => Promise.resolve("unsafe"))),
    /mutation-lock-action-must-be-synchronous/u,
  );
});

test("a post-create acquisition failure removes the lock file it created", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-create-failure-"));
  const lockPath = path.join(root, ".self-evolve-mutation.lock");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.throws(() => withStateMutationLock(root, () => "unreachable", {
    onLockCreated() {
      const error = new Error("injected-lock-initialization-failure");
      error.code = "EIO";
      throw error;
    },
  }), /injected-lock-initialization-failure/u);
  assert.equal(existsSync(lockPath), false);
  assert.equal(withStateMutationLock(root, () => "acquired"), "acquired");
  assert.equal(existsSync(lockPath), false);
});

test("a stale recovery claim left by a dead process self-expires", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-stale-claim-"));
  const lockPath = path.join(root, ".self-evolve-mutation.lock");
  const claimPath = `${lockPath}.stale-recovery`;
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(lockPath, `${JSON.stringify({ pid: 2_147_483_647, nonce: "stale-owner", acquiredAt: 0 })}\n`);
  writeFileSync(claimPath, `${JSON.stringify({ pid: 2_147_483_647, nonce: "dead-recovery", acquiredAt: 0 })}\n`);
  utimesSync(lockPath, new Date(0), new Date(0));
  utimesSync(claimPath, new Date(0), new Date(0));

  assert.equal(withStateMutationLock(root, () => "recovered", { staleLockMs: 1, lockTimeoutMs: 200 }), "recovered");
  assert.equal(existsSync(lockPath), false);
  assert.equal(existsSync(claimPath), false);
});

test("stale recovery does not displace a live replacement lock", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-"));
  const lockPath = path.join(root, ".self-evolve-mutation.lock");
  const observedPath = path.join(root, "stale-observed");
  const recoverReleasePath = path.join(root, "release-recovery");
  const recoverEnteredPath = path.join(root, "recovery-entered");
  const replacementEnteredPath = path.join(root, "replacement-entered");
  const replacementReleasePath = path.join(root, "release-replacement");
  const children = [];
  const exits = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.allSettled(exits);
    rmSync(root, { recursive: true, force: true });
  });

  writeFileSync(lockPath, `${JSON.stringify({ pid: 2_147_483_647, nonce: "stale", acquiredAt: 0 })}\n`);
  utimesSync(lockPath, new Date(0), new Date(0));
  const recovery = spawnWorker([root, "recovery", observedPath, recoverReleasePath, recoverEnteredPath]);
  children.push(recovery.child);
  exits.push(recovery.exited);
  await waitFor(() => existsSync(observedPath));

  unlinkSync(lockPath);
  const replacement = spawnWorker([
    root,
    "replacement",
    path.join(root, "unused"),
    replacementReleasePath,
    replacementEnteredPath,
  ]);
  children.push(replacement.child);
  exits.push(replacement.exited);
  await waitFor(() => existsSync(replacementEnteredPath));

  writeFileSync(recoverReleasePath, "release\n");
  await recovery.exited;
  assert.equal(existsSync(recoverEnteredPath), false);
  assert.equal(existsSync(lockPath), true);
  assert.equal(existsSync(`${replacementEnteredPath}.displaced`), false);

  writeFileSync(replacementReleasePath, "release\n");
  await replacement.exited;
  assert.equal(existsSync(lockPath), false);
});
