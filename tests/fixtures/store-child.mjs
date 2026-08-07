import { createPrivacyGuard } from "../../self-evolve-privacy.js";
import { writeFileSync, utimesSync } from "node:fs";
import path from "node:path";
import {
  makeGlobalSettings,
  makeRepoSettings,
  makeDecision,
  makeObservation,
  makeProposal,
  wrapRecord,
} from "../../self-evolve-schemas.js";
import { hashContent, openStore } from "../../self-evolve-store.js";

const [root, projectFingerprint, operation, resultPath, value = "child"] = process.argv.slice(2);
const now = 10_000;

function writeResult(valueToWrite) {
  writeFileSync(resultPath, `${JSON.stringify(valueToWrite)}\n`, { encoding: "utf8", mode: 0o600 });
}

if (operation === "crash-lock") {
  const lockPath = path.join(root, ".self-evolve-mutation.lock");
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, nonce: "crashed-child", acquiredAt: 0 }), { mode: 0o600, flag: "wx" });
  utimesSync(lockPath, new Date(0), new Date(0));
  writeResult({ ok: true, pid: process.pid });
  process.exit(0);
}

const store = openStore(root, { projectName: "child", projectFingerprint, now: () => now });

let result;
if (operation === "append") {
  const id = hashContent(`observation:${value}`);
  const observation = makeObservation({
    id,
    projectFingerprint,
    receiptIds: [hashContent(`receipt:${value}`)],
    structuredFields: { receiptType: "repeated-command", scopeFingerprint: hashContent("scope"), occurrences: 1 },
    incidentId: `incident-${value}`,
    createdAt: now,
    injectionFlagged: false,
    redacted: true,
  });
  result = store.appendRecord(wrapRecord("observation", observation, now));
} else if (operation === "cas") {
  result = store.runCas("proposal", "proposal-1", "pending", (current) => ({ ...current, state: value, decisionVersion: 1 }));
} else if (operation === "set-global") {
  const current = store.getSettings().global;
  result = store.setGlobalSettings(makeGlobalSettings({ ...current, mode: value, updatedAt: now }));
} else if (operation === "read-global") {
  result = { mode: store.getSettings().global.mode };
} else if (operation === "read-settings-result") {
  try {
    store.getSettings();
    result = { ok: true };
  } catch (error) {
    result = { ok: false, reason: error?.message ?? String(error) };
  }
} else if (operation === "update-global-mode") {
  result = store.updateGlobalSettings((global) => makeGlobalSettings({ ...global, mode: value, updatedAt: global.updatedAt + 1 }));
} else if (operation === "update-global-consent") {
  result = store.updateGlobalSettings((global) => makeGlobalSettings({
    ...global,
    consent: { ...global.consent, sanitizedExcerpts: value === "true" },
    updatedAt: global.updatedAt + 1,
  }));
} else if (operation === "update-global-pause") {
  result = store.updateGlobalSettings((global) => makeGlobalSettings({ ...global, paused: value === "true", updatedAt: global.updatedAt + 1 }));
} else if (operation === "update-global-allowlist") {
  result = store.updateGlobalSettings((global) => makeGlobalSettings({ ...global, allowedSkillRoots: [value], updatedAt: global.updatedAt + 1 }));
} else if (operation === "update-repo-mode") {
  result = store.updateRepoSettings((repo) => makeRepoSettings({ ...repo, mode: value }));
} else if (operation === "update-repo-excluded") {
  result = store.updateRepoSettings((repo) => makeRepoSettings({ ...repo, excluded: value === "true" }));
} else if (operation === "aggregate") {
  const consentUpdate = store.updateGlobalSettings((global) => makeGlobalSettings({
    ...global,
    consent: { ...global.consent, sanitizedExcerpts: true, crossRepoAggregation: true },
    updatedAt: now,
  }));
  if (!consentUpdate.ok) result = consentUpdate;
  else {
    const guard = createPrivacyGuard({
      consent: { sanitizedExcerpts: true, crossRepoAggregation: true },
      projectFingerprint,
      now: () => now,
      store,
    });
    result = guard.contributeAggregate({
      claimType: "global-skill-candidate",
      receiptType: "repeated-command",
      signatureHash: hashContent("shared-signature"),
      incidentId: value,
      occurrenceCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }
} else if (operation === "retain") {
  result = store.retain(Number(value));
} else if (operation === "append-at") {
  const timestamp = Number(value);
  const id = hashContent(`observation-at:${process.pid}:${timestamp}`);
  result = store.appendRecord(wrapRecord("observation", makeObservation({
    id,
    projectFingerprint,
    receiptIds: [hashContent(`receipt-at:${process.pid}`)],
    structuredFields: { receiptType: "repeated-command", scopeFingerprint: hashContent("scope"), occurrences: 1 },
    incidentId: `incident-${process.pid}`,
    createdAt: timestamp,
    injectionFlagged: false,
    redacted: true,
  }), timestamp));
} else if (operation === "decision") {
  const timestamp = Number(value);
  result = store.appendRecord(wrapRecord("decision", makeDecision({
    proposalId: "proposal-concurrent",
    targetHash: hashContent("current"),
    proposedContentHash: hashContent("proposed"),
    decisionVersion: 1,
    actor: "child-retention-test",
    timestamp,
    nonce: `decision-${process.pid}`,
    priorState: "pending",
    newState: "rejected",
  }), timestamp));
} else if (operation === "seed-proposal") {
  const proposal = makeProposal({
    id: "proposal-1",
    projectFingerprint,
    clusterId: hashContent("cluster"),
    skillTarget: { canonicalRoot: "/skills", relativePath: "review/SKILL.md", currentHash: hashContent("current") },
    proposedContentHash: hashContent("proposed"),
    rationaleText: "Bounded child-process fixture proposal.",
    synthesizedAt: now,
    synthesizerModelId: "fixture/model",
    criticScore: 1,
    criticPassed: true,
    validDeterministic: true,
    state: "pending",
    injectionFlagged: false,
    decisionVersion: 0,
  });
  result = store.appendRecord(wrapRecord("proposal", proposal, now));
} else {
  result = { ok: false, reason: "unknown-operation" };
}

store.close();
writeResult(result);
