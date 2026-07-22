import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createIntegration } from "../../self-evolve-integration.js";
import { openStore } from "../../self-evolve-store.js";
import * as schemas from "../../self-evolve-schemas.js";
import * as commands from "../../self-evolve-commands.js";

const [stateRoot, projectFingerprint, skillRoot] = process.argv.slice(2);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const store = openStore(stateRoot, { projectFingerprint, projectName: "bridge-process" });
const current = store.getSettings();
if (current.global.mode === "manual" && current.global.allowedSkillRoots.length === 0 && current.global.updatedAt === current.global.createdAt) {
  store.updateGlobalSettings((global) => schemas.makeGlobalSettings({
    ...global,
    mode: "auto",
    allowedSkillRoots: [skillRoot],
    updatedAt: Date.now(),
  }));
}

function seed(id, relativePath) {
  if (store.getRecord("proposal", id)) return;
  store.appendRecord(schemas.wrapRecord("proposal", schemas.makeProposal({
    id,
    projectFingerprint,
    clusterId: hash(`cluster:${id}`),
    skillTarget: { canonicalRoot: skillRoot, relativePath, currentHash: hash("before") },
    proposedContentHash: hash(`after:${id}`),
    rationaleText: `Production mailbox fixture ${id}`,
    synthesizedAt: Date.now(),
    synthesizerModelId: "fixture/no-provider",
    criticScore: 1,
    criticPassed: true,
    validDeterministic: true,
    state: "pending",
    injectionFlagged: false,
  }), Date.now()));
}

seed("proposal-apply", "apply/SKILL.md");
seed("proposal-reject", "reject/SKILL.md");

const applier = {
  circuitBreakerOpen: () => false,
  recoverPending: () => [],
  close() {},
};
const pipeline = {
  createPipeline() {
    return {
      runEvolutionCycle: async () => ({ result: "no-eligible" }),
      runApprovalFlow: async ({ proposalId }) => ({ result: "applied", auditEvents: [], responseText: `fixture applied ${proposalId}` }),
      runRollbackFlow: async ({ proposalId }) => ({ result: "rolled-back", auditEvents: [], responseText: `fixture rolled back ${proposalId}` }),
    };
  },
};
const scheduler = {
  createScheduler() {
    return { setMode() {}, getCircuitBreaker: () => ({ open: false }), handleEvent: async () => {}, recordWorkResult() {}, dispose() {} };
  },
};
const privacy = { exportScope: () => ({ records: [] }), purgeScope: () => ({ ok: true }), scanForForbiddenContent: () => ({ ok: true }) };
const integration = createIntegration({
  store,
  inventory: {},
  privacy,
  schemas,
  observation: {},
  synthesisModule: {},
  applier,
  commands,
  pipeline,
  scheduler,
  options: { stateRoot, projectFingerprint, mailboxPollMs: 25 },
});

await integration.boot({ hostVersion: "1.18.3" });
process.stdout.write("READY\n");

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await integration.shutdown();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
setInterval(() => {}, 10_000);
