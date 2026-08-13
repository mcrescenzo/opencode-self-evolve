import { writeFileSync } from "node:fs";
import { SELF_EVOLVE_SYNTHESIZER_AGENT } from "../../self-evolve-core.js";
import { openStore } from "../../self-evolve-store.js";

const [root, projectFingerprint] = process.argv.slice(2);
const store = openStore(root, { projectFingerprint, now: () => Date.now() });
const sessionId = "durable-cleanup-owner";
const acquired = store.acquireHostOwner(sessionId, {
  agent: SELF_EVOLVE_SYNTHESIZER_AGENT,
  projectFingerprint,
  rootIdentity: store.rootIdentity,
  generation: 1,
});
const owner = store.hostOwnerStatus(sessionId, {
  projectFingerprint,
  rootIdentity: store.rootIdentity,
  now: Date.now(),
});

writeFileSync(process.stdout.fd, `${JSON.stringify({
  ok: acquired.ok === true,
  sessionId,
  classification: owner.classification,
  nonce: owner.owner?.nonce,
})}\n`);

// Intentionally exit without store.close(): this fixture simulates a provider
// host process terminating before its durable owner can be released.
process.exit(0);
