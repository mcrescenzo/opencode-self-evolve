import { createDecisionRequest, submitDecisionRequest } from "../../self-evolve-bridge.js";

const [stateRoot, projectFingerprint, prefix, rawCount] = process.argv.slice(2);
const count = Number(rawCount);
const proposal = {
  id: `proposal-${prefix}`,
  projectFingerprint,
  skillTarget: { canonicalRoot: "/skills", relativePath: "demo/SKILL.md", currentHash: "b".repeat(64) },
  proposedContentHash: "c".repeat(64),
  decisionVersion: 0,
  state: "pending",
  decisionNonce: `nonce-${prefix}`,
};
let published = 0;
let rejected = 0;
for (let index = 0; index < count; index += 1) {
  const request = createDecisionRequest({
    projectFingerprint,
    proposal,
    newState: "rejected",
    timestamp: Date.now(),
    requestId: `${prefix}-${index}`,
  });
  try {
    submitDecisionRequest(stateRoot, request);
    published += 1;
  } catch (error) {
    if (!/mailbox-(?:byte-quota|file-count)-exceeded/u.test(String(error?.message))) throw error;
    rejected += 1;
  }
}
process.stdout.write(`${JSON.stringify({ published, rejected })}\n`);
