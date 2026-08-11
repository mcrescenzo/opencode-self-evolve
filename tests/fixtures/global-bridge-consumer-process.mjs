import fs from "node:fs";

import { consumeGlobalActionRequests } from "../../self-evolve-bridge.js";
import { openStore } from "../../self-evolve-store.js";

const [
  stateRoot,
  consumerProjectFingerprint,
  consumerInstanceId,
  clockSource,
  resultPath,
  readyPath,
  releasePath,
  effectPath,
] = process.argv.slice(2);

let clock = Number(clockSource);
const store = openStore(stateRoot, {
  projectFingerprint: consumerProjectFingerprint,
  now: () => ++clock,
  staleLockMs: 1,
});

try {
  const result = await consumeGlobalActionRequests({
    stateRoot,
    consumerProjectFingerprint,
    consumerInstanceId,
    store,
    now: () => ++clock,
    consumerBootValidated: true,
    validateAndDecide: async () => {
      fs.writeFileSync(effectPath, consumerProjectFingerprint, { flag: "wx" });
      if (readyPath !== "-") fs.writeFileSync(readyPath, "ready", { flag: "wx" });
      if (releasePath !== "-") {
        const wait = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(releasePath)) Atomics.wait(wait, 0, 0, 20);
      }
      return { ok: true };
    },
  });
  fs.writeFileSync(resultPath, JSON.stringify(result), { flag: "wx" });
} finally {
  store.close();
}
