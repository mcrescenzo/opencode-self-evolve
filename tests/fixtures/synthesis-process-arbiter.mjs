import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { runSynthesis } from "../../self-evolve-synthesis.js";

const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const now = 2_000_000_000_000;
const content = "---\nname: process-arbiter\ndescription: Exercises process synthesis arbitration.\n---\n\n# Process Arbiter\n\nKeep the current behavior.\n";

function store() {
  const records = [];
  const leases = new Map();
  return {
    appendRecord(envelope) {
      if (records.some((record) => record.id === envelope.id)) return { ok: true, duplicate: true, record: envelope };
      records.push(envelope);
      return { ok: true, duplicate: false, record: envelope };
    },
    readRecords(kind) {
      return records.filter((record) => record.kind === kind);
    },
    acquireLease(key) {
      if (leases.has(key)) return { ok: false, reason: "lease-busy" };
      const nonce = hash(key);
      leases.set(key, nonce);
      return { ok: true, nonce };
    },
    releaseLease(key, nonce) {
      if (leases.get(key) !== nonce) return { ok: false, reason: "nonce-mismatch" };
      leases.delete(key);
      return { ok: true };
    },
    getSettings() {
      return {
        global: { budgets: { synthesisPerDay: 1, tokensPerSynthesis: 8000 } },
        repo: { budgets: {} },
      };
    },
  };
}

function target(suffix) {
  return {
    canonicalRoot: "/skills",
    relativePath: `process-arbiter-${suffix}/SKILL.md`,
    logicalName: `process-arbiter-${suffix}`,
    exists: true,
    currentHash: hash(content),
    currentContent: content,
    sizeBytes: Buffer.byteLength(content),
    parsedFrontmatter: { name: `process-arbiter-${suffix}`, description: "Exercises process synthesis arbitration." },
  };
}

function cluster(suffix) {
  const id = hash(`cluster:${suffix}`);
  const observationId = hash(`observation:${suffix}`);
  return {
    id,
    projectFingerprint: hash(`project:${suffix}`),
    lastSeenAt: now,
    observations: [{ id: observationId, createdAt: now, injectionFlagged: false }],
    eligibility: { clusterId: id, eligible: true },
  };
}

function context(output) {
  return {
    client: {
      session: {
        create: async () => ({ data: { id: "hidden-process-arbiter" } }),
        prompt: async () => ({ data: { info: { structured_output: output } } }),
        abort: async () => ({ data: {} }),
        delete: async () => ({ data: {} }),
      },
    },
  };
}

async function attempt(suffix) {
  const skill = target(suffix);
  const evidence = cluster(suffix);
  const output = {
    action: "no-op",
    targetLogicalName: skill.logicalName,
    proposedContent: content,
    evidenceMapping: [{ claim: "Keep the current behavior.", observationIds: [evidence.observations[0].id] }],
    expectedBehavior: "Current behavior remains unchanged.",
    counterExamples: [],
    overlap: [],
    riskNotes: "No change.",
    evaluationScenarios: ["The current behavior remains available."],
  };
  return runSynthesis({
    ctx: context(output),
    cluster: evidence,
    targetSkill: skill,
    inventory: [skill],
    privacy: { checkPartition: () => ({ ok: true }), isObservationEligible: () => true },
    options: {
      store: store(),
      currentContent: content,
      eligibility: evidence.eligibility,
      validateTarget: () => ({ ok: true, errors: [], canonicalTarget: skill }),
      hiddenAgentRegistration: { assert: () => {} },
    },
    now,
  });
}

const first = await attempt("first");
const second = await attempt("second");
writeFileSync(1, JSON.stringify({
  first: first.ok ? "admitted" : first.reason,
  second: second.ok ? "admitted" : second.reason,
}));
