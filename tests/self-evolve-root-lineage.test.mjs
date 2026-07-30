import assert from "node:assert/strict";
import test from "node:test";
import {
  correlateObservations,
  evaluateEligibility,
  hashRootLineage,
  hashSessionLineage,
  resolveRootLineage,
} from "../self-evolve-observation.js";
import * as observationModule from "../self-evolve-observation.js";
import { createPipeline } from "../self-evolve-pipeline.js";
import {
  UNKNOWN_ROOT_LINEAGE_HASH,
  makeObservation,
} from "../self-evolve-schemas.js";
import * as schemasModule from "../self-evolve-schemas.js";

const H = (character) => character.repeat(64);
const PROJECT = H("a");
const OTHER_PROJECT = H("b");
const SCOPE = H("c");
const SIGNATURE = H("d");
const NOW = 2_100_000_000_000;

function hostSession(id, { parentID, projectFingerprint = PROJECT, hidden, agent, createdBy } = {}) {
  return {
    type: "session.idle",
    properties: {
      sessionID: id,
      session: {
        id,
        projectFingerprint,
        ...(parentID === undefined ? {} : { parentID }),
        ...(hidden === undefined ? {} : { hidden }),
        ...(agent === undefined ? {} : { agent }),
        ...(createdBy === undefined ? {} : { createdBy }),
      },
    },
  };
}

function record(incidentId, rootID, originKind = "user", overrides = {}) {
  return makeObservation({
    id: hashSessionLineage(`observation-${incidentId}`),
    projectFingerprint: PROJECT,
    receiptIds: [SIGNATURE],
    structuredFields: {
      receiptType: "repeated-command",
      scopeFingerprint: SCOPE,
      occurrences: 1,
      deterministicOutcome: true,
    },
    incidentId,
    sessionLineageHash: hashSessionLineage(overrides.childID ?? incidentId),
    rootLineageHash: hashRootLineage(rootID),
    originKind,
    createdAt: overrides.createdAt ?? NOW,
    injectionFlagged: false,
    redacted: true,
  });
}

function eligibility(records, thresholds = {}) {
  return evaluateEligibility(correlateObservations(records), {
    now: NOW,
    minIndependentIncidents: records.length,
    minOccurrencesSum: records.length,
    minDistinctSessions: 2,
    ...thresholds,
  })[0];
}

function pipelineFixture() {
  const records = [];
  const store = {
    appendRecord(envelope) { records.push(envelope); return { ok: true }; },
    readRecords(kind) { return records.filter((recordValue) => recordValue.kind === kind); },
  };
  const pipeline = createPipeline({
    store,
    inventory: {},
    privacy: {
      scrubExcerpt: () => ({ ok: false }),
      scanForForbiddenContent: () => ({ issues: [] }),
      scrubObservation: (value) => ({ ok: true, sanitized: value }),
      isObservationEligible: () => true,
    },
    synthesis: {},
    applier: {},
    commands: {},
    schemas: schemasModule,
    observation: observationModule,
    now: () => NOW,
  });
  const ctx = { client: { session: { messages: async () => ({ data: [
    { id: "message-one", role: "user", parts: [{ type: "text", text: "/repeat" }] },
    { id: "message-two", role: "user", parts: [{ type: "text", text: "/repeat" }] },
  ] }) } } };
  return { pipeline, store, ctx };
}

test("root hash is stable and domain-separated from child session lineage", () => {
  assert.match(hashRootLineage("root-one"), /^[a-f0-9]{64}$/u);
  assert.notEqual(hashRootLineage("root-one"), hashSessionLineage("root-one"));
});

test("parent, grandchild, and sibling descendants inherit one non-independent user root", () => {
  const sessions = [
    hostSession("root"),
    hostSession("child", { parentID: "root", hidden: true }),
    hostSession("grandchild", { parentID: "child", hidden: true }),
    hostSession("sibling", { parentID: "root", hidden: true }),
  ];
  const child = resolveRootLineage({ sessionID: "child", projectFingerprint: PROJECT, sessions });
  const grandchild = resolveRootLineage({ sessionID: "grandchild", projectFingerprint: PROJECT, sessions });
  const sibling = resolveRootLineage({ sessionID: "sibling", projectFingerprint: PROJECT, sessions });
  assert.deepEqual([child.originKind, grandchild.originKind, sibling.originKind], ["delegated", "delegated", "delegated"]);
  assert.equal(new Set([child.rootLineageHash, grandchild.rootLineageHash, sibling.rootLineageHash]).size, 1);

  const result = eligibility([
    record("root-incident", "root", "user"),
    record("child-incident", "root", child.originKind),
    record("grandchild-incident", "root", grandchild.originKind),
    record("sibling-incident", "root", sibling.originKind),
  ]);
  assert.equal(result.eligible, false);
  assert.match(result.thresholdsMissed.minDistinctSessions, /actual 1/u);
});

test("two unrelated direct user roots satisfy distinct-root eligibility", () => {
  const first = resolveRootLineage({ sessionID: "root-one", projectFingerprint: PROJECT, sessions: [hostSession("root-one")] });
  const second = resolveRootLineage({ sessionID: "root-two", projectFingerprint: PROJECT, sessions: [hostSession("root-two")] });
  assert.deepEqual([first.originKind, second.originKind], ["user", "user"]);
  const result = eligibility([
    record("incident-one", "root-one", first.originKind),
    record("incident-two", "root-two", second.originKind),
  ]);
  assert.equal(result.eligible, true);
});

test("delegated evidence inherits its root and cannot add independent evidence", () => {
  const delegated = resolveRootLineage({
    sessionID: "subagent",
    projectFingerprint: PROJECT,
    sessions: [hostSession("root"), hostSession("subagent", { parentID: "root", agent: "worker" })],
  });
  assert.equal(delegated.rootLineageHash, hashRootLineage("root"));
  assert.equal(delegated.originKind, "delegated");
  const result = eligibility([
    record("root-incident", "root", "user"),
    record("delegated-incident", "root", delegated.originKind),
  ]);
  assert.equal(result.eligible, false);
  assert.match(result.thresholdsMissed.minDistinctSessions, /actual 1/u);
});

test("hidden and plugin-created roots cannot satisfy independent-root eligibility", () => {
  const hidden = resolveRootLineage({
    sessionID: "hidden-root",
    projectFingerprint: PROJECT,
    sessions: [hostSession("hidden-root", { hidden: true, agent: "analyzer" })],
  });
  const plugin = resolveRootLineage({
    sessionID: "plugin-root",
    projectFingerprint: PROJECT,
    sessions: [hostSession("plugin-root", { createdBy: "plugin" })],
  });
  assert.deepEqual([hidden.originKind, plugin.originKind], ["hidden", "plugin-created"]);
  const result = eligibility([
    record("hidden-incident", "hidden-root", hidden.originKind),
    record("plugin-incident", "plugin-root", plugin.originKind),
  ]);
  assert.equal(result.eligible, false);
  assert.match(result.thresholdsMissed.minDistinctSessions, /actual 0/u);
});

test("cycle, missing parent, cross-project parent, depth excess, and reused ids fail to unknown", () => {
  const fixtures = [
    ["cycle-a", [hostSession("cycle-a", { parentID: "cycle-b" }), hostSession("cycle-b", { parentID: "cycle-a" })]],
    ["missing-child", [hostSession("missing-child", { parentID: "absent" })]],
    ["cross-child", [hostSession("cross-child", { parentID: "cross-root" }), hostSession("cross-root", { projectFingerprint: OTHER_PROJECT })]],
    ["deep-17", Array.from({ length: 18 }, (_, index) => hostSession(`deep-${index}`, index === 0 ? {} : { parentID: `deep-${index - 1}` }))],
    ["reused", [hostSession("reused"), hostSession("reused", { parentID: "other" }), hostSession("other")]],
  ];
  for (const [sessionID, sessions] of fixtures) {
    const result = resolveRootLineage({ sessionID, projectFingerprint: PROJECT, sessions });
    assert.equal(result.resolved, false, sessionID);
    assert.equal(result.rootLineageHash, UNKNOWN_ROOT_LINEAGE_HASH, sessionID);
    assert.equal(result.originKind, "unknown", sessionID);
    assert.equal("rootSessionID" in result, false, sessionID);
  }
});

test("legacy observations backfill conservative root and origin defaults", () => {
  const legacy = { ...record("legacy", "legacy-root") };
  delete legacy.rootLineageHash;
  delete legacy.originKind;
  const clean = makeObservation(legacy);
  assert.equal(clean.rootLineageHash, UNKNOWN_ROOT_LINEAGE_HASH);
  assert.equal(clean.originKind, "unknown");
  const result = eligibility([clean], { minIndependentIncidents: 1, minOccurrencesSum: 1, minDistinctSessions: 1 });
  assert.equal(result.eligible, false);
  assert.match(result.thresholdsMissed.minDistinctSessions, /actual 0/u);
});

test("pipeline persists a consistent scheduler root and preserves explicit unresolved ancestry", async () => {
  const trusted = pipelineFixture();
  await trusted.pipeline.runEvolutionCycle({
    ctx: trusted.ctx,
    sessionID: "delegated-child",
    projectFingerprint: PROJECT,
    scopeFingerprint: SCOPE,
    trigger: "scheduler",
    mode: "auto",
    rootSessionID: "trusted-root",
    rootSessionIDHash: hashRootLineage("trusted-root"),
    originKind: "delegated",
    options: { eligibility: { minIndependentIncidents: 1, minOccurrencesSum: 1, minDistinctSessions: 1 } },
  });
  const trustedObservation = trusted.store.readRecords("observation")[0].payload;
  assert.equal(trustedObservation.rootLineageHash, hashRootLineage("trusted-root"));
  assert.equal(trustedObservation.originKind, "delegated");

  const unresolved = pipelineFixture();
  await unresolved.pipeline.runEvolutionCycle({
    ctx: unresolved.ctx,
    sessionID: "unresolved-child",
    projectFingerprint: PROJECT,
    scopeFingerprint: SCOPE,
    trigger: "scheduler",
    mode: "auto",
    rootSessionIDHash: UNKNOWN_ROOT_LINEAGE_HASH,
    originKind: "unknown",
    options: { eligibility: { minIndependentIncidents: 1, minOccurrencesSum: 1, minDistinctSessions: 1 } },
  });
  const unresolvedObservation = unresolved.store.readRecords("observation")[0].payload;
  assert.equal(unresolvedObservation.rootLineageHash, UNKNOWN_ROOT_LINEAGE_HASH);
  assert.equal(unresolvedObservation.originKind, "unknown");
});

test("observation records persist hashes and bounded origin only", () => {
  const rawSessionID = "host-session-private";
  const rawParentID = "host-parent-private";
  const transcriptCanary = "complete-transcript-must-not-persist";
  const clean = record("privacy-incident", rawParentID, "delegated", { childID: rawSessionID });
  const serialized = JSON.stringify(clean);
  assert.doesNotMatch(serialized, new RegExp(`${rawSessionID}|${rawParentID}|${transcriptCanary}`, "u"));
  assert.deepEqual(Object.keys(clean), [
    "id", "projectFingerprint", "receiptIds", "structuredFields", "incidentId", "sessionLineageHash",
    "rootLineageHash", "originKind", "createdAt", "injectionFlagged", "redacted",
  ]);
});
