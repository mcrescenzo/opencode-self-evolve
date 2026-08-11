import { appendFileSync, readFileSync } from "node:fs";
import * as inventory from "../../self-evolve-inventory.js";
import * as synthesis from "../../self-evolve-synthesis.js";
import { openStore } from "../../self-evolve-store.js";

const [root, projectFingerprint, markerPath, mode, timestampText, candidateIdArg = ""] = process.argv.slice(2);
const timestamp = Number(timestampText);
// `crash:<durable-fault-point>` kills the process at any store boundary so the
// convergence matrices do not need one named mode per boundary.
const explicitCrashPoint = mode.startsWith("crash:") ? mode.slice("crash:".length) : null;
const store = openStore(root, {
  projectFingerprint,
  now: () => timestamp,
  ...(explicitCrashPoint || ["crash-after-recommendation", "crash-after-candidate-recommended", "crash-after-candidate-no-change"].includes(mode) ? {
    faultInjection(point) {
      if (explicitCrashPoint) {
        if (point === explicitCrashPoint) process.kill(process.pid, "SIGKILL");
        return;
      }
      if (mode === "crash-after-recommendation" && point === "global-synthesis-after-recommendation") process.kill(process.pid, "SIGKILL");
      if (mode === "crash-after-candidate-recommended" && point === "global-synthesis-after-candidate-recommended") {
        process.kill(process.pid, "SIGKILL");
      }
      if (mode === "crash-after-candidate-no-change" && point === "global-synthesis-after-candidate-no-change") {
        process.kill(process.pid, "SIGKILL");
      }
    },
  } : {}),
});
const policy = store.getSettings().global.globalRootPolicy;
const catalog = inventory.buildGlobalSkillCatalog(policy, { projectRoot: root });
const candidate = (candidateIdArg
  ? store.readGlobalCandidates().find((item) => item.candidateId === candidateIdArg)
  : store.readGlobalCandidates().find((item) => item.state === "eligible"))
  ?? store.readGlobalCandidates()[0];
// The proposal must extend whichever approved target this candidate is bound
// to, so budget and concurrency races can use more than one global skill.
const targetRecord = (catalog.records ?? []).find((record) => {
  const resolved = inventory.resolveGlobalSkillCandidate(record.logicalName, catalog);
  return resolved.ok && resolved.binding.bindingHash === candidate?.targetBindingHash;
}) ?? (catalog.records ?? [])[0];
const logicalName = targetRecord?.logicalName ?? "durable-review";
const current = targetRecord ? readFileSync(targetRecord.absolutePath, "utf8") : "";
const proposed = `${current}\nVerify the repeated failure before suggesting a correction.\n`;

const ctx = {
  client: { session: {
    create: async (args) => ({ data: { id: `global-process-${process.pid}-${args.body.agent}` } }),
    prompt: async (args) => {
      const agent = args.body.agent;
      appendFileSync(markerPath, `${process.pid}:${agent}\n`);
      if (agent === synthesis.CRITIC_AGENT_NAME) {
        return { data: { info: { structured_output: {
          score: 0.98,
          evidenceLinked: true,
          nonDuplicative: true,
          reasons: ["The bounded recommendation is general and evidence-linked."],
          recommendedAction: "accept",
        } } } };
      }
      return { data: { info: { structured_output: mode.includes("no-change") ? {
        action: "no-op",
        logicalName: null,
        proposedContent: "",
        rationale: "The bounded support does not justify a safe reusable change.",
        overlap: [],
        projectAssumptions: [],
      } : {
        action: "recommend",
        logicalName,
        proposedContent: proposed,
        rationale: "Add one general verification step for recurring failures.",
        overlap: [],
        projectAssumptions: [],
      } } } };
    },
    abort: async () => ({ data: {} }),
    delete: async () => ({ data: {} }),
  } },
};

const result = await synthesis.runGlobalSynthesis({
  ctx,
  candidate,
  catalog,
  inventoryModule: inventory,
  options: {
    store,
    hiddenAgentRegistration: { assert: () => {} },
    suppressors: {
      bootValidated: true,
      hostSupported: true,
      circuitBreakerOpen: false,
      processExcluded: false,
    },
    ...(mode === "crash-after-provider" || explicitCrashPoint ? {
      faultInjection(point) {
        if (point === (explicitCrashPoint ?? "global-synthesis-after-provider")) process.kill(process.pid, "SIGKILL");
      },
    } : {}),
  },
  now: timestamp + 1,
});
store.close();
process.stdout.write(JSON.stringify({ ok: result.ok, reason: result.reason ?? null }));
