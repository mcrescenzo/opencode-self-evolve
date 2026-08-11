import { createGlobalDecisionDomain } from "../../self-evolve-applier.js";
import * as inventory from "../../self-evolve-inventory.js";
import { openStore } from "../../self-evolve-store.js";
import fs from "node:fs";
import path from "node:path";

const [stateRoot, projectFingerprint, decisionSource, action, faultPoint = "none", clockSource = "0", readyPath = "none", releasePath = "none", storeOptionsSource = "{}"] = process.argv.slice(2);
const decision = JSON.parse(decisionSource);
const storeOptions = JSON.parse(storeOptionsSource);
let clock = Number(clockSource);
// `throw:<point>+kill:<point>` forces a post-publication failure and then kills
// the process inside the resulting rollback, which is the only way to reach the
// rollback unlink/rename/link boundaries from a real process.
const throwThenKill = /^throw:([a-z0-9-]+)\+kill:([a-z0-9-]+)$/u.exec(faultPoint);
const crash = (point) => {
  if (throwThenKill) {
    if (point === throwThenKill[1]) throw new Error("injected-process-publication-failure");
    if (point === throwThenKill[2]) process.kill(process.pid, "SIGKILL");
    return;
  }
  if (faultPoint === "failed-readback-after-outcome") {
    if (point === "global-apply-before-readback") throw new Error("injected-process-readback-failure");
    if (point === "global-outcome-after-record") process.kill(process.pid, "SIGKILL");
    return;
  }
  if (faultPoint === "hold-before-temp" && point === "global-apply-before-temp-write") {
    fs.writeFileSync(readyPath, "ready");
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(releasePath)) Atomics.wait(wait, 0, 0, 20);
    return;
  }
  if (faultPoint === "replace-temp-after-reproof" && point === "global-apply-after-temp-reproof") {
    const intent = store.readGlobalApplyIntents().find((item) => !["completed", "failed-closed"].includes(item.state));
    const root = store.getSettings().global.globalRootPolicy.roots.find((item) => item.rootId === intent.rootId);
    const temporary = path.join(root.canonicalPath, path.dirname(intent.relativePath), intent.temporaryName);
    fs.unlinkSync(temporary);
    fs.writeFileSync(temporary, "external temp replacement\n", { flag: "wx" });
    return;
  }
  if (point === faultPoint) process.kill(process.pid, "SIGKILL");
};
const store = openStore(stateRoot, {
  projectFingerprint,
  now: () => ++clock,
  staleLockMs: 1,
  faultInjection: crash,
  ...storeOptions,
});
const domain = createGlobalDecisionDomain({
  store,
  inventory,
  now: () => ++clock,
  getSuppressors: () => ({ circuitBreakerOpen: false, emergencyStop: false }),
  faultInjection: crash,
});
const result = action === "reject"
  ? store.rejectGlobalRecommendation({ decision, nowMs: ++clock })
  : await domain.decide({ action, decision });
process.stdout.write(JSON.stringify(result));
store.close();
