import { openStore } from "../../self-evolve-store.js";
import { makeDecision } from "../../self-evolve-schemas.js";

const [root, projectFingerprint, point, newState = "approved"] = process.argv.slice(2);
const store = openStore(root, {
  projectFingerprint,
  now: () => 2_000,
  staleLockMs: 1,
  faultInjection(current) {
    if (current === point) process.kill(process.pid, "SIGKILL");
  },
});
const proposal = store.getRecord("proposal", "transaction-proposal").payload;
store.commitDecision(makeDecision({
  proposalId: proposal.id,
  targetHash: proposal.skillTarget.currentHash,
  proposedContentHash: proposal.proposedContentHash,
  decisionVersion: 1,
  actor: "process-fixture",
  timestamp: 2_000,
  nonce: "process-decision-nonce",
  priorState: "pending",
  newState,
}));
process.exitCode = 2;
