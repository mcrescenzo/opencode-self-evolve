import { writeFileSync } from "node:fs";
import { makeSynthesisAttempt, wrapRecord } from "../../self-evolve-schemas.js";
import { hashContent, openStore } from "../../self-evolve-store.js";

const [root, projectFingerprint, resultPath, suffix, timestamp] = process.argv.slice(2);
const now = Number(timestamp);
const store = openStore(root, { projectFingerprint, now: () => now });

try {
  const attempt = makeSynthesisAttempt({
    outcomeId: hashContent(`outcome:${suffix}`),
    proposalId: `proposal-${suffix}`,
    projectFingerprint,
    clusterId: hashContent("shared-cluster"),
    targetHash: hashContent("shared-target"),
    admittedAt: now,
    state: "admitted",
  });
  const result = store.admitSynthesisAttempt(wrapRecord("synthesis-attempt", attempt, now), {
    rootSessionIDHash: hashContent(`session:${suffix}`),
  });
  writeFileSync(resultPath, JSON.stringify(result), { flag: "wx", mode: 0o600 });
} finally {
  store.close();
}
