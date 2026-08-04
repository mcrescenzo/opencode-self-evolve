import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readBoundedInspection } from "../self-evolve-bridge.js";
import {
  makeEligibilityExplanation,
  makeObservation,
  wrapRecord,
} from "../self-evolve-schemas.js";
import { openStore } from "../self-evolve-store.js";

const PROJECT = "a".repeat(64);

function tree(root) {
  const output = {};
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else output[path.relative(root, filePath)] = {
        mode: statSync(filePath).mode & 0o777,
        source: readFileSync(filePath, "utf8"),
      };
    }
  };
  visit(root);
  return output;
}

test("bounded inspection exposes sanitized summaries without identifiers or mutation", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-inspection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = openStore(root, { projectFingerprint: PROJECT, projectName: "inspection", now: () => 10 });
  const observation = makeObservation({
    id: "b".repeat(64),
    projectFingerprint: PROJECT,
    receiptIds: ["c".repeat(64)],
    structuredFields: { messageCount: 3, explicitUserSignal: true },
    incidentId: "private-incident-id",
    sessionLineageHash: "d".repeat(64),
    createdAt: 5,
    injectionFlagged: false,
    redacted: true,
  });
  const eligibility = makeEligibilityExplanation({
    clusterId: "e".repeat(64),
    eligible: false,
    reasons: ["min-incidents"],
    thresholdsMet: { minOccurrences: 3 },
    thresholdsMissed: { minIncidents: 1 },
  });
  store.appendRecord(wrapRecord("observation", observation, 5));
  store.appendRecord(wrapRecord("eligibility-explanation", eligibility, 6));
  const before = tree(root);
  const result = readBoundedInspection(root, PROJECT, { limit: 1 });
  const after = tree(root);
  assert.deepEqual(after, before);
  assert.equal(result.observations.length, 1);
  assert.equal(result.eligibility.length, 1);
  assert.match(result.observations[0].summary, /messageCount=3/u);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /private-incident-id/u);
  assert.doesNotMatch(serialized, new RegExp(observation.id, "u"));
  assert.doesNotMatch(serialized, new RegExp(observation.sessionLineageHash, "u"));
  assert.doesNotMatch(serialized, new RegExp(eligibility.clusterId, "u"));
  assert.deepEqual(readBoundedInspection(root, PROJECT, { limit: 0 }), {
    observations: [],
    eligibility: [],
    overflow: { observations: 1, eligibility: 1 },
  });
});

test("inspection bounds and cross-project partition fail closed", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-inspection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  openStore(root, { projectFingerprint: PROJECT, projectName: "inspection" }).close();
  assert.throws(() => readBoundedInspection(root, PROJECT, { limit: 65 }), /out-of-bounds/u);
  assert.deepEqual(readBoundedInspection(root, "f".repeat(64)), {
    observations: [],
    eligibility: [],
    overflow: { observations: 0, eligibility: 0 },
  });
});
