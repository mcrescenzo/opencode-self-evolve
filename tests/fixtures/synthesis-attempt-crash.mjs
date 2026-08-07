import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createApplier } from "../../self-evolve-applier.js";
import { createCommandPolicy } from "../../self-evolve-commands.js";
import * as inventory from "../../self-evolve-inventory.js";
import * as observation from "../../self-evolve-observation.js";
import { createPipeline } from "../../self-evolve-pipeline.js";
import { createPrivacyGuard } from "../../self-evolve-privacy.js";
import * as schemas from "../../self-evolve-schemas.js";
import { openStore } from "../../self-evolve-store.js";
import * as synthesis from "../../self-evolve-synthesis.js";

const [root, projectFingerprint, point, markerPath] = process.argv.slice(2);
const skillRoot = path.join(root, "skills");
const skillDir = path.join(skillRoot, "recovery");
const current = "---\nname: recovery\ndescription: Verifies repeated recovery commands.\n---\n\n# Recovery\n\nVerify once.\n";
const proposed = `${current}\n${"Verify the recovered result before continuing.\n".repeat(20)}`;
mkdirSync(skillDir, { recursive: true });
writeFileSync(path.join(skillDir, "SKILL.md"), current);
let clock = 2_200_000_000_000;
const store = openStore(root, { projectFingerprint, now: () => ++clock, staleLockMs: 1 });
const roots = inventory.loadAllowlist({ globalSkillRoots: [skillRoot] }).canonicalRoots;
const records = inventory.discoverSkills(roots);
const privacy = createPrivacyGuard({ consent: {}, projectFingerprint, store, now: () => ++clock });
const applier = createApplier({ store, inventory: { records, canonicalRoots: roots }, privacy, now: () => ++clock });
const commands = createCommandPolicy({ store, privacy, now: () => ++clock });
const messages = new Map();
const ctx = {
  directory: root,
  client: { session: {
    messages: async (args) => ({ data: messages.get(args?.path?.id ?? args?.path?.sessionID ?? args?.sessionID) ?? [] }),
    create: async () => ({ data: { id: `hidden-${clock}` } }),
    prompt: async (args) => {
      const agent = args?.body?.agent ?? args?.agent;
      appendFileSync(markerPath, `${agent}\n`);
      if (agent === synthesis.CRITIC_AGENT_NAME) return { data: { info: { structured_output: {
        score: 0.95, evidenceLinked: true, nonDuplicative: true,
        reasons: ["Evidence is linked."], recommendedAction: "accept",
      } } } };
      const prompt = args?.body?.parts?.[0]?.text ?? "";
      const evidence = JSON.parse(/<UNTRUSTED_EVIDENCE_METADATA>\n([^\n]+)\n<\/UNTRUSTED_EVIDENCE_METADATA>/u.exec(prompt)[1]);
      return { data: { info: { structured_output: {
        action: "rewrite", targetLogicalName: "recovery", proposedContent: proposed,
        proposedContentHash: inventory.hashSkillContent(proposed),
        evidenceMapping: [{ claim: "Repeated recovery commands need verification.", observationIds: evidence.observations.map((item) => item.id) }],
        expectedBehavior: "Recovered results are verified.", counterExamples: ["One command is insufficient."],
        overlap: [], riskNotes: "Bounded guidance.", evaluationScenarios: ["Three independent episodes."],
        sizeDeltaBytes: Buffer.byteLength(proposed) - Buffer.byteLength(current),
        approxTokenDelta: Math.ceil(Buffer.byteLength(proposed) / 4) - Math.ceil(Buffer.byteLength(current) / 4),
      } } } };
    },
    abort: async () => ({ data: {} }),
  } },
};
const pipeline = createPipeline({ store, inventory, privacy, synthesis, applier, commands, schemas, observation, now: () => ++clock });
const faultInjection = (currentPoint, context = {}) => {
  const qualifiedPoint = currentPoint === "pipeline-after-content-chunk"
    ? `${currentPoint}-${context.chunkIndex}`
    : currentPoint;
  if (qualifiedPoint === point) process.kill(process.pid, "SIGKILL");
};
for (let index = 1; index <= 3; index += 1) {
  const sessionID = `crash-${index}`;
  messages.set(sessionID, Array.from({ length: 3 }, (_, item) => ({ role: "user", parts: [{ type: "text", text: `/recover --attempt ${index}-${item}` }] })));
  await pipeline.runEvolutionCycle({
    ctx, sessionID, projectFingerprint, scopeFingerprint: inventory.hashSkillContent("recovery-scope"),
    trigger: "process-fixture", mode: "manual",
    options: { inventoryRecords: records, targetSkill: records[0], currentContent: current, faultInjection },
  });
}
process.exitCode = 2;
