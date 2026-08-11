import fs from "node:fs";
import { GLOBAL_PROJECTION_LEASE_KEY, publishGlobalRecommendationProjection } from "../../self-evolve-bridge.js";
import { buildGlobalRecommendationProjection } from "../../self-evolve-projection.js";
import { openStore } from "../../self-evolve-store.js";

const [
  root,
  projectFingerprint,
  variant,
  expectedGenerationText,
  timestampText,
  resultPath,
  readyPath = "-",
  releasePath = "-",
] = process.argv.slice(2);
const now = Number(timestampText);
const expectedGeneration = expectedGenerationText === "null" ? null : expectedGenerationText;
const H = (value) => {
  let hash = "";
  for (let index = 0; hash.length < 64; index += 1) hash += `${value}${index}`.replace(/[^a-z0-9]/gu, "").padEnd(8, "0");
  return hash.slice(0, 64).replace(/[^a-f0-9]/gu, "a");
};
const CONTENT = "---\nname: durable-review\ndescription: Reviews repeated failures safely.\n---\n\n# Durable Review\n\nInspect the failure.\n";
const PROPOSED = `${CONTENT}\nVerify the failure before suggesting a correction. Variant ${variant}.\n`;

const store = openStore(root, { projectFingerprint, now: () => now, staleLockMs: 1 });

// `abandon` proves dead-owner recovery: the process takes the global projection
// lease and dies without publishing anything.
if (variant === "abandon") {
  const acquired = store.acquireGlobalLease({
    leaseKind: "global-projection",
    leaseKeyHash: GLOBAL_PROJECTION_LEASE_KEY,
    ttlMs: 10_000,
  });
  fs.writeFileSync(resultPath, `${JSON.stringify({ ok: acquired?.ok === true, reason: acquired?.reason ?? null })}\n`, { encoding: "utf8", mode: 0o600 });
  if (readyPath !== "-") fs.writeFileSync(readyPath, "ready", { flag: "wx" });
  process.kill(process.pid, "SIGKILL");
}

const recommendationId = H(`recommendation${variant}`);
const candidateId = H(`candidate${variant}`);
const supportSetHash = H(`support${variant}`);
let nonce = 0;
const projection = buildGlobalRecommendationProjection({
  recommendations: [{
    recommendationId,
    candidateId,
    supportSetHash,
    targetBinding: {
      targetKind: "existing-global-skill",
      logicalName: "durable-review",
      relativePath: "durable-review/SKILL.md",
      currentHash: H("current"),
      bindingHash: H("binding"),
    },
    proposedContentHash: H(`proposed${variant}`),
    rationaleText: `Independent support warrants one bounded global correction (${variant}).`,
    synthesizedAt: now - 1_000,
    criticScore: 0.99,
    criticPassed: true,
    validDeterministic: true,
    state: "pending",
    decisionVersion: 0,
  }],
  supportSets: [{
    supportSetHash,
    candidateId,
    contributionIds: ["11111111-1111-4111-8111-111111111111"],
    strongestSingleDomain: { independentIncidentCount: 2, occurrenceCount: 3 },
    distributed: { independentKnownDomainCount: 1, independentIncidentCount: 2 },
    firstSeenDay: "2026-08-01",
    lastSeenDay: "2026-08-11",
  }],
  candidates: [{
    candidateId,
    supportSetHash,
    eligibilityRoute: "single-domain",
    independentDomainCount: 1,
    independentIncidentCount: 2,
    occurrenceCount: 3,
    updatedAt: now - 500,
  }],
  audits: [],
  contentByRecommendation: { [recommendationId]: PROPOSED },
}, {
  stateRootIdentity: store.rootIdentity,
  now,
  targetReader: () => ({ exists: true, content: CONTENT, hash: H("current") }),
  nonceFactory: () => `00000000-0000-4000-8000-${String(variant).padStart(4, "0")}${String(++nonce).padStart(8, "0")}`,
});

if (readyPath !== "-") {
  fs.writeFileSync(readyPath, "ready", { flag: "wx" });
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(releasePath)) Atomics.wait(wait, 0, 0, 5);
}

let result;
try {
  const published = publishGlobalRecommendationProjection(root, projection, { store, expectedGeneration, now });
  result = { ok: true, generation: published.index.generation, indexHash: published.index.indexHash, recommendationId };
} catch (error) {
  result = { ok: false, reason: error?.message ?? String(error), recommendationId };
}
store.close();
fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`, { encoding: "utf8", mode: 0o600 });
