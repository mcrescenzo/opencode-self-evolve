import { existsSync, writeFileSync } from "node:fs";

import { withStateMutationLock } from "../../self-evolve-lock.js";

const [root, mode, observedPath, releasePath, enteredPath, staleMsArg, timeoutMsArg] = process.argv.slice(2);
const staleLockMs = staleMsArg !== undefined ? Number(staleMsArg) : 10;
const lockTimeoutMs = timeoutMsArg !== undefined ? Number(timeoutMsArg) : (mode === "recovery" ? 150 : 2_000);

function waitFor(filePath) {
  while (!existsSync(filePath)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
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
