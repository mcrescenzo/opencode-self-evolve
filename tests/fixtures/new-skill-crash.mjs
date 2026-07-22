import fs from "node:fs";
import { createApplier } from "../../self-evolve-applier.js";
import { discoverSkills, hashSkillContent, loadAllowlist } from "../../self-evolve-inventory.js";
import { createPrivacyGuard } from "../../self-evolve-privacy.js";
import { openStore } from "../../self-evolve-store.js";

const [stateRoot, skillRoot, projectFingerprint, point] = process.argv.slice(2);
const content = "---\nname: crash-skill\ndescription: Handles deterministic workflow checks safely.\n---\n# Complete\nNever publish partial content.\n";
const roots = loadAllowlist({ globalSkillRoots: [skillRoot] }).canonicalRoots;
const records = discoverSkills(roots);
const store = openStore(stateRoot, { projectFingerprint, now: () => Date.now(), staleLockMs: 1 });
const privacy = createPrivacyGuard({ projectFingerprint, store, now: () => Date.now() });
const applier = createApplier({
  store,
  inventory: { records, canonicalRoots: roots },
  privacy,
  now: () => Date.now(),
  faultInjection(current) {
    if (current === point) process.kill(process.pid, "SIGKILL");
  },
});
const proposal = store.getRecord("proposal", "proposal-crash-skill").payload;
const decision = store.readRecords("decision").map((record) => record.payload).find((item) => item.proposalId === proposal.id);
await applier.applyProposal({ proposal: { ...proposal, proposedContent: content }, decision, mode: "auto" });
fs.writeFileSync(`${stateRoot}.unexpected`, hashSkillContent(content));
process.exitCode = 2;
