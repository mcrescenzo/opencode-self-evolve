import assert from "node:assert/strict";
import test from "node:test";
import { createPipeline } from "../self-evolve-pipeline.js";
import * as observationModule from "../self-evolve-observation.js";
import {
  extractReceipts,
  isAutomationControlPart,
  partIsExcludedFromEvidence,
} from "../self-evolve-observation.js";
import * as schemasModule from "../self-evolve-schemas.js";

const FINGERPRINT = "a".repeat(64);
const SCOPE = "b".repeat(64);
const NOW = 2_100_000_000_000;
const automation = (kind, overrides = {}) => ({
  schema: "automation-provenance/v1",
  kind,
  ...overrides,
});
const part = (text, marker) => ({ type: "text", text, metadata: { automation: marker } });

function receipts(messages) {
  return extractReceipts({ startedAt: NOW - 1, endedAt: NOW, messages }, {
    projectFingerprint: FINGERPRINT,
    scopeFingerprint: SCOPE,
    now: NOW,
  });
}

test("recognized control and display envelopes are exclusion-only", () => {
  const control = part("/authorize", automation("control", {
    producer: "anonymous-automation",
    nonce: "dedup-1",
    trust: "user",
    authority: "yolo",
  }));
  const display = part("status panel", automation("display"));

  assert.equal(isAutomationControlPart(control), true);
  assert.equal(isAutomationControlPart(display), true);
  assert.equal(partIsExcludedFromEvidence(control), true);
  assert.equal(partIsExcludedFromEvidence(display), true);
  assert.deepEqual(receipts([
    { role: "user", commandName: "/authorize", parts: [control] },
    { role: "user", commandName: "/authorize", parts: [structuredClone(control)] },
  ]), []);

});

test("display exclusion does not classify surrounding ordinary evidence", () => {
  assert.equal(partIsExcludedFromEvidence(part("render-only control text", automation("display"))), true);
  assert.equal(partIsExcludedFromEvidence({ type: "text", text: "ordinary assistant outcome" }), false);
});

test("malformed and unknown envelopes remain ordinary evidence", () => {
  const cases = [
    { schema: 1, kind: "control" },
    { schema: "automation-provenance/v1" },
    { schema: "automation-provenance/v1", kind: "unknown" },
    { schema: "automation-provenance/v1", kind: "authorize", trust: "user", authority: "trusted" },
    { schema: "automation-provenance/v1", kind: "control", producer: "" },
    { schema: "automation-provenance/v1", kind: "control", producer: "x".repeat(65) },
    { schema: "automation-provenance/v1", kind: "control", nonce: 42 },
    { schema: "automation-provenance/v1", kind: "control", nonce: "x".repeat(1024) },
    { schema: "automation-provenance/v2", kind: "control" },
  ];

  cases.forEach((marker, index) => {
    const candidate = part(`ordinary-${index}`, marker);
    assert.equal(isAutomationControlPart(candidate), false, `case ${index}`);
    assert.equal(partIsExcludedFromEvidence(candidate), false, `case ${index}`);
  });
});

test("recognition is total for malformed values and serialization failures", () => {
  const circular = automation("control");
  circular.circular = circular;
  const throwing = { metadata: { get automation() { throw new Error("unreadable"); } } };
  const values = [null, undefined, "text", [], {}, { metadata: null }, part("cycle", circular), throwing];

  for (const value of values) {
    assert.doesNotThrow(() => isAutomationControlPart(value));
    assert.equal(isAutomationControlPart(value), false);
  }
});

test("host ignored and display-only markers compose with envelope recognition", () => {
  const values = [
    { type: "text", text: "ignored", ignored: true },
    { type: "text", text: "ignored metadata", metadata: { ignored: true } },
    { type: "text", text: "display", display: true },
    { type: "text", text: "display only", displayOnly: true },
    { type: "text", text: "display metadata", metadata: { displayOnly: true } },
    { type: "text", text: "display kind", metadata: { kind: "display" } },
    { type: "text", text: "bad envelope but ignored", ignored: true, metadata: { automation: { schema: 1 } } },
  ];

  values.forEach((value) => assert.equal(partIsExcludedFromEvidence(value), true));
  assert.equal(partIsExcludedFromEvidence({ ignored: "true", displayOnly: 1 }), false);
});

test("repeated anonymous automation content cannot create receipts while ordinary outcomes remain", () => {
  const controlMessages = Array.from({ length: 20 }, (_, index) => ({
    role: "user",
    commandName: "/repeat-control",
    parts: [part("/repeat-control", automation("control", { nonce: `n-${index}` }))],
  }));
  const ordinary = [
    { role: "user", commandName: "/verify", parts: [{ type: "text", text: "/verify" }] },
    { role: "tool", toolName: "check", toolError: "E_RETRY", parts: [{ type: "tool", state: { status: "error", error: "E_RETRY" } }] },
    { role: "user", commandName: "/verify", parts: [{ type: "text", text: "/verify" }] },
    { role: "tool", toolName: "check", toolError: "E_RETRY", parts: [{ type: "tool", state: { status: "error", error: "E_RETRY" } }] },
  ];
  const output = receipts([...controlMessages, ...ordinary]);

  assert.deepEqual(new Set(output.map((item) => item.receiptType)), new Set(["repeated-command", "repeated-tool-error"]));
  assert.equal(output.every((item) => item.occurrences === 2), true);
  const serialized = JSON.stringify(output);
  assert.doesNotMatch(serialized, /repeat-control|E_RETRY|\/verify|n-\d/u);
  assert.equal(output.every((item) => /^[a-f0-9]{64}$/u.test(item.signatureHash)), true);
});

test("pipeline normalization excludes control parts before records and eligibility", async () => {
  const records = [];
  const store = {
    getAutomationState() {
      return { ok: true, enabled: true, stamp: { generation: 1, permissionsHash: "f".repeat(64) } };
    },
    compareAutomationStamp(stamp) { return stamp?.generation === 1; },
    appendRecord(record) {
      records.push(record);
      return { ok: true, record };
    },
    readRecords(kind) {
      return records.filter((record) => record.kind === kind);
    },
    close() {},
  };
  const privacy = {
    scrubExcerpt({ text }) { return { ok: true, redacted: text }; },
    scanForForbiddenContent() { return { issues: [] }; },
    scrubObservation(value) { return { ok: true, sanitized: value }; },
    isObservationEligible() { return true; },
  };
  const pipeline = createPipeline({
    store,
    inventory: {},
    privacy,
    synthesis: {
      runGlobalSynthesis() { throw new Error("control evidence reached synthesis"); },
    },
    applier: { close() {} },
    commands: {},
    schemas: schemasModule,
    observation: observationModule,
    now: () => NOW,
  });
  const control = part("/authorize-control", automation("control", { producer: "anonymous-automation" }));
  const messages = [
    ...Array.from({ length: 8 }, (_, index) => ({ id: `control-${index}`, role: "user", parts: [{ ...control, metadata: { automation: { ...control.metadata.automation, nonce: String(index) } } }] })),
    { id: "ordinary-1", role: "user", parts: [{ type: "text", text: "/verify" }] },
    { id: "ordinary-2", role: "user", parts: [{ type: "text", text: "/verify" }] },
  ];

  const result = await pipeline.runEvolutionCycle({
    ctx: { client: { session: { messages: async () => ({ data: messages }) } } },
    sessionID: "raw-session-id",
    projectFingerprint: FINGERPRINT,
    scopeFingerprint: SCOPE,
    trigger: "test",
    mode: "auto",
    options: { automationStamp: store.getAutomationState().stamp },
  });

  assert.equal(result.result, "no-eligible");
  const persistedReceipts = store.readRecords("receipt").map((record) => record.payload);
  assert.equal(persistedReceipts.length, 1);
  assert.equal(persistedReceipts[0].receiptType, "repeated-command");
  assert.equal(persistedReceipts[0].occurrences, 2);
  const persisted = JSON.stringify(records);
  assert.doesNotMatch(persisted, /authorize-control|raw-session-id|control-\d|ordinary-\d|\/verify/u);
  assert.equal(persistedReceipts.every((item) => /^[a-f0-9]{64}$/u.test(item.signatureHash)), true);
  pipeline.close();
});
