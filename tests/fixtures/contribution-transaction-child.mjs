import { writeFileSync } from "node:fs";
import { createPrivacyGuard } from "../../self-evolve-privacy.js";
import { openStore } from "../../self-evolve-store.js";

const [root, projectFingerprint, resultPath, inputSource, faultPoint = "", storeOptionsSource = "{}"] = process.argv.slice(2);
const input = JSON.parse(inputSource);
const now = input.lastSeenAt;
const store = openStore(root, {
  projectFingerprint,
  now: () => now,
  staleLockMs: 1,
  faultInjection(point) {
    if (point === faultPoint) process.kill(process.pid, "SIGKILL");
  },
  ...JSON.parse(storeOptionsSource),
});
const privacy = createPrivacyGuard({ projectFingerprint, store, now: () => now });
const result = privacy.publishContribution(input);
store.close();
writeFileSync(resultPath, `${JSON.stringify(result)}\n`, { encoding: "utf8", mode: 0o600 });
