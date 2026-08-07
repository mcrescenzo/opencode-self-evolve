import fs from "node:fs";
import path from "node:path";
import { createApplier } from "../../self-evolve-applier.js";
import * as inventory from "../../self-evolve-inventory.js";
import { createPrivacyGuard } from "../../self-evolve-privacy.js";
import * as schemas from "../../self-evolve-schemas.js";
import { openStore } from "../../self-evolve-store.js";

const [stateRoot, skillRoot, projectFingerprint, proposalId, proposedPath, point, barrierPath, releasePath] = process.argv.slice(2);
const store = openStore(stateRoot, { projectFingerprint, now: () => Date.now(), staleLockMs: 20 });
const roots = inventory.loadAllowlist({ globalSkillRoots: [skillRoot] }).canonicalRoots;
const records = inventory.discoverSkills(roots);
const privacy = createPrivacyGuard({ consent: {}, projectFingerprint, store, now: () => Date.now() });
const applier = createApplier({
  store,
  inventory: { records, canonicalRoots: roots },
  privacy,
  now: () => Date.now(),
  faultInjection(current) {
    if (current !== point) return;
    fs.writeFileSync(barrierPath, current, { mode: 0o600 });
    while (!fs.existsSync(releasePath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  },
});
const durable = store.getRecord("proposal", proposalId)?.payload;
const decision = store.readRecords("decision").map((record) => record.payload).findLast((item) => item.proposalId === proposalId && item.newState === "approved");
const proposedContent = fs.readFileSync(proposedPath, "utf8");
const result = await applier.applyProposal({ proposal: { ...durable, proposedContent }, decision, actor: "live-owner", mode: "auto" });
if (result.ok) {
  const current = store.getRecord("proposal", proposalId).payload;
  const applied = schemas.makeDecision({
    proposalId,
    targetHash: current.skillTarget.currentHash,
    proposedContentHash: current.proposedContentHash,
    decisionVersion: current.decisionVersion + 1,
    actor: "self-evolve-applier",
    timestamp: Date.now(),
    nonce: `live-owner-${process.pid}-${Date.now()}`,
    priorState: "approved",
    newState: "applied",
  });
  const committed = store.commitDecision(applied);
  if (!committed.ok) {
    process.stderr.write(`commit-applied:${JSON.stringify(committed)}\n`);
    process.exitCode = 3;
  }
}
fs.writeFileSync(process.stdout.fd, `${JSON.stringify(result)}\n`);
applier.close();
store.close();
