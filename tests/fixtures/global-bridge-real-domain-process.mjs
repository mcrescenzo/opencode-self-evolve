import fs from "node:fs";

import { createApplier } from "../../self-evolve-applier.js";
import { createIntegration } from "../../self-evolve-integration.js";
import * as inventory from "../../self-evolve-inventory.js";
import { createPrivacyGuard } from "../../self-evolve-privacy.js";
import * as schemas from "../../self-evolve-schemas.js";
import { openStore } from "../../self-evolve-store.js";

const [stateRoot, configPath] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const now = () => Date.now() + (config.clockOffsetMs ?? 0);
const store = openStore(stateRoot, {
  projectFingerprint: config.consumerProjectFingerprint,
  now,
  staleLockMs: 1,
  faultInjection(point) {
    if (point === config.faultPoint) process.kill(process.pid, "SIGKILL");
  },
});
const hostCatalog = () => {
  const policy = store.getSettings().global.globalRootPolicy;
  const legacy = inventory.buildGlobalSkillCatalog(policy, { projectRoot: config.consumerProjectRoot });
  return {
    ok: legacy.ok,
    records: legacy.records,
    catalogGenerationHash: legacy.catalogGenerationHash,
    sourceReceiptHash: inventory.hashSkillContent(`real-domain-host:${legacy.catalogGenerationHash}`),
    diagnostics: legacy.blockers?.map((value) => value.code) ?? [],
  };
};
const privacy = createPrivacyGuard({
  consent: store.getSettings().global.consent,
  projectFingerprint: config.consumerProjectFingerprint,
  store,
});
const applier = createApplier({
  store,
  inventory: { records: [], canonicalRoots: [] },
  privacy,
  now,
});
const fakeTimer = { unref() {} };
const integration = createIntegration({
  store,
  inventory,
  privacy,
  schemas,
  observation: {},
  synthesisModule: {},
  applier,
  commands: {},
  pipeline: {
    createPipeline: () => ({
      recoverContributionTransactions: () => ({ ok: true, recovered: 0, failed: 0, outcomes: [] }),
      recoverSynthesisAttempts: () => [],
    }),
  },
  scheduler: {
    createScheduler: () => ({
      setMode() {},
      getCircuitBreaker: () => ({ open: false }),
      stopAdmission() {},
      async drain() {},
      dispose() {},
    }),
  },
  options: {
    stateRoot,
    hostSupported: true,
    getHostGlobalSkillCatalog: hostCatalog,
    ctx: { directory: config.consumerProjectRoot },
    __testSetMailboxInterval: () => fakeTimer,
    __testClearMailboxInterval: () => {},
    __testSetInterval: () => fakeTimer,
    __testClearInterval: () => {},
  },
  now,
});

try {
  const boot = await integration.boot({
    processMailbox: config.mode === "reject-crash" || config.mode === undefined ? false : undefined,
    recoverHostSessions: false,
  });
  if (!boot.ok) throw new Error(boot.health?.lastError ?? "consumer-boot-failed");
  if (config.readyPath) fs.writeFileSync(config.readyPath, "ready", { flag: "wx" });
  if (config.mode === "reject-crash") {
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(config.requestReadyPath)) {
      if (Date.now() >= deadline) throw new Error("timed out waiting for reject request");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await integration.processMailbox();
    throw new Error(`reject fault did not terminate at ${config.faultPoint}`);
  }
  if (config.mode === "reject-recover") {
    const recommendations = new Map(store.readGlobalRecommendations().map((value) => [value.recommendationId, value]));
    fs.writeFileSync(config.resultPath, JSON.stringify({
      boot,
      rejectState: recommendations.get(config.rejectRecommendationId)?.state ?? null,
      recommendations: [...recommendations.values()],
      audits: store.readGlobalAudits(),
      decisions: store.readGlobalDecisions(),
      applyIntents: store.readGlobalApplyIntents(),
      outcomes: store.readGlobalDecisionOutcomes(),
      rejectContent: config.rejectTargetPath ? fs.readFileSync(config.rejectTargetPath, "utf8") : null,
    }), { flag: "wx" });
  } else {
    let applyReady = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await integration.processMailbox();
      const recommendations = new Map(store.readGlobalRecommendations().map((value) => [value.recommendationId, value]));
      if (!applyReady
          && recommendations.get(config.applyRecommendationId)?.state === "applied"
          && recommendations.get(config.rejectRecommendationId)?.state === "rejected") {
        applyReady = true;
        fs.writeFileSync(config.applyReadyPath, "ready", { flag: "wx" });
      }
      if (recommendations.get(config.applyRecommendationId)?.state === "rolled-back"
          && recommendations.get(config.rejectRecommendationId)?.state === "rejected") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const recommendations = new Map(store.readGlobalRecommendations().map((value) => [value.recommendationId, value]));
    const result = {
      applyState: recommendations.get(config.applyRecommendationId)?.state ?? null,
      rejectState: recommendations.get(config.rejectRecommendationId)?.state ?? null,
      recommendations: [...recommendations.values()],
      applyContent: fs.readFileSync(config.applyTargetPath, "utf8"),
      rejectContent: fs.readFileSync(config.rejectTargetPath, "utf8"),
      audits: store.readGlobalAudits(),
      decisions: store.readGlobalDecisions(),
      outcomes: store.readGlobalDecisionOutcomes(),
    };
    fs.writeFileSync(config.resultPath, JSON.stringify(result), { flag: "wx" });
  }
} finally {
  await integration.shutdown();
}
