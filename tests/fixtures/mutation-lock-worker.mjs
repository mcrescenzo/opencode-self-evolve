import { existsSync, writeFileSync } from "node:fs";

import { withStateMutationLock } from "../../self-evolve-lock.js";

const [root, mode, observedPath, releasePath, enteredPath] = process.argv.slice(2);

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
    lockTimeoutMs: mode === "recovery" ? 150 : 2_000,
    staleLockMs: 10,
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
