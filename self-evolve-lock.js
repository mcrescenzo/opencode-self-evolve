import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const heldStateMutationLocks = new Map();

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function stateMutationLockHeld(rootDir) {
  return heldStateMutationLocks.has(path.resolve(String(rootDir)));
}

export function withStateMutationLock(rootDir, action, {
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  staleLockMs = DEFAULT_STALE_LOCK_MS,
} = {}) {
  if (typeof action !== "function") throw new TypeError("mutation-lock-action-required");
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) throw new TypeError("invalid-lock-timeout");
  if (!Number.isSafeInteger(staleLockMs) || staleLockMs < 1) throw new TypeError("invalid-stale-lock-window");
  const root = path.resolve(String(rootDir));
  const reentrant = heldStateMutationLocks.get(root);
  if (reentrant) {
    reentrant.depth += 1;
    try { return action(); } finally { reentrant.depth -= 1; }
  }

  mkdirSync(root, { recursive: true, mode: DIR_MODE });
  const lockPath = path.join(root, ".self-evolve-mutation.lock");
  const deadline = Date.now() + lockTimeoutMs;
  const nonce = randomBytes(24).toString("hex");
  while (Date.now() <= deadline) {
    let descriptor;
    try {
      descriptor = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, FILE_MODE);
      writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, nonce, acquiredAt: Date.now() })}\n`, "utf8");
      closeSync(descriptor);
      descriptor = undefined;
      sleep(2);
      const confirmed = JSON.parse(readFileSync(lockPath, "utf8"));
      if (confirmed.pid !== process.pid || confirmed.nonce !== nonce) continue;
      heldStateMutationLocks.set(root, { depth: 1, nonce, lockPath });
      break;
    } catch (error) {
      if (descriptor !== undefined) try { closeSync(descriptor); } catch {}
      if (error?.code !== "EEXIST") throw error;
    }
    let owner = null;
    let age = 0;
    try {
      owner = JSON.parse(readFileSync(lockPath, "utf8"));
      age = Date.now() - lstatSync(lockPath).mtimeMs;
    } catch {
      try { age = Date.now() - lstatSync(lockPath).mtimeMs; } catch {}
    }
    if (age >= staleLockMs && !processIsAlive(owner?.pid)) {
      const recoveryPath = `${lockPath}.stale.${process.pid}.${randomBytes(8).toString("hex")}`;
      try {
        renameSync(lockPath, recoveryPath);
        let recovered = null;
        try { recovered = JSON.parse(readFileSync(recoveryPath, "utf8")); } catch {}
        if (owner?.nonce && recovered?.nonce !== owner.nonce) {
          if (!existsSync(lockPath)) renameSync(recoveryPath, lockPath);
        } else rmSync(recoveryPath, { force: true });
        continue;
      } catch (error) {
        if (!["ENOENT", "EEXIST"].includes(error?.code)) throw error;
      }
    }
    sleep(Math.min(20, Math.max(1, deadline - Date.now())));
  }
  const held = heldStateMutationLocks.get(root);
  if (!held) throw new Error("mutation-lock-timeout");
  try {
    const result = action();
    if (result && typeof result.then === "function") throw new TypeError("mutation-lock-action-must-be-synchronous");
    return result;
  } finally {
    held.depth -= 1;
    if (held.depth === 0) {
      try {
        const owner = JSON.parse(readFileSync(held.lockPath, "utf8"));
        if (owner.nonce !== held.nonce || owner.pid !== process.pid) throw new Error("mutation-lock-ownership-lost");
        unlinkSync(held.lockPath);
      } finally {
        heldStateMutationLocks.delete(root);
      }
    }
  }
}
