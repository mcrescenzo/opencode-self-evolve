import { writeFileSync } from "node:fs";
import { openStore } from "../../self-evolve-store.js";
import { hashSkillContent } from "../../self-evolve-inventory.js";
import { runSynthesis } from "../../self-evolve-synthesis.js";

const [root, projectFingerprint] = process.argv.slice(2);
const now = Date.now();
const current = "---\nname: cleanup-owner\ndescription: Retains failed hidden cleanup ownership.\n---\n# Cleanup Owner\nKeep cleanup durable.\n";
const currentHash = hashSkillContent(current);
const observationId = hashSkillContent("cleanup-observation");
const cluster = {
  id: hashSkillContent("cleanup-cluster"),
  receiptType: "repeated-command",
  projectFingerprint,
  scopeFingerprint: hashSkillContent("cleanup-scope"),
  incidentIds: ["one", "two", "three"],
  occurrencesSum: 3,
  firstSeenAt: now - 2,
  lastSeenAt: now - 1,
  observations: [{ id: observationId, createdAt: now - 1, receiptIds: [hashSkillContent("receipt")], structuredFields: { receiptType: "repeated-command" }, redacted: true, injectionFlagged: false }],
  eligibility: { clusterId: hashSkillContent("cleanup-cluster"), eligible: true },
};
const target = {
  canonicalRoot: "/skills",
  relativePath: "cleanup-owner/SKILL.md",
  logicalName: "cleanup-owner",
  exists: true,
  currentHash,
  currentContent: current,
  sizeBytes: Buffer.byteLength(current),
};
const store = openStore(root, { projectFingerprint, now: () => Date.now() });
const sessionId = "durable-cleanup-owner";
const ctx = { directory: root, client: { session: {
  create: async () => ({ data: { id: sessionId } }),
  prompt: async () => ({ data: { info: { structured_output: {
    action: "no-op",
    targetLogicalName: target.logicalName,
    proposedContent: current,
    evidenceMapping: [{ claim: "No skill change is required.", observationIds: [observationId] }],
    expectedBehavior: "Cleanup ownership remains durable.",
    counterExamples: ["Successful cleanup releases ownership."],
    overlap: [],
    riskNotes: "No content change.",
    evaluationScenarios: ["Hidden session deletion fails."],
  } } } }),
  abort: async () => ({ data: {} }),
  delete: async () => { throw new Error("simulated-delete-failure"); },
} } };

const result = await runSynthesis({
  ctx,
  cluster,
  targetSkill: target,
  inventory: [target],
  privacy: { checkPartition: () => ({ ok: true }), isObservationEligible: () => true },
  options: {
    store,
    currentContent: current,
    validateTarget: () => ({ ok: true }),
    projectFingerprint,
    rootIdentity: store.rootIdentity,
    hostOwnerGeneration: 1,
  },
  now,
});
const owner = store.hostOwnerStatus(sessionId, { projectFingerprint, rootIdentity: store.rootIdentity, now: Date.now() });
writeFileSync(process.stdout.fd, `${JSON.stringify({ ok: result.ok, reason: result.reason, sessionId, classification: owner.classification, nonce: owner.owner?.nonce })}\n`);
store.close();
