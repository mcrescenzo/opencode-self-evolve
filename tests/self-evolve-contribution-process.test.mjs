import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createPrivacyGuard } from "../self-evolve-privacy.js";
import { makeEvidenceCluster, makeGlobalSettings, wrapRecord } from "../self-evolve-schemas.js";
import { hashContent, openStore } from "../self-evolve-store.js";

const PROJECT = "a".repeat(64);
const PROJECT_B = "f".repeat(64);
const SCOPE = "b".repeat(64);
const CLUSTER = "c".repeat(64);
const DOMAIN = "d".repeat(64);
const SIGNATURE = "e".repeat(64);
const NOW = 10_000;
const CHILD = path.join(import.meta.dirname, "fixtures", "contribution-transaction-child.mjs");

function runChild(root, input, faultPoint = "", storeOptions = {}) {
  return new Promise((resolve, reject) => {
    const resultPath = path.join(root, `.contribution-result-${randomUUID()}.json`);
    const child = spawn(process.execPath, [CHILD, root, PROJECT, resultPath, JSON.stringify(input), faultPoint, JSON.stringify(storeOptions)], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (faultPoint) {
        if (signal === "SIGKILL") resolve({ killed: true });
        else reject(new Error(`expected-SIGKILL:${code}:${signal}:${stderr}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`child-exit-${code}:${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(readFileSync(resultPath, "utf8")));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function seed(root, incidentId = "process-incident", clusterId = CLUSTER) {
  const store = openStore(root, { projectFingerprint: PROJECT, now: () => NOW, staleLockMs: 1 });
  assert.equal(store.updateGlobalSettings((global) => makeGlobalSettings({
    ...global,
    consent: { ...global.consent, durableObservations: true, sanitizedExcerpts: true, crossRepoAggregation: true },
    updatedAt: NOW,
  })).ok, true);
  const privacy = createPrivacyGuard({ projectFingerprint: PROJECT, store, now: () => NOW });
  const capsule = privacy.createEvidenceCapsule({
    incidentId,
    receiptType: "repeated-command",
    targetLogicalName: null,
    summary: "Command verify recurred 2 times and required repeated handling.",
  }).capsule;
  assert.ok(capsule);
  const cluster = makeEvidenceCluster({
    id: clusterId,
    receiptType: "repeated-command",
    projectFingerprint: PROJECT,
    incidentIds: [incidentId],
    scopeFingerprint: SCOPE,
    targetLogicalName: null,
    occurrencesSum: 2,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
  });
  assert.equal(store.appendRecord(wrapRecord("evidence-cluster", cluster, NOW)).ok, true);
  store.close();
  return {
    claimType: "global-skill-candidate",
    receiptType: "repeated-command",
    signatureHash: SIGNATURE,
    incidentId,
    capsuleId: capsule.capsuleId,
    clusterId,
    evidenceDomainId: DOMAIN,
    occurrenceCount: 2,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
  };
}

function globalContributionFiles(root) {
  const directory = path.join(root, "self-evolve", "global", "contributions");
  const visit = (current) => {
    try {
      return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
        const filePath = path.join(current, entry.name);
        return entry.isDirectory() ? visit(filePath) : [filePath];
      });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  };
  return visit(directory);
}

test("concurrent contribution processes canonicalize one incident to one global record", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-contribution-concurrent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = seed(root);

  const results = await Promise.all(Array.from({ length: 8 }, () => runChild(root, input)));

  assert.equal(results.every((result) => result.ok), true, JSON.stringify(results));
  assert.equal(results.filter((result) => result.duplicate === false).length, 1);
  assert.equal(new Set(results.map((result) => result.contribution.contributionId)).size, 1);
  const store = openStore(root, { projectFingerprint: PROJECT, now: () => NOW, staleLockMs: 1 });
  assert.equal(store.readContributions({ scope: "global", includeExpired: true }).length, 1);
  assert.equal(store.readContributions({ scope: "project", includeExpired: true }).length, 1);
  assert.equal(store.readContributionIntents().length, 1);
  assert.equal(store.readContributionLinks().length, 1);
  assert.equal(globalContributionFiles(root).length, 1);
  store.close();
});

test("SIGKILL before and after every contribution step converges during boot recovery", async (t) => {
  for (const faultPoint of [
    "contribution-before-intent-write",
    "contribution-after-intent-write",
    "contribution-before-global-write",
    "contribution-global-after-create",
    "contribution-after-global-write",
    "contribution-before-link-write",
    "contribution-link-after-create",
    "contribution-after-link-write",
    "contribution-before-commit-write",
    "contribution-after-commit-write",
  ]) {
    await t.test(faultPoint, async (t) => {
      const root = mkdtempSync(path.join(tmpdir(), `self-evolve-contribution-${faultPoint}-`));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const input = seed(root, `incident-${faultPoint}`);
      assert.deepEqual(await runChild(root, input, faultPoint), { killed: true });

      const store = openStore(root, { projectFingerprint: PROJECT, now: () => NOW, staleLockMs: 1 });
      const privacy = createPrivacyGuard({ projectFingerprint: PROJECT, store, now: () => NOW });
      const retry = privacy.publishContribution(input);
      assert.equal(retry.ok, true, `${faultPoint}:${JSON.stringify(retry)}`);
      assert.equal(store.readContributions({ scope: "global", includeExpired: true }).length, 1);
      assert.equal(store.readContributions({ scope: "project", includeExpired: true }).length, 1);
      assert.deepEqual(store.readContributionIntents().map((intent) => intent.state), ["committed"]);
      assert.equal(store.readContributionLinks().length, 1);
      assert.equal(globalContributionFiles(root).length, 1);
      const serialized = globalContributionFiles(root).map((filePath) => readFileSync(filePath, "utf8")).join("\n");
      for (const privateValue of [PROJECT, input.incidentId, input.capsuleId, input.clusterId, input.evidenceDomainId, hashContent(input.incidentId)]) {
        assert.equal(serialized.includes(privateValue), false, `${faultPoint}:${privateValue}`);
      }
      store.close();
    });
  }
});

test("a different project boot recovers a globally published cross-partition intent", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-contribution-cross-partition-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = seed(root, "cross-partition-incident");
  assert.deepEqual(await runChild(root, input, "contribution-after-global-write"), { killed: true });

  const other = openStore(root, { projectFingerprint: PROJECT_B, now: () => NOW, staleLockMs: 1 });
  assert.equal(other.readContributions({ scope: "global", includeExpired: true }).length, 1);
  assert.equal(other.readContributions({ scope: "project", includeExpired: true }).length, 0);
  other.close();

  const originating = openStore(root, { projectFingerprint: PROJECT, now: () => NOW, staleLockMs: 1 });
  assert.equal(originating.readContributions({ scope: "project", includeExpired: true }).length, 1);
  assert.deepEqual(originating.readContributionIntents().map((intent) => intent.state), ["committed"]);
  assert.equal(originating.readContributionLinks().length, 1);
  originating.close();
});

test("concurrent contribution processes cannot exceed the global file quota", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-contribution-quota-race-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = seed(root, "quota-race-incident-1");
  const second = seed(root, "quota-race-incident-2", hashContent("quota-race-cluster-2"));
  const probe = openStore(root, { projectFingerprint: PROJECT, now: () => NOW, staleLockMs: 1 });
  const baseline = probe.getGlobalUsage();
  probe.close();
  const storeOptions = { globalQuotaFiles: baseline.filesUsed + 1 };

  const results = await Promise.all([
    runChild(root, first, "", storeOptions),
    runChild(root, second, "", storeOptions),
  ]);

  assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
  const denied = results.find((result) => !result.ok);
  assert.match(denied.reason, /quota/u);
  assert.equal(globalContributionFiles(root).length, 1);
  const store = openStore(root, { projectFingerprint: PROJECT, now: () => NOW, staleLockMs: 1, ...storeOptions });
  const usage = store.getGlobalUsage();
  assert.equal(usage.filesUsed <= usage.quotaFiles, true, JSON.stringify(usage));
  assert.equal(store.readContributions({ scope: "global", includeExpired: true }).length, 1);
  assert.deepEqual(
    store.readContributionIntents().filter((intent) => intent.state === "committed").length,
    1,
  );
  store.close();
});
