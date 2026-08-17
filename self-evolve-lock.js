import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const BACKOFF_CAP_MS = 20;
const LOCK_BASENAME = ".self-evolve-mutation.lock";
const heldStateMutationLocks = new Map();

// A wedged or spinning lock must be diagnosable from logs, not from strace:
// module-level counters plus an event sink, supplemented per call via the
// onLockEvent option. Events: stale-steal, poison-reap, timeout, claim-busy,
// release-failed, residue-swept.
const lockStats = {
  attempts: 0,
  acquired: 0,
  staleSteals: 0,
  poisonReaps: 0,
  timeouts: 0,
  claimBusy: 0,
  releaseFailures: 0,
  residueSwept: 0,
};
let moduleEventSink = null;

export function mutationLockStats() {
  return { ...lockStats };
}

export function configureMutationLockEvents(sink) {
  moduleEventSink = typeof sink === "function" ? sink : null;
}

function emitLockEvent(onLockEvent, event) {
  if (typeof onLockEvent === "function") try { onLockEvent(event); } catch {}
  if (moduleEventSink) try { moduleEventSink(event); } catch {}
}

export function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

// Pid-only liveness confuses a recycled pid with a dead owner. Lock records
// carry the owner's kernel start time (/proc/<pid>/stat field 22) when the
// platform provides it; a record counts as alive only when the pid is alive
// AND the start time still matches. Records without a start time (older
// writers, non-Linux, unreadable /proc) fall back to pid-only — the
// conservative direction (alive, never stolen).
function processStartTime(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  let stat;
  try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { return null; }
  const comm = stat.lastIndexOf(")");
  if (comm === -1) return null;
  const fields = stat.slice(comm + 2).split(" ");
  const startTime = fields[19];
  return typeof startTime === "string" && /^\d+$/u.test(startTime) ? startTime : null;
}

function recordIsAlive(record) {
  if (!processIsAlive(record?.pid)) return false;
  if (typeof record?.startTime !== "string" || record.startTime === "") return true;
  const current = processStartTime(record.pid);
  return current === null || current === record.startTime;
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function assertSynchronous(result) {
  if (result && typeof result.then === "function") throw new TypeError("mutation-lock-action-must-be-synchronous");
  return result;
}

export function stateMutationLockHeld(rootDir) {
  return heldStateMutationLocks.has(path.resolve(String(rootDir)));
}

function readRecordOptional(filePath) {
  try { return JSON.parse(readFileSync(filePath, "utf8")); } catch { return null; }
}

function lstatOptional(filePath) {
  try { return lstatSync(filePath); } catch { return null; }
}

function recordHasIdentity(record) {
  return Boolean(record) && typeof record.nonce === "string" && record.nonce !== "" && Number.isSafeInteger(record.pid);
}

function ownerRecord(nonce) {
  const record = { pid: process.pid, nonce, acquiredAt: Date.now() };
  const startTime = processStartTime(process.pid);
  if (startTime !== null) record.startTime = startTime;
  return record;
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    fsyncSync(descriptor);
  } catch {} finally {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch {}
  }
}

// A lock (or recovery-claim) file must never be observable without its owner
// record: a kill between create and write used to leave a permanent 0-byte
// lock. The record is written to an O_EXCL temp sibling, fsynced, then
// published atomically with link(2) — the published name either does not exist
// or carries a complete record. Returns the published inode, or null when the
// target already exists (contention). The temp never survives the call.
// The temp name derives from the FIXED lock basename (not from targetPath) so
// that every publication temp — lock or claim — lands in the single
// `.lock.new.<pid>.<hex>` namespace the residue janitor understands; a
// target-derived name for the claim would produce `.lock.stale-recovery.new.*`,
// which no sweeper matches, recreating the unswept-residue class this module
// exists to eliminate.
function publishRecordFile(root, targetPath, record, { onBeforePublish = null } = {}) {
  const tempPath = path.join(root, `${LOCK_BASENAME}.new.${process.pid}.${randomBytes(8).toString("hex")}`);
  let descriptor;
  try {
    descriptor = openSync(
      tempPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      FILE_MODE,
    );
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
    fsyncSync(descriptor);
    const tempStat = fstatSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (typeof onBeforePublish === "function") onBeforePublish();
    try {
      linkSync(tempPath, targetPath);
    } catch (error) {
      if (error?.code === "EEXIST") return null;
      throw error;
    }
    const published = lstatSync(targetPath);
    if (published.dev !== tempStat.dev || published.ino !== tempStat.ino) {
      throw new Error("mutation-lock-publication-replaced");
    }
    fsyncDirectory(root);
    return { dev: tempStat.dev, ino: tempStat.ino };
  } finally {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch {}
    try { unlinkSync(tempPath); } catch {}
  }
}

// A crash-orphaned identity-less lock whose mtime is future-dated has a
// negative wall-clock age, so a wall gate alone would never open — the exact
// permanent wedge this module exists to prevent, surviving via clock skew.
// This map records the first monotonic sighting of each poisoned inode so age
// can accrue ACROSS acquisition calls (a single call is bounded by
// lockTimeoutMs, which is always shorter than the quarantine gate). Entries
// drop on reap or when the inode stops being poison, and the map is
// size-bounded (oldest-first eviction).
const poisonFirstSeen = new Map();
const POISON_FIRST_SEEN_LIMIT = 128;

function poisonMonotonicAgeMs(root, lockStat) {
  const key = `${root}:${lockStat.dev}:${lockStat.ino}`;
  const now = performance.now();
  const first = poisonFirstSeen.get(key);
  if (first === undefined) {
    if (poisonFirstSeen.size >= POISON_FIRST_SEEN_LIMIT) {
      poisonFirstSeen.delete(poisonFirstSeen.keys().next().value);
    }
    poisonFirstSeen.set(key, now);
    return 0;
  }
  return now - first;
}

function clearPoisonSighting(root, lockStat) {
  poisonFirstSeen.delete(`${root}:${lockStat.dev}:${lockStat.ino}`);
}

// The recovery claim serializes EVERY remover of the lock name — identity-full
// stale steals and poison quarantines alike. Only the claim holder may rename
// or unlink lockPath, so two removers can never interleave, and a remover can
// never act on a judgment a peer has already invalidated: without this, a
// peer's reap-then-republish can hand a fresh live lock the SAME recycled
// inode number, defeating any dev/ino re-check. Returns true when the claim is
// held (the caller must release it); on contention it reaps a dead claim under
// the same gates the lock itself gets, then reports failure.
function acquireRecoveryClaim(ctx, recoveryClaimPath) {
  const published = publishRecordFile(ctx.root, recoveryClaimPath, ownerRecord(ctx.nonce));
  if (published) return true;
  lockStats.claimBusy += 1;
  const claimStat = lstatOptional(recoveryClaimPath);
  const claim = readRecordOptional(recoveryClaimPath);
  emitLockEvent(ctx.onLockEvent, { event: "claim-busy", claimPid: claim?.pid ?? null });
  const claimWallAge = claimStat ? Date.now() - claimStat.mtimeMs : 0;
  const claimDead = !recordIsAlive(claim);
  const claimKey = claimStat && claim?.nonce && Number.isSafeInteger(claim?.pid)
    ? `claim:${claimStat.dev}:${claimStat.ino}:${claim.nonce}:${claim.pid}`
    : null;
  const claimGraceElapsed = claimDead ? ctx.deadForGrace(claimKey) : false;
  if (claimStat && claimDead && (claimWallAge >= ctx.staleLockMs || claimGraceElapsed)) {
    try {
      const currentClaimStat = lstatSync(recoveryClaimPath);
      if (currentClaimStat.dev === claimStat.dev && currentClaimStat.ino === claimStat.ino) {
        unlinkSync(recoveryClaimPath);
      }
    } catch {}
  }
  return false;
}

function createAcquireContext(root, options) {
  const observations = new Map();
  return {
    root,
    lockPath: path.join(root, LOCK_BASENAME),
    nonce: randomBytes(24).toString("hex"),
    lockTimeoutMs: options.lockTimeoutMs,
    staleLockMs: options.staleLockMs,
    onStaleOwnerObserved: options.onStaleOwnerObserved,
    onLockCreated: options.onLockCreated,
    onLockEvent: options.onLockEvent,
    // Monotonic grace observation is deliberately per-acquisition-call: a fresh
    // attempt must re-observe (see "a fresh attempt re-observes" in the lock
    // tests) so a short-timeout caller can never shortcut the grace window.
    deadForGrace(key) {
      if (!key) return false;
      const now = performance.now();
      const first = observations.get(key);
      if (first === undefined) {
        observations.set(key, now);
        return false;
      }
      return (now - first) >= options.staleLockMs;
    },
  };
}

// One acquisition attempt. Returns:
//   "acquired" — this process now holds the lock (held record installed)
//   "progress" — real forward progress was made (a stale lock was reaped or the
//                lock vanished); the caller may retry immediately without sleeping
//   "busy"     — no progress; the caller must back off before retrying
function attemptAcquire(ctx) {
  lockStats.attempts += 1;
  const { root, lockPath, nonce } = ctx;

  if (!lstatOptional(lockPath)) {
    const published = publishRecordFile(root, lockPath, ownerRecord(nonce), {
      onBeforePublish: typeof ctx.onLockCreated === "function" ? () => ctx.onLockCreated({ lockPath }) : null,
    });
    if (published) {
      heldStateMutationLocks.set(root, { depth: 1, nonce, lockPath });
      lockStats.acquired += 1;
      return "acquired";
    }
    return "busy";
  }

  const owner = readRecordOptional(lockPath);
  const lockStat = lstatOptional(lockPath);
  if (!lockStat) return "progress";
  const wallAge = Date.now() - lockStat.mtimeMs;

  if (!recordHasIdentity(owner)) {
    // An identity-less lock (0-byte, truncated, nonce-less JSON) carries nothing
    // to verify, so identity-based recovery can never reap it — it used to wedge
    // every caller forever. Since atomic publication makes new locks always
    // carry a record, an identity-less file is pre-fix litter or a torn
    // power-loss artifact. After an age gate long enough that no live writer can
    // still be mid-publish — wall-clock age, with a monotonic cross-call
    // fallback for future-dated mtimes — take the recovery claim, re-judge the
    // lock under it, then quarantine by atomic rename (never bare unlink).
    const poisonQuarantineMs = Math.max(ctx.staleLockMs, 2 * ctx.lockTimeoutMs);
    if (!lockStat.isFile() || lockStat.isSymbolicLink()) return "busy";
    const monotonicAge = poisonMonotonicAgeMs(root, lockStat);
    if (wallAge < poisonQuarantineMs && monotonicAge < poisonQuarantineMs) return "busy";
    const recoveryClaimPath = `${lockPath}.stale-recovery`;
    if (!acquireRecoveryClaim(ctx, recoveryClaimPath)) return "busy";
    const quarantinePath = `${lockPath}.malformed.${process.pid}.${randomBytes(8).toString("hex")}`;
    try {
      // Re-judge under the claim. With all removers serialized by the claim,
      // the name can only have changed via a full remove-and-republish by a
      // prior claim holder — and a recycled inode NUMBER proves nothing (the
      // filesystem hands the freed number to the next create), so the judgment
      // rests on content identity, not on dev/ino alone.
      const currentStat = lstatOptional(lockPath);
      if (!currentStat) return "progress";
      const currentRecord = readRecordOptional(lockPath);
      if (recordHasIdentity(currentRecord)) {
        clearPoisonSighting(root, lockStat);
        return "busy";
      }
      if (currentStat.dev !== lockStat.dev || currentStat.ino !== lockStat.ino) return "busy";
      if (!currentStat.isFile() || currentStat.isSymbolicLink()) return "busy";
      renameSync(lockPath, quarantinePath);
      const moved = lstatOptional(quarantinePath);
      const movedRecord = readRecordOptional(quarantinePath);
      const stillPoison = moved
        && moved.dev === currentStat.dev
        && moved.ino === currentStat.ino
        && moved.size === currentStat.size
        && moved.mtimeMs === currentStat.mtimeMs
        && !recordHasIdentity(movedRecord);
      if (!stillPoison) {
        if (moved && !lstatOptional(lockPath)) {
          try { renameSync(quarantinePath, lockPath); } catch {}
        }
        return "busy";
      }
      try { unlinkSync(quarantinePath); } catch {}
      clearPoisonSighting(root, lockStat);
      lockStats.poisonReaps += 1;
      emitLockEvent(ctx.onLockEvent, {
        event: "poison-reap",
        lockPath,
        dev: lockStat.dev,
        ino: lockStat.ino,
        size: lockStat.size,
        wallAge,
      });
      return "progress";
    } catch (error) {
      if (!["ENOENT", "EEXIST"].includes(error?.code)) throw error;
      return "busy";
    } finally {
      try { unlinkSync(recoveryClaimPath); } catch {}
    }
  }

  const ownerDead = !recordIsAlive(owner);
  const ownerKey = `lock:${lockStat.dev}:${lockStat.ino}:${owner.nonce}:${owner.pid}`;
  const ownerGraceElapsed = ownerDead ? ctx.deadForGrace(ownerKey) : false;
  if (!(ownerDead && (wallAge >= ctx.staleLockMs || ownerGraceElapsed))) return "busy";

  if (typeof ctx.onStaleOwnerObserved === "function") ctx.onStaleOwnerObserved({ ...owner });
  const recoveryPath = `${lockPath}.stale.${process.pid}.${randomBytes(8).toString("hex")}`;
  const recoveryClaimPath = `${lockPath}.stale-recovery`;
  let recoveryClaimed = false;
  let reaped = false;
  try {
    linkSync(lockPath, recoveryPath);
    const recovered = readRecordOptional(recoveryPath);
    if (recovered?.nonce !== owner.nonce || recovered?.pid !== owner.pid) {
      unlinkSync(recoveryPath);
      return "busy";
    }
    if (!acquireRecoveryClaim(ctx, recoveryClaimPath)) return "busy";
    recoveryClaimed = true;
    const candidate = lstatSync(recoveryPath);
    const current = lstatSync(lockPath);
    const currentOwner = JSON.parse(readFileSync(lockPath, "utf8"));
    const currentWallAge = Date.now() - current.mtimeMs;
    const currentDead = !recordIsAlive(currentOwner);
    const currentKey = `lock:${current.dev}:${current.ino}:${owner.nonce}:${owner.pid}`;
    const currentGraceElapsed = currentDead ? ctx.deadForGrace(currentKey) : false;
    if (
      candidate.dev === current.dev
      && candidate.ino === current.ino
      && currentOwner.nonce === owner.nonce
      && currentOwner.pid === owner.pid
      && (currentWallAge >= ctx.staleLockMs || currentGraceElapsed)
      && currentDead
    ) {
      unlinkSync(lockPath);
      reaped = true;
      lockStats.staleSteals += 1;
      emitLockEvent(ctx.onLockEvent, {
        event: "stale-steal",
        ownerPid: owner.pid,
        ownerNonce: owner.nonce,
        wallAge: currentWallAge,
      });
    }
    return reaped ? "progress" : "busy";
  } catch (error) {
    if (!["ENOENT", "EEXIST"].includes(error?.code)) throw error;
    return "busy";
  } finally {
    if (recoveryClaimed) try { unlinkSync(recoveryClaimPath); } catch {}
    try { unlinkSync(recoveryPath); } catch {}
  }
}

// BH-5 + ownership verification: a depth-0 record survives a failed release
// while this process may still own the on-disk lock (the file records a live
// pid, so no peer can reclaim it; dropping the record would lock this process
// out of its own lock for the rest of its life). Entering through a depth-0
// record is only safe when that on-disk ownership is still real — otherwise
// the action would run with no lock at all. Genuine nesting (depth > 0) needs
// no re-verification: the lock is held right now.
function verifyReentrantEntry(root, held) {
  if (held.depth > 0) return true;
  let raw;
  try {
    raw = readFileSync(held.lockPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      heldStateMutationLocks.delete(root);
      return false;
    }
    const failure = new Error("mutation-lock-ownership-unverifiable");
    failure.reason = "mutation-lock-ownership-unverifiable";
    failure.cause = error;
    throw failure;
  }
  let owner = null;
  try { owner = JSON.parse(raw); } catch {}
  if (owner?.nonce === held.nonce && owner?.pid === process.pid) return true;
  heldStateMutationLocks.delete(root);
  return false;
}

function runLockedAction(root, held, action, onLockEvent) {
  let result;
  let succeeded = false;
  try {
    result = assertSynchronous(action());
    succeeded = true;
    return result;
  } finally {
    try {
      releaseStateMutationLock(root, held, onLockEvent);
    } catch (error) {
      // A release-time throw still replaces a successful result (long-standing
      // contract, pinned by the BH-5 test), but the result and the fact the
      // action committed ride along so a caller can avoid re-running a
      // non-idempotent mutation.
      if (succeeded && error && typeof error === "object") {
        error.actionSucceeded = true;
        error.actionResult = result;
      }
      throw error;
    }
  }
}

export function withStateMutationLock(rootDir, action, {
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  staleLockMs = DEFAULT_STALE_LOCK_MS,
  onStaleOwnerObserved = null,
  onLockCreated = null,
  onLockEvent = null,
} = {}) {
  if (typeof action !== "function") throw new TypeError("mutation-lock-action-required");
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) throw new TypeError("invalid-lock-timeout");
  if (!Number.isSafeInteger(staleLockMs) || staleLockMs < 1) throw new TypeError("invalid-stale-lock-window");
  const root = path.resolve(String(rootDir));
  const reentrant = heldStateMutationLocks.get(root);
  if (reentrant && verifyReentrantEntry(root, reentrant)) {
    reentrant.depth += 1;
    return runLockedAction(root, reentrant, action, onLockEvent);
  }

  mkdirSync(root, { recursive: true, mode: DIR_MODE });
  const ctx = createAcquireContext(root, { lockTimeoutMs, staleLockMs, onStaleOwnerObserved, onLockCreated, onLockEvent });
  const started = Date.now();
  const deadline = started + lockTimeoutMs;
  let backoffStep = 0;
  let attempts = 0;
  // Every non-progress retry sleeps (jittered exponential backoff): no code
  // path may return to the top of this loop hot. Real forward progress (a reap,
  // or the lock vanishing) retries immediately and resets the backoff.
  const nextBackoff = () => {
    const base = Math.min(BACKOFF_CAP_MS, 2 ** Math.min(backoffStep++, 5));
    const jitter = 1 + randomBytes(1)[0] / 255;
    return Math.max(1, Math.min(Math.round(base * jitter), Math.max(1, deadline - Date.now())));
  };
  do {
    attempts += 1;
    const outcome = attemptAcquire(ctx);
    if (outcome === "acquired") break;
    if (outcome === "progress") {
      backoffStep = 0;
      continue;
    }
    sleep(nextBackoff());
  } while (Date.now() <= deadline);

  const held = heldStateMutationLocks.get(root);
  if (!held) {
    lockStats.timeouts += 1;
    const elapsedMs = Date.now() - started;
    emitLockEvent(onLockEvent, { event: "timeout", lockPath: ctx.lockPath, attempts, elapsedMs });
    const error = new Error("mutation-lock-timeout");
    error.reason = "mutation-lock-timeout";
    error.detail = { attempts, elapsedMs, lockPath: ctx.lockPath };
    throw error;
  }
  return runLockedAction(root, held, action, onLockEvent);
}

// Single-attempt, non-blocking acquisition for hot paths (TUI polling): never
// sleeps, never spins. Returns { ok: true, result } or { ok: false, reason }.
// One bonus attempt follows a "progress" outcome so reaping a stale lock can
// convert into an acquisition within the same call.
export function tryStateMutationLock(rootDir, action, {
  staleLockMs = DEFAULT_STALE_LOCK_MS,
  onLockCreated = null,
  onLockEvent = null,
} = {}) {
  if (typeof action !== "function") throw new TypeError("mutation-lock-action-required");
  if (!Number.isSafeInteger(staleLockMs) || staleLockMs < 1) throw new TypeError("invalid-stale-lock-window");
  const root = path.resolve(String(rootDir));
  const reentrant = heldStateMutationLocks.get(root);
  if (reentrant && verifyReentrantEntry(root, reentrant)) {
    reentrant.depth += 1;
    return { ok: true, result: runLockedAction(root, reentrant, action, onLockEvent) };
  }
  mkdirSync(root, { recursive: true, mode: DIR_MODE });
  const ctx = createAcquireContext(root, { lockTimeoutMs: 1, staleLockMs, onStaleOwnerObserved: null, onLockCreated, onLockEvent });
  let outcome = attemptAcquire(ctx);
  if (outcome === "progress") outcome = attemptAcquire(ctx);
  if (outcome !== "acquired") return { ok: false, reason: "mutation-lock-busy" };
  const held = heldStateMutationLocks.get(root);
  return { ok: true, result: runLockedAction(root, held, action, onLockEvent) };
}

// BH-5: releasing must not forget a lock this process still owns. The lock file
// records a live pid, so peer stale-lock recovery — which requires a dead owner —
// can never reclaim it. Dropping the in-memory record on a failed unlink also
// locked this process out of its own lock for the rest of its life: every later
// acquisition hit EEXIST against itself and spun to mutation-lock-timeout. So a
// failed unlink (or an unreadable lock file) keeps the record (depth 0) and the
// next release retries it, while an already-removed file and a lost ownership
// both clear the record. The record is never dropped on failure — on-disk
// ownership may still be real, and reentrant entry re-verifies it before use —
// but repeated failures are counted and emitted so they are visible.
function releaseStateMutationLock(root, held, onLockEvent = null) {
  held.depth -= 1;
  if (held.depth !== 0) return;
  let owner;
  try {
    owner = JSON.parse(readFileSync(held.lockPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      heldStateMutationLocks.delete(root);
      return;
    }
    noteReleaseFailure(held, onLockEvent, "read", error);
    throw error;
  }
  if (owner.nonce !== held.nonce || owner.pid !== process.pid) {
    heldStateMutationLocks.delete(root);
    throw new Error("mutation-lock-ownership-lost");
  }
  try {
    unlinkSync(held.lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      noteReleaseFailure(held, onLockEvent, "unlink", error);
      throw error;
    }
  }
  heldStateMutationLocks.delete(root);
}

function noteReleaseFailure(held, onLockEvent, stage, error) {
  lockStats.releaseFailures += 1;
  held.releaseFailures = (held.releaseFailures ?? 0) + 1;
  emitLockEvent(onLockEvent, {
    event: "release-failed",
    stage,
    code: error?.code ?? null,
    consecutiveFailures: held.releaseFailures,
    lockPath: held.lockPath,
  });
}

// Janitor for residue the lock protocol can leave behind after a kill:
// .stale.<pid>.<hex> hard links (killed mid-recovery), .new.<pid>.<hex> temps
// (killed mid-publish), .malformed.<pid>.<hex> quarantines (killed mid-reap),
// and an orphaned .stale-recovery claim with no live episode. Never touches
// the lock file itself — reaping a poisoned lock is the acquisition path's job,
// behind its age gate. Residue removals are logged, not silent: those links
// were the only forensic breadcrumb the original incident left behind.
export function sweepMutationLockResidue(rootDir, { staleLockMs = DEFAULT_STALE_LOCK_MS, onLockEvent = null } = {}) {
  const root = path.resolve(String(rootDir));
  const counts = { staleLinks: 0, claims: 0, malformed: 0, temps: 0 };
  let names;
  try { names = readdirSync(root); } catch { return counts; }
  const sweptPids = [];
  for (const name of names) {
    if (!name.startsWith(`${LOCK_BASENAME}.`)) continue;
    const filePath = path.join(root, name);
    const suffix = name.slice(LOCK_BASENAME.length + 1);
    if (suffix === "stale-recovery") {
      const claim = readRecordOptional(filePath);
      const claimStat = lstatOptional(filePath);
      if (!claimStat) continue;
      if (recordIsAlive(claim)) continue;
      if (Date.now() - claimStat.mtimeMs < staleLockMs) continue;
      try {
        const currentStat = lstatSync(filePath);
        if (currentStat.dev !== claimStat.dev || currentStat.ino !== claimStat.ino) continue;
        unlinkSync(filePath);
      } catch { continue; }
      counts.claims += 1;
      sweptPids.push(claim?.pid ?? null);
      continue;
    }
    const match = /^(stale|malformed|new)\.(\d+)\./u.exec(suffix);
    if (!match) continue;
    const pid = Number(match[2]);
    if (processIsAlive(pid)) continue;
    const fileStat = lstatOptional(filePath);
    if (!fileStat) continue;
    if (match[1] === "stale" && Date.now() - fileStat.mtimeMs < staleLockMs) continue;
    try { unlinkSync(filePath); } catch { continue; }
    if (match[1] === "stale") counts.staleLinks += 1;
    else if (match[1] === "malformed") counts.malformed += 1;
    else counts.temps += 1;
    sweptPids.push(pid);
  }
  const total = counts.staleLinks + counts.claims + counts.malformed + counts.temps;
  if (total > 0) {
    lockStats.residueSwept += total;
    emitLockEvent(onLockEvent, { event: "residue-swept", root, ...counts, pids: sweptPids });
  }
  return counts;
}
