import { appendFileSync, existsSync, writeFileSync } from "node:fs";

import { withStateMutationLock } from "../../self-evolve-lock.js";

const [root, mode, observedPath, releasePath, enteredPath, staleMsArg, timeoutMsArg] = process.argv.slice(2);
const staleLockMs = staleMsArg !== undefined ? Number(staleMsArg) : 10;
const lockTimeoutMs = timeoutMsArg !== undefined ? Number(timeoutMsArg) : (mode === "recovery" ? 150 : 2_000);

function waitFor(filePath) {
  while (!existsSync(filePath)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  }
}

// kill-on-create: die by SIGKILL at the fault-injection seam, mid-acquisition,
// before the lock is published. Reproduces the crash that used to leave a
// permanent 0-byte lock file.
if (mode === "kill-on-create") {
  withStateMutationLock(root, () => "unreachable", {
    lockTimeoutMs,
    staleLockMs,
    onLockCreated() { process.kill(process.pid, "SIGKILL"); },
  });
  process.exit(1);
}

// cycle: repeated acquire/append/release rounds against a shared log for the
// multi-process contention test. observedPath carries the iteration count and
// enteredPath the shared log path.
if (mode === "cycle") {
  const iterations = Number(observedPath);
  try {
    for (let index = 0; index < iterations; index += 1) {
      withStateMutationLock(root, () => {
        appendFileSync(enteredPath, `enter ${process.pid} ${index}\n`);
        appendFileSync(enteredPath, `exit ${process.pid} ${index}\n`);
      }, { lockTimeoutMs, staleLockMs });
    }
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

try {
  withStateMutationLock(root, () => {
    writeFileSync(enteredPath, "entered\n", { flag: "wx" });
    if (mode === "replacement") {
      const lockPath = `${root}/.self-evolve-mutation.lock`;
      while (!existsSync(releasePath)) {
        if (!existsSync(lockPath) && !existsSync(`${enteredPath}.displaced`)) {
          writeFileSync(`${enteredPath}.displaced`, "displaced\n", { flag: "wx" });
        }
      }
    }
  }, {
    lockTimeoutMs,
    staleLockMs,
    onStaleOwnerObserved: mode === "recovery" ? () => {
      writeFileSync(observedPath, "observed\n", { flag: "wx" });
      waitFor(releasePath);
    } : null,
  });
  process.exitCode = 0;
} catch (error) {
  if (mode === "recovery" && error?.message === "mutation-lock-timeout") process.exitCode = 0;
  else {
    console.error(error);
    process.exitCode = 1;
  }
}
