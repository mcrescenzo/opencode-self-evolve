import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";

const originalReadFileSync = fs.readFileSync;
const originalOpenSync = fs.openSync;
let activeIo = null;

function instrumentedReadFileSync(filePath, ...args) {
  if (activeIo) {
    const basename = path.basename(String(filePath));
    activeIo.reads[basename] = (activeIo.reads[basename] ?? 0) + 1;
  }
  return originalReadFileSync.call(this, filePath, ...args);
}

function instrumentedOpenSync(filePath, ...args) {
  const descriptor = originalOpenSync.call(this, filePath, ...args);
  if (activeIo && path.basename(String(filePath)) === ".self-evolve-mutation.lock") activeIo.lockAcquisitions += 1;
  return descriptor;
}

if (process.versions.bun) {
  const { mock } = await import("bun:test");
  const mockedFs = {
    ...fs,
    readFileSync: instrumentedReadFileSync,
    openSync: instrumentedOpenSync,
  };
  mock.module("node:fs", () => ({ ...mockedFs, default: mockedFs }));
} else {
  fs.readFileSync = instrumentedReadFileSync;
  fs.openSync = instrumentedOpenSync;
  syncBuiltinESMExports();
}

const [
  storeModule,
  schemas,
  integrationModule,
  schedulerModule,
  commandModule,
] = await Promise.all([
  import("../self-evolve-store.js"),
  import("../self-evolve-schemas.js"),
  import("../self-evolve-integration.js"),
  import("../self-evolve-scheduler.js"),
  import("../self-evolve-commands.js"),
]);

const { openStore } = storeModule;
const { createIntegration } = integrationModule;
const { createScheduler } = schedulerModule;
const PROJECT = "a".repeat(64);
const DEFAULT_RECORDS = 3_460;
const ITERATIONS = 40;
const TICK_MS = 500;
const POST_FIX_RECORDS_PER_DAY = 11.6;

function parseArgs(argv) {
  const options = {
    json: false,
    verify: false,
    scaling: false,
    auditRecords: DEFAULT_RECORDS,
    source: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") options.json = true;
    else if (value === "--verify") options.verify = true;
    else if (value === "--scaling") options.scaling = true;
    else if (value === "--audit-records") options.auditRecords = Number(argv[++index]);
    else if (value === "--source") options.source = path.resolve(argv[++index]);
    else throw new Error(`unknown-benchmark-option:${value}`);
  }
  if (!Number.isSafeInteger(options.auditRecords) || options.auditRecords < 1 || options.auditRecords > 100_000) {
    throw new Error("invalid-audit-record-count");
  }
  if (options.verify) options.scaling = true;
  return options;
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function busyAuditRecord(index, timestamp) {
  const sessionIDHash = hash(`benchmark-session:${index}`);
  const details = { action: "session-status", sessionIDHash, status: "busy", epoch: index };
  const payload = schemas.makeAuditEvent({
    id: hash(`benchmark-audit:${index}`),
    kind: "decision",
    actor: "self-evolve-scheduler",
    timestamp,
    payloadHash: hash(JSON.stringify(details)),
    details,
  });
  return schemas.wrapRecord("audit-event", payload, timestamp);
}

function lineCount(source) {
  return source.trim() ? source.trimEnd().split("\n").length : 0;
}

function progress(message, jsonMode) {
  if (!jsonMode) process.stderr.write(`${message}\n`);
}

function generateFixture(root, {
  auditRecords = DEFAULT_RECORDS,
  checkpoints = [auditRecords],
  jsonMode = false,
} = {}) {
  const allCheckpoints = [...new Set([...checkpoints, auditRecords])].sort((left, right) => left - right);
  const maximum = allCheckpoints.at(-1);
  const timestamp = Date.now() - 60_000;
  const store = openStore(root, {
    projectName: "store-performance-benchmark",
    projectFingerprint: PROJECT,
    now: () => timestamp + maximum + 1,
  });
  const auditPath = path.join(store.stateDir, "audit.jsonl");
  const cachedSources = new Map();
  const startedAt = process.hrtime.bigint();
  for (let index = 1; index <= maximum; index += 1) {
    const appended = store.appendRecord(busyAuditRecord(index, timestamp + index));
    if (!appended.ok) throw new Error(`fixture-append-failed:${index}:${appended.reason}`);
    if (allCheckpoints.includes(index)) {
      const cachePath = path.join(path.dirname(root), `fixture-audit-${index}.jsonl`);
      fs.copyFileSync(auditPath, cachePath);
      cachedSources.set(index, cachePath);
    }
    if (index % 500 === 0 || index === maximum) progress(`fixture ${index}/${maximum}`, jsonMode);
  }
  const closed = store.close();
  if (!closed.ok) throw new Error(`fixture-close-failed:${JSON.stringify(closed)}`);
  if (maximum !== auditRecords) fs.copyFileSync(cachedSources.get(auditRecords), auditPath);
  const source = fs.readFileSync(auditPath, "utf8");
  return {
    root,
    projectFingerprint: PROJECT,
    auditPath,
    auditRecords: lineCount(source),
    auditBytes: Buffer.byteLength(source),
    generationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
    cachedSources,
  };
}

function copyExternalPartition(sourcePath, destinationRoot) {
  const sourceStat = fs.statSync(sourcePath);
  const partitionDir = sourceStat.isDirectory() ? sourcePath : path.dirname(sourcePath);
  const projectFingerprint = path.basename(partitionDir);
  if (!/^[a-f0-9]{64}$/u.test(projectFingerprint)) throw new Error("source-partition-fingerprint-required");
  const selfEvolveDir = path.dirname(partitionDir);
  const destinationBase = path.join(destinationRoot, "self-evolve");
  fs.mkdirSync(destinationBase, { recursive: true, mode: 0o700 });
  fs.cpSync(partitionDir, path.join(destinationBase, projectFingerprint), {
    recursive: true,
    preserveTimestamps: true,
  });
  const globalSource = path.join(selfEvolveDir, "global");
  if (fs.existsSync(globalSource)) {
    fs.cpSync(globalSource, path.join(destinationBase, "global"), {
      recursive: true,
      preserveTimestamps: true,
    });
  }
  const versionSource = path.join(selfEvolveDir, "version.json");
  if (fs.existsSync(versionSource)) fs.copyFileSync(versionSource, path.join(destinationBase, "version.json"));
  const auditPath = path.join(destinationBase, projectFingerprint, "audit.jsonl");
  const auditSource = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8") : "";
  return {
    root: destinationRoot,
    projectFingerprint,
    auditPath,
    auditRecords: lineCount(auditSource),
    auditBytes: Buffer.byteLength(auditSource),
    generationMs: 0,
    cachedSources: new Map(),
    copiedFrom: sourcePath,
  };
}

function cloneFixture(sourceRoot, destinationRoot) {
  fs.mkdirSync(path.dirname(destinationRoot), { recursive: true, mode: 0o700 });
  fs.cpSync(sourceRoot, destinationRoot, { recursive: true, preserveTimestamps: true });
  return destinationRoot;
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    minMs: sorted[0],
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

function medianCounts(samples, field) {
  const keys = new Set(samples.flatMap((sample) => Object.keys(sample[field])));
  return Object.fromEntries([...keys].sort().map((key) => [
    key,
    percentile(samples.map((sample) => sample[field][key] ?? 0).sort((left, right) => left - right), 0.5),
  ]));
}

async function measureIterations(label, callback, iterations = ITERATIONS) {
  const durations = [];
  const ioSamples = [];
  for (let index = 0; index < iterations; index += 1) {
    activeIo = { reads: {}, lockAcquisitions: 0 };
    const startedAt = process.hrtime.bigint();
    await callback(index);
    const duration = Number(process.hrtime.bigint() - startedAt) / 1e6;
    durations.push(duration);
    ioSamples.push({
      reads: activeIo.reads,
      lockAcquisitions: activeIo.lockAcquisitions,
    });
    activeIo = null;
  }
  const timing = summarize(durations);
  const lockAcquisitions = percentile(
    ioSamples.map((sample) => sample.lockAcquisitions).sort((left, right) => left - right),
    0.5,
  );
  return {
    label,
    iterations,
    ...timing,
    dutyCycle: timing.medianMs / TICK_MS,
    reads: medianCounts(ioSamples, "reads"),
    lockAcquisitions,
  };
}

function createRuntime(root, projectFingerprint, store) {
  const privacy = {
    exportScope: () => ({ projectFingerprint, records: [] }),
    purgeScope: () => ({ ok: true, counts: {} }),
    scanForForbiddenContent: () => ({ ok: true, issues: [] }),
  };
  const applier = {
    circuitBreakerOpen: () => false,
    recoverPending: () => [],
    close: () => ({ ok: true }),
  };
  const pipeline = {
    createPipeline() {
      return {
        recoverSynthesisAttempts: () => [],
        readProposalContent: () => "",
        runEvolutionCycle: async () => ({ result: "observed-shadow" }),
        runApprovalFlow: async () => ({ result: "failed-closed", reason: "benchmark-no-apply" }),
        runRollbackFlow: async () => ({ result: "failed-closed", reason: "benchmark-no-rollback" }),
      };
    },
  };
  const fakeTimer = { unref() {} };
  return createIntegration({
    store,
    inventory: {},
    privacy,
    synthesisModule: {},
    applier,
    commands: commandModule,
    pipeline,
    scheduler: { createScheduler },
    schemas,
    observation: {},
    options: {
      stateRoot: root,
      projectFingerprint,
      hostSupported: true,
      hostVersion: "1.18.3",
      budgets: { idleDebounceMs: 60_000 },
      ctx: { client: { tui: { publish() {} } }, directory: root },
      __testSetInterval: () => fakeTimer,
      __testClearInterval: () => {},
      __testSetMailboxInterval: () => fakeTimer,
      __testClearMailboxInterval: () => {},
    },
    now: () => Date.now(),
  });
}

async function measureConfiguration(seedRoot, projectFingerprint, workspace, name, { drain }) {
  const idleRoot = cloneFixture(seedRoot, path.join(workspace, `${name}-idle`));
  let retained = null;
  if (drain) {
    const drainStore = openStore(idleRoot, {
      projectName: "benchmark-drain",
      projectFingerprint,
      now: () => Date.now(),
    });
    retained = drainStore.retain(Date.now());
    const closed = drainStore.close();
    if (!closed.ok) throw new Error(`drain-close-failed:${JSON.stringify(closed)}`);
  }
  const auditPath = path.join(idleRoot, "self-evolve", projectFingerprint, "audit.jsonl");
  const auditBytes = fs.existsSync(auditPath) ? fs.statSync(auditPath).size : 0;
  const store = openStore(idleRoot, {
    projectName: `benchmark-${name}`,
    projectFingerprint,
    now: () => Date.now(),
  });
  const runtime = createRuntime(idleRoot, projectFingerprint, store);
  await runtime.processMailbox();
  const idlePass = await measureIterations(`${name}:idle-pass`, () => runtime.processMailbox());
  const lifecycleEvent = await measureIterations(`${name}:lifecycle-event`, (index) => runtime.handleEvent({
    type: "session.idle",
    properties: {
      sessionID: `${name}-benchmark-${index}`,
      projectFingerprint,
      timestamp: Date.now(),
    },
  }));
  const shutdown = await runtime.shutdown();
  if (!shutdown.ok) throw new Error(`benchmark-shutdown-failed:${JSON.stringify(shutdown)}`);

  const bootRoot = cloneFixture(seedRoot, path.join(workspace, `${name}-boot`));
  if (drain) {
    const drainStore = openStore(bootRoot, {
      projectName: "benchmark-boot-drain",
      projectFingerprint,
      now: () => Date.now(),
    });
    drainStore.retain(Date.now());
    drainStore.close();
  }
  let bootRuntime;
  const boot = await measureIterations(`${name}:boot`, async () => {
    const bootStore = openStore(bootRoot, {
      projectName: `benchmark-${name}-boot`,
      projectFingerprint,
      now: () => Date.now(),
    });
    bootRuntime = createRuntime(bootRoot, projectFingerprint, bootStore);
    const result = await bootRuntime.boot({
      hostVersion: "1.18.3",
      hostVersionSource: "global-health",
      recoverHostSessions: false,
    });
    if (!result.ok) throw new Error(`benchmark-boot-failed:${result.health?.lastError ?? "unknown"}`);
  }, 1);
  const bootShutdown = await bootRuntime.shutdown();
  if (!bootShutdown.ok) throw new Error(`benchmark-boot-shutdown-failed:${JSON.stringify(bootShutdown)}`);

  return {
    name,
    drained: drain,
    retained,
    auditBytes,
    idlePass,
    lifecycleEvent,
    boot,
  };
}

async function measureScaling(baseFixture, checkpoints, workspace) {
  const measurements = [];
  for (const count of checkpoints) {
    const root = cloneFixture(baseFixture.root, path.join(workspace, `scale-${count}`));
    const auditPath = path.join(root, "self-evolve", baseFixture.projectFingerprint, "audit.jsonl");
    fs.copyFileSync(baseFixture.cachedSources.get(count), auditPath);
    const store = openStore(root, {
      projectName: `benchmark-scale-${count}`,
      projectFingerprint: baseFixture.projectFingerprint,
      now: () => Date.now(),
    });
    const runtime = createRuntime(root, baseFixture.projectFingerprint, store);
    await runtime.processMailbox();
    const phase = await measureIterations(`scale-${count}:idle-pass`, () => runtime.processMailbox(), 20);
    await runtime.shutdown();
    measurements.push({ records: count, medianMs: phase.medianMs, p95Ms: phase.p95Ms });
  }
  const first = measurements[0];
  const last = measurements.at(-1);
  const msPerRecord = (last.medianMs - first.medianMs) / (last.records - first.records);
  return {
    measurements,
    msPerThousandRecords: msPerRecord * 1_000,
    msPerDay: msPerRecord * POST_FIX_RECORDS_PER_DAY,
    assumedPostFixRecordsPerDay: POST_FIX_RECORDS_PER_DAY,
  };
}

function thresholdReport(preDrain, postDrain, scaling) {
  const checks = {
    postDrainDutyCycle: { value: postDrain.idlePass.dutyCycle, limit: 0.05 },
    preDrainDutyCycle: { value: preDrain.idlePass.dutyCycle, limit: 0.15 },
    postDrainAuditBytes: { value: postDrain.auditBytes, limit: 100_000 },
    preDrainLockAcquisitions: { value: preDrain.idlePass.lockAcquisitions, limit: 4 },
    postDrainLockAcquisitions: { value: postDrain.idlePass.lockAcquisitions, limit: 4 },
    preDrainBootMs: { value: preDrain.boot.medianMs, limit: 200 },
    postDrainBootMs: { value: postDrain.boot.medianMs, limit: 200 },
    growthSlopeMsPerDay: { value: scaling?.msPerDay ?? null, limit: 2 },
  };
  for (const check of Object.values(checks)) {
    check.skipped = check.value === null;
    check.passed = check.skipped || check.value <= check.limit;
  }
  return { passed: Object.values(checks).every((check) => check.passed), checks };
}

function rounded(value) {
  return typeof value === "number" ? Number(value.toFixed(4)) : value;
}

function printable(value) {
  if (Array.isArray(value)) return value.map(printable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, printable(item)]));
  }
  return rounded(value);
}

function printHuman(report) {
  console.log(`Runtime: ${report.runtime}`);
  console.log(`Fixture: ${report.fixture.auditRecords} audit records, ${report.fixture.auditBytes} bytes, generated in ${report.fixture.generationMs.toFixed(1)} ms`);
  console.log("configuration  phase             median ms  p95 ms  duty    locks");
  for (const configuration of [report.preDrain, report.postDrain]) {
    for (const phase of [configuration.idlePass, configuration.lifecycleEvent, configuration.boot]) {
      console.log([
        configuration.name.padEnd(14),
        phase.label.split(":").at(-1).padEnd(17),
        phase.medianMs.toFixed(3).padStart(9),
        phase.p95Ms.toFixed(3).padStart(7),
        `${(phase.dutyCycle * 100).toFixed(2)}%`.padStart(7),
        String(phase.lockAcquisitions).padStart(5),
      ].join("  "));
      console.log(`  reads ${JSON.stringify(phase.reads)}`);
    }
    console.log(`  audit bytes ${configuration.auditBytes}`);
  }
  if (report.scaling) {
    console.log(`Growth slope: ${report.scaling.msPerThousandRecords.toFixed(4)} ms/1000 records; ${report.scaling.msPerDay.toFixed(4)} ms/day`);
  }
  console.log(`Thresholds: ${report.thresholds.passed ? "PASS" : "FAIL"}`);
}

const options = parseArgs(process.argv.slice(2));
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-bench-"));

try {
  const fixtureRoot = path.join(temporaryRoot, "fixture");
  let fixture;
  let scalingFixture;
  const scaleCounts = [3_460, 7_000, 14_000];
  if (options.source) {
    fixture = copyExternalPartition(options.source, fixtureRoot);
    if (options.scaling) {
      scalingFixture = generateFixture(path.join(temporaryRoot, "scaling-fixture"), {
        auditRecords: scaleCounts[0],
        checkpoints: scaleCounts,
        jsonMode: options.json,
      });
    }
  } else {
    const checkpoints = options.scaling
      ? [...new Set([options.auditRecords, ...scaleCounts])]
      : [options.auditRecords];
    fixture = generateFixture(fixtureRoot, {
      auditRecords: options.auditRecords,
      checkpoints,
      jsonMode: options.json,
    });
    scalingFixture = options.scaling ? fixture : null;
  }

  const workspace = path.join(temporaryRoot, "runs");
  const preDrain = await measureConfiguration(fixture.root, fixture.projectFingerprint, workspace, "pre-drain", { drain: false });
  const postDrain = await measureConfiguration(fixture.root, fixture.projectFingerprint, workspace, "post-drain", { drain: true });
  const scaling = options.scaling
    ? await measureScaling(scalingFixture, scaleCounts, path.join(temporaryRoot, "scaling-runs"))
    : null;
  const thresholds = thresholdReport(preDrain, postDrain, scaling);
  const report = printable({
    runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`,
    fixture: {
      auditRecords: fixture.auditRecords,
      auditBytes: fixture.auditBytes,
      generationMs: fixture.generationMs,
      copiedFrom: fixture.copiedFrom ?? null,
    },
    preDrain,
    postDrain,
    scaling,
    thresholds,
  });
  if (options.json) console.log(JSON.stringify(report));
  else printHuman(report);
  if (options.verify && !thresholds.passed) process.exitCode = 1;
} finally {
  activeIo = null;
  if (!process.versions.bun) {
    fs.readFileSync = originalReadFileSync;
    fs.openSync = originalOpenSync;
    syncBuiltinESMExports();
  }
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
