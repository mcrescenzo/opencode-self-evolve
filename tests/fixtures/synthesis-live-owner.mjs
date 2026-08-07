import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createApplier } from "../../self-evolve-applier.js";
import { createCommandPolicy } from "../../self-evolve-commands.js";
import * as inventory from "../../self-evolve-inventory.js";
import * as observation from "../../self-evolve-observation.js";
import { createPipeline } from "../../self-evolve-pipeline.js";
import { createPrivacyGuard } from "../../self-evolve-privacy.js";
import * as schemas from "../../self-evolve-schemas.js";
import { openStore } from "../../self-evolve-store.js";
import * as synthesis from "../../self-evolve-synthesis.js";

const [root, projectFingerprint, barrierPath, releasePath, markerPath] = process.argv.slice(2);
const skillRoot = path.join(root, "skills");
const skillDir = path.join(skillRoot, "synthesis-owner");
const current = "---\nname: synthesis-owner\ndescription: Handles synthesis ownership safely.\n---\n# Synthesis Owner\nVerify once.\n";
const proposed = `${current}Verify the live owner before recovery.\n`;
fs.mkdirSync(skillDir, { recursive: true });
fs.writeFileSync(path.join(skillDir, "SKILL.md"), current);
const store = openStore(root, { projectFingerprint, now: () => Date.now(), staleLockMs: 20 });
const roots = inventory.loadAllowlist({ globalSkillRoots: [skillRoot] }).canonicalRoots;
const records = inventory.discoverSkills(roots);
const privacy = createPrivacyGuard({ consent: {}, projectFingerprint, store, now: () => Date.now() });
const applier = createApplier({ store, inventory: { records, canonicalRoots: roots }, privacy, now: () => Date.now() });
const commands = createCommandPolicy({ store, privacy, now: () => Date.now() });
const messages = new Map();
const ctx = { directory: root, client: { session: {
  messages: async (args) => ({ data: messages.get(args?.path?.id ?? args?.path?.sessionID ?? args?.sessionID) ?? [] }),
  create: async () => ({ data: { id: `hidden-${Date.now()}` } }),
  prompt: async (args) => {
    const agent = args?.body?.agent ?? args?.agent;
    fs.appendFileSync(markerPath, `${agent}\n`);
    if (agent === synthesis.SYNTHESIS_AGENT_NAME) {
      fs.writeFileSync(barrierPath, "provider-open", { mode: 0o600 });
      while (!fs.existsSync(releasePath)) await delay(5);
      const prompt = args?.body?.parts?.[0]?.text ?? "";
      const evidence = JSON.parse(/<UNTRUSTED_EVIDENCE_METADATA>\n([^\n]+)\n<\/UNTRUSTED_EVIDENCE_METADATA>/u.exec(prompt)[1]);
      return { data: { info: { structured_output: {
        action: "rewrite", targetLogicalName: "synthesis-owner", proposedContent: proposed, proposedContentHash: inventory.hashSkillContent(proposed),
        evidenceMapping: [{ claim: "Repeated ownership checks need verification.", observationIds: evidence.observations.map((item) => item.id) }],
        expectedBehavior: "Live ownership is verified.", counterExamples: ["One event is insufficient."], overlap: [], riskNotes: "Bounded.",
        evaluationScenarios: ["Three independent episodes."], sizeDeltaBytes: Buffer.byteLength(proposed) - Buffer.byteLength(current),
        approxTokenDelta: Math.ceil(Buffer.byteLength(proposed) / 4) - Math.ceil(Buffer.byteLength(current) / 4),
      } } } };
    }
    return { data: { info: { structured_output: { score: 0.95, evidenceLinked: true, nonDuplicative: true, reasons: ["Evidence is linked."], recommendedAction: "accept" } } } };
  },
  abort: async () => ({ data: {} }),
} } };
const pipeline = createPipeline({ store, inventory, privacy, synthesis, applier, commands, schemas, observation, now: () => Date.now() });
let result;
for (let index = 1; index <= 3; index += 1) {
  const sessionID = `live-synthesis-${index}`;
  messages.set(sessionID, Array.from({ length: 3 }, (_, item) => ({ role: "user", parts: [{ type: "text", text: `/verify-owner ${index}-${item}` }] })));
  result = await pipeline.runEvolutionCycle({ ctx, sessionID, projectFingerprint, scopeFingerprint: inventory.hashSkillContent("synthesis-owner-scope"), trigger: "process-fixture", mode: "manual", options: { inventoryRecords: records, targetSkill: records[0], currentContent: current } });
}
fs.writeFileSync(process.stdout.fd, `${JSON.stringify({ result: result?.result })}\n`);
pipeline.close();
