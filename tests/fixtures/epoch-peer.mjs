// Child-process fixture for root-global epoch two-process tests. Each invocation
// opens a store on the shared state root, performs one bounded operation, and
// writes the result to a result file. The parent process coordinates timing via
// barrier files. Used to verify that every process sharing a state root respects
// the durable terminal epoch.

import { writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { openStore } from "../../self-evolve-store.js";
import { hashContent } from "../../self-evolve-store.js";
import { wrapRecord, makeObservation } from "../../self-evolve-schemas.js";

const [root, projectFingerprint, operation, resultPath, ...rest] = process.argv.slice(2);
const now = 10_000;

function writeResult(value) {
  writeFileSync(resultPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

function waitForBarrier(barrier) {
  if (!barrier) return;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (existsSync(barrier)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

if (operation === "read-terminal") {
  try {
    const store = openStore(root, { projectFingerprint, now: () => now });
    writeResult({ terminal: store.isTerminal(), reason: store.rootEpochTerminalReason?.() ?? null });
    store.close();
  } catch (error) {
    writeResult({ ok: false, reason: error?.message ?? String(error) });
  }
  process.exit(0);
}

if (operation === "try-mutate") {
  try {
    const store = openStore(root, { projectFingerprint, now: () => now });
    const observation = makeObservation({
      id: hashContent(`peer-observation:${process.pid}:${Date.now()}`),
      projectFingerprint,
      receiptIds: [hashContent("peer-receipt")],
      structuredFields: { receiptType: "repeated-command", scopeFingerprint: hashContent("scope"), occurrences: 1 },
      incidentId: `peer-incident-${process.pid}`,
      createdAt: now,
      injectionFlagged: false,
      redacted: true,
    });
    const result = store.appendRecord(wrapRecord("observation", observation, now));
    writeResult({ ok: result?.ok === true, reason: result?.ok === true ? null : result?.reason });
    store.close();
  } catch (error) {
    writeResult({ ok: false, reason: error?.message ?? String(error) });
  }
  process.exit(0);
}

if (operation === "try-read-settings") {
  try {
    const store = openStore(root, { projectFingerprint, now: () => now });
    const settings = store.getSettings();
    writeResult({ ok: true, hasSettings: !!settings?.global });
    store.close();
  } catch (error) {
    writeResult({ ok: false, reason: error?.message ?? String(error) });
  }
  process.exit(0);
}

if (operation === "try-acquire-lease") {
  try {
    const store = openStore(root, { projectFingerprint, now: () => now });
    const lease = store.acquireLease("peer-lease-test", { ttlMs: 60_000, actor: "peer-test" });
    writeResult({ ok: lease?.ok === true, reason: lease?.ok === true ? null : lease?.reason, nonce: lease?.nonce });
    store.close();
  } catch (error) {
    writeResult({ ok: false, reason: error?.message ?? String(error) });
  }
  process.exit(0);
}

if (operation === "mark-terminal") {
  try {
    const store = openStore(root, { projectFingerprint, now: () => now });
    const record = store.markRootTerminal({ terminalOperationId: `peer-mark-terminal:${process.pid}` });
    writeResult({ ok: true, generation: record?.generation, terminal: record?.terminal });
    store.close();
  } catch (error) {
    writeResult({ ok: false, reason: error?.message ?? String(error) });
  }
  process.exit(0);
}

if (operation === "reinitialize") {
  const [confirmation, rootIdentityHash] = rest;
  try {
    const store = openStore(root, { projectFingerprint, now: () => now });
    const record = store.reinitializeRoot({
      confirmation,
      authentication: {
        rootIdentityHash,
        projectFingerprintHash: hashContent(projectFingerprint),
        schemaVersion: "0.3.0",
        protocolVersion: "self-evolve-root-epoch-v1",
        consentSnapshotHash: hashContent("default-consent-manual"),
        operatorAuthority: "operator",
      },
    });
    writeResult({ ok: true, generation: record?.generation, terminal: record?.terminal });
    store.close();
  } catch (error) {
    writeResult({ ok: false, reason: error?.message ?? String(error) });
  }
  process.exit(0);
}

if (operation === "wait-then-try-mutate") {
  const [barrier] = rest;
  waitForBarrier(barrier);
  try {
    const store = openStore(root, { projectFingerprint, now: () => now });
    const observation = makeObservation({
      id: hashContent(`delayed-observation:${process.pid}:${Date.now()}`),
      projectFingerprint,
      receiptIds: [hashContent("delayed-receipt")],
      structuredFields: { receiptType: "repeated-command", scopeFingerprint: hashContent("scope"), occurrences: 1 },
      incidentId: `delayed-incident-${process.pid}`,
      createdAt: now,
      injectionFlagged: false,
      redacted: true,
    });
    const result = store.appendRecord(wrapRecord("observation", observation, now));
    writeResult({ ok: result?.ok === true, reason: result?.ok === true ? null : result?.reason });
    store.close();
  } catch (error) {
    writeResult({ ok: false, reason: error?.message ?? String(error) });
  }
  process.exit(0);
}

// ----- Root-global circuit-breaker epoch operations (H5-001/H5-002) -----

if (operation === "breaker-read") {
  try {
    const store = openStore(root, { projectFingerprint, now: () => now });
    const state = store.breakerEpochState?.();
    writeResult({
      ok: true,
      tripped: state?.tripped === true,
      generation: state?.generation ?? null,
      reason: store.breakerEpochReason?.() ?? null,
      trippedAt: state?.trippedAt ?? null,
    });
    store.close();
  } catch (error) {
    writeResult({ ok: false, reason: error?.message ?? String(error) });
  }
  process.exit(0);
}

if (operation === "breaker-tripped-check") {
  try {
    const store = openStore(root, { projectFingerprint, now: () => now });
    writeResult({ ok: true, tripped: store.breakerEpochTripped?.() === true });
    store.close();
  } catch (error) {
    writeResult({ ok: false, reason: error?.message ?? String(error) });
  }
  process.exit(0);
}

if (operation === "trip-breaker") {
  try {
    const store = openStore(root, { projectFingerprint, now: () => now });
    const record = store.tripBreakerEpoch({ reason: "peer-test-trip", operationId: `peer-trip:${process.pid}` });
    writeResult({ ok: true, generation: record?.generation, tripped: record?.tripped });
    store.close();
  } catch (error) {
    writeResult({ ok: false, reason: error?.message ?? String(error) });
  }
  process.exit(0);
}

if (operation === "reset-breaker") {
  const [confirmation, rootIdentityHash] = rest;
  try {
    const store = openStore(root, { projectFingerprint, now: () => now });
    const record = store.resetBreakerEpoch({
      confirmation,
      authentication: {
        rootIdentityHash,
        projectFingerprintHash: hashContent(projectFingerprint),
        schemaVersion: "0.3.0",
        protocolVersion: "self-evolve-breaker-epoch-v1",
        operatorAuthority: "operator",
      },
    });
    writeResult({ ok: true, generation: record?.generation, tripped: record?.tripped });
    store.close();
  } catch (error) {
    writeResult({ ok: false, reason: error?.message ?? String(error) });
  }
  process.exit(0);
}

if (operation === "wait-then-trip-breaker") {
  const [barrier] = rest;
  waitForBarrier(barrier);
  try {
    const store = openStore(root, { projectFingerprint, now: () => now });
    const record = store.tripBreakerEpoch({ reason: "delayed-peer-trip", operationId: `delayed-trip:${process.pid}` });
    writeResult({ ok: true, generation: record?.generation, tripped: record?.tripped });
    store.close();
  } catch (error) {
    writeResult({ ok: false, reason: error?.message ?? String(error) });
  }
  process.exit(0);
}

writeResult({ ok: false, reason: `unknown-operation:${operation}` });
