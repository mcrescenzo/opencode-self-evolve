import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import {
  SCHEMA_VERSION,
  assertRecord,
  makeAuditEvent,
  makeGlobalSettings,
  makeRepoSettings,
  wrapRecord,
} from "./self-evolve-schemas.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const RECOVERY_WINDOW_MS = 10 * 60 * 1000;
const STORE_FILES = Object.freeze({
  observation: "observations.jsonl",
  proposal: "proposals.jsonl",
  decision: "decisions.jsonl",
  "audit-event": "audit.jsonl",
});

export function hashContent(str) {
  return createHash("sha256").update(String(str)).digest("hex");
}

function canonicalRemote(remoteUrl) {
  let value = String(remoteUrl).trim().replace(/\\/g, "/");
  const scp = value.match(/^([^/@\s]+@)?([^/:\s]+):(.+)$/);
  if (scp && !value.includes("://")) value = `ssh://${scp[1] ?? ""}${scp[2]}/${scp[3]}`;
  try {
    const url = new URL(value);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "ssh:" && url.port === "22")) url.port = "";
    url.search = "";
    url.hash = "";
    value = url.toString();
  } catch {
    // Local or host-specific Git remote syntax is still normalized below.
  }
  return value.replace(/\/+$/, "").replace(/\.git$/i, "");
}

export function projectFingerprintFor(remoteUrl, worktreePath) {
  const remote = typeof remoteUrl === "string" ? remoteUrl.trim() : "";
  const identity = remote ? canonicalRemote(remote) : path.resolve(String(worktreePath));
  return hashContent(identity);
}

function ensureDir(directory) {
  mkdirSync(directory, { recursive: true, mode: DIR_MODE });
}

function atomicWrite(filePath, contents) {
  ensureDir(path.dirname(filePath));
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  writeFileSync(temporary, contents, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
  renameSync(temporary, filePath);
}

function json(value) {
  return `${JSON.stringify(value)}\n`;
}

function reasonCode(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(":", 1)[0] || "corrupt-record";
}

export function quarantineRecord(record, reason, quarantineDir) {
  if (!quarantineDir) throw new TypeError("quarantine-directory-required");
  ensureDir(quarantineDir);
  const stamp = `${Date.now()}-${randomBytes(8).toString("hex")}`;
  const recordPath = path.join(quarantineDir, `${stamp}.quarantined`);
  let serialized;
  try {
    serialized = typeof record === "string" ? record : JSON.stringify(record);
  } catch {
    serialized = String(record);
  }
  atomicWrite(recordPath, `${serialized}\n`);
  atomicWrite(`${recordPath}.reason.json`, json({ reason: String(reason) }));
  return recordPath;
}

function compareVersions(left, right) {
  const parse = (value) => String(value).split(".").map((part) => Number(part));
  const a = parse(left);
  const b = parse(right);
  if (a.length !== 3 || b.length !== 3 || [...a, ...b].some((part) => !Number.isInteger(part) || part < 0)) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function migrate(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const comparison = compareVersions(settings.schemaVersion, SCHEMA_VERSION);
  if (comparison === null || comparison > 0) return null;
  if (comparison === 0) return settings;
  return {
    ...settings,
    schemaVersion: SCHEMA_VERSION,
    ...(settings.global ? { global: { ...settings.global, schemaVersion: SCHEMA_VERSION } } : {}),
    ...(settings.repo ? { repo: { ...settings.repo, schemaVersion: SCHEMA_VERSION } } : {}),
  };
}

function fileForKind(kind) {
  if (STORE_FILES[kind]) return STORE_FILES[kind];
  if (["apply-claim", "rollback-record", "intervention-epoch", "circuit-breaker"].includes(kind)) return STORE_FILES["audit-event"];
  return STORE_FILES.observation;
}

function logicalId(envelope) {
  return envelope.payload?.id ?? envelope.payload?.proposalId ?? envelope.id;
}

function eventState(event) {
  return event.payload?.details?.state ?? event.payload?.details?.status ?? event.payload?.details?.action;
}

export function openStore(rootDir, { projectName, projectFingerprint, now = () => Date.now() } = {}) {
  if (typeof now !== "function") throw new TypeError("now-must-be-function");
  if (!/^[a-f0-9]{64}$/.test(String(projectFingerprint))) throw new TypeError("invalid-project-fingerprint");
  const root = path.resolve(String(rootDir));
  const baseDir = path.join(root, "self-evolve");
  const stateDir = path.join(baseDir, projectFingerprint);
  const leasesDir = path.join(stateDir, "leases");
  const quarantineDir = path.join(stateDir, "quarantine");
  const snapshotsDir = path.join(stateDir, "snapshots");
  const settingsPath = path.join(stateDir, "settings.json");
  const ownedLeases = new Map();
  let closed = false;

  function ensureOpen() {
    if (closed) throw new Error("store-closed");
  }

  function initialize() {
    ensureDir(baseDir);
    ensureDir(stateDir);
    ensureDir(leasesDir);
    ensureDir(quarantineDir);
    ensureDir(snapshotsDir);
    const versionPath = path.join(baseDir, "version.json");
    if (!existsSync(versionPath)) atomicWrite(versionPath, json({ schemaVersion: SCHEMA_VERSION }));
  }

  function quarantine(record, reason) {
    return quarantineRecord(record, reason, quarantineDir);
  }

  function readFileRecords(fileName, repair = true) {
    const filePath = path.join(stateDir, fileName);
    if (!existsSync(filePath)) return [];
    const source = readFileSync(filePath, "utf8");
    const lines = source.split("\n");
    const records = [];
    let damaged = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        records.push(assertRecord(JSON.parse(line)));
      } catch (error) {
        damaged = true;
        quarantine(line, reasonCode(error));
      }
    }
    if (damaged && repair) writeRecords(fileName, records);
    return records;
  }

  function writeRecords(fileName, records) {
    atomicWrite(path.join(stateDir, fileName), records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""));
  }

  function allRecords() {
    const records = [];
    for (const fileName of new Set(Object.values(STORE_FILES))) records.push(...readFileRecords(fileName));
    return records;
  }

  function makeAudit(kind, details, proposalId, actor = "self-evolve-store") {
    const timestamp = now();
    const cleanDetails = Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined));
    const payloadHash = hashContent(JSON.stringify(cleanDetails));
    const event = makeAuditEvent({
      id: hashContent(JSON.stringify({ kind, details: cleanDetails, proposalId, actor, timestamp, nonce: randomBytes(8).toString("hex") })),
      kind,
      ...(proposalId === undefined ? {} : { proposalId }),
      actor,
      timestamp,
      payloadHash,
      details: cleanDetails,
    });
    return wrapRecord("audit-event", event, timestamp);
  }

  function appendValid(envelope, { ignoreQuota = false } = {}) {
    const clean = assertRecord(envelope);
    const fileName = fileForKind(clean.kind);
    const records = readFileRecords(fileName);
    if (records.some((record) => record.id === clean.id)) return { ok: true, duplicate: true, record: clean };
    const next = [...records, clean];
    if (!ignoreQuota) {
      const quotaMiB = getSettings().repo.budgets.storageQuotaMiB ?? getSettings().global.budgets.storageQuotaMiB;
      const projected = Buffer.byteLength(next.map((record) => JSON.stringify(record)).join("\n"), "utf8");
      if (projected > quotaMiB * 1024 * 1024) return { ok: false, reason: "storage-quota-exceeded" };
    }
    writeRecords(fileName, next);
    return { ok: true, duplicate: false, record: clean };
  }

  function appendAudit(kind, details, proposalId, actor) {
    return appendValid(makeAudit(kind, details, proposalId, actor), { ignoreQuota: true });
  }

  function defaultSettings() {
    const timestamp = now();
    return {
      schemaVersion: SCHEMA_VERSION,
      projectName: String(projectName ?? ""),
      global: makeGlobalSettings({ createdAt: timestamp, updatedAt: timestamp }),
      repo: makeRepoSettings({ projectFingerprint }),
    };
  }

  function loadSettings() {
    ensureOpen();
    if (!existsSync(settingsPath)) {
      const defaults = defaultSettings();
      atomicWrite(settingsPath, json(defaults));
      return defaults;
    }
    try {
      const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
      const migrated = migrate(raw);
      if (!migrated) {
        appendAudit("corruption", { action: "settings-version", version: String(raw?.schemaVersion ?? "missing") });
        return null;
      }
      const clean = {
        schemaVersion: SCHEMA_VERSION,
        projectName: String(migrated.projectName ?? projectName ?? ""),
        global: makeGlobalSettings(migrated.global),
        repo: makeRepoSettings(migrated.repo),
      };
      if (raw.schemaVersion !== SCHEMA_VERSION) atomicWrite(settingsPath, json(clean));
      return clean;
    } catch (error) {
      quarantine(readFileSync(settingsPath, "utf8"), reasonCode(error));
      appendAudit("corruption", { action: "settings-corrupt", reason: reasonCode(error) });
      return null;
    }
  }

  function getSettings() {
    const settings = loadSettings();
    if (!settings) throw new Error("corrupt-settings");
    return { global: settings.global, repo: settings.repo };
  }

  function setSettings(scope, value) {
    ensureOpen();
    const current = loadSettings();
    if (!current) return { ok: false, reason: "corrupt-settings" };
    const clean = scope === "global" ? makeGlobalSettings(value) : makeRepoSettings(value);
    const next = { ...current, [scope]: clean };
    atomicWrite(settingsPath, json(next));
    appendAudit("mode-change", { action: `${scope}-settings`, mode: clean.mode });
    return clean;
  }

  function appendRecord(envelope) {
    ensureOpen();
    try {
      return appendValid(envelope);
    } catch (error) {
      quarantine(envelope, reasonCode(error));
      return { ok: false, reason: reasonCode(error) };
    }
  }

  function readRecords(kind, { since, limit } = {}) {
    ensureOpen();
    const boundedLimit = limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.trunc(limit));
    return readFileRecords(fileForKind(kind))
      .filter((record) => record.kind === kind && (since === undefined || record.createdAt >= since))
      .slice(0, boundedLimit);
  }

  function getRecord(kind, id) {
    const records = readRecords(kind);
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (records[index].id === id || logicalId(records[index]) === id) return records[index];
    }
    return null;
  }

  function leasePath(leaseKey) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(leaseKey))) throw new TypeError("invalid-lease-key");
    return path.join(leasesDir, `${leaseKey}.lock`);
  }

  function readLease(leaseKey) {
    try {
      return JSON.parse(readFileSync(leasePath(leaseKey), "utf8"));
    } catch {
      return null;
    }
  }

  function acquireLease(leaseKey, { ttlMs, actor }) {
    ensureOpen();
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) return { ok: false, reason: "invalid-ttl" };
    const filePath = leasePath(leaseKey);
    const acquiredAt = now();
    const nonce = randomBytes(24).toString("hex");
    const lease = { actor: String(actor), acquiredAt, expiresAt: acquiredAt + ttlMs, nonce };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let descriptor;
      try {
        descriptor = openSync(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, FILE_MODE);
        writeFileSync(descriptor, json(lease), "utf8");
        closeSync(descriptor);
        ownedLeases.set(leaseKey, nonce);
        return { ok: true, nonce, expiresAt: lease.expiresAt };
      } catch (error) {
        if (descriptor !== undefined) closeSync(descriptor);
        if (error?.code !== "EEXIST") return { ok: false, reason: "lease-error" };
        const current = readLease(leaseKey);
        if (current && current.expiresAt <= acquiredAt) {
          try { unlinkSync(filePath); } catch (unlinkError) { if (unlinkError?.code !== "ENOENT") break; }
          continue;
        }
        return { ok: false, reason: "lease-busy", currentOwner: current?.actor ?? null };
      }
    }
    return { ok: false, reason: "lease-busy", currentOwner: readLease(leaseKey)?.actor ?? null };
  }

  function releaseLease(leaseKey, nonce) {
    ensureOpen();
    const current = readLease(leaseKey);
    if (!current) return { ok: false, reason: "lease-not-found" };
    if (current.nonce !== nonce) return { ok: false, reason: "nonce-mismatch" };
    try { unlinkSync(leasePath(leaseKey)); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    ownedLeases.delete(leaseKey);
    return { ok: true };
  }

  function isLeaseHeld(leaseKey, nowMs = now()) {
    ensureOpen();
    const current = readLease(leaseKey);
    if (!current) return false;
    if (current.expiresAt > nowMs) return true;
    try { unlinkSync(leasePath(leaseKey)); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    ownedLeases.delete(leaseKey);
    return false;
  }

  function runCas(kind, id, expectedPriorState, mutateFn) {
    ensureOpen();
    const current = getRecord(kind, id);
    if (!current) return { ok: false, reason: "record-not-found" };
    if (current.payload?.state !== expectedPriorState) return { ok: false, reason: "stale-prior-state" };
    try {
      const mutation = mutateFn(current.payload);
      const next = mutation?.schemaVersion && mutation?.kind ? assertRecord(mutation) : wrapRecord(kind, mutation, now());
      const result = appendValid(next);
      if (!result.ok) return result;
      appendAudit("decision", { action: "cas", priorState: String(expectedPriorState), newState: String(next.payload?.state ?? "") }, logicalId(current));
      return { ok: true, newRecord: next };
    } catch (error) {
      return { ok: false, reason: reasonCode(error) };
    }
  }

  function retain(nowMs = now()) {
    ensureOpen();
    const cutoff = nowMs - getSettings().global.retentionDays * 86_400_000;
    const records = readFileRecords(STORE_FILES.observation);
    const kept = records.filter((record) => record.kind !== "observation" || record.payload.createdAt >= cutoff);
    writeRecords(STORE_FILES.observation, kept);
    return { observations: records.length - kept.length };
  }

  function exportAll() {
    ensureOpen();
    return {
      schemaVersion: SCHEMA_VERSION,
      projectName: String(projectName ?? ""),
      projectFingerprint,
      settings: getSettings(),
      records: allRecords(),
    };
  }

  function countKinds(records) {
    const counts = { observations: 0, proposals: 0, decisions: 0, audit: 0 };
    for (const record of records) {
      if (record.kind === "observation") counts.observations += 1;
      else if (record.kind === "proposal") counts.proposals += 1;
      else if (record.kind === "decision") counts.decisions += 1;
      else counts.audit += 1;
    }
    return counts;
  }

  function purge({ scope }) {
    ensureOpen();
    if (!new Set(["observations", "proposals", "project", "all"]).has(scope)) return { ok: false, reason: "invalid-scope" };
    const before = allRecords();
    let removed = [];
    if (scope === "observations") {
      const records = readFileRecords(STORE_FILES.observation);
      removed = records.filter((record) => record.kind === "observation");
      writeRecords(STORE_FILES.observation, records.filter((record) => record.kind !== "observation"));
    } else if (scope === "proposals") {
      const records = readFileRecords(STORE_FILES.proposal);
      removed = records.filter((record) => record.kind === "proposal" && record.payload.state === "pending");
      writeRecords(STORE_FILES.proposal, records.filter((record) => !removed.includes(record)));
    } else if (scope === "project") {
      removed = before;
      rmSync(stateDir, { recursive: true, force: true });
      initialize();
    } else {
      removed = before;
      rmSync(baseDir, { recursive: true, force: true });
      ownedLeases.clear();
      return { ok: true, counts: countKinds(removed) };
    }
    const counts = countKinds(removed);
    appendAudit("purge", { action: scope, removed: removed.length });
    return { ok: true, counts };
  }

  function getRecoveryPending() {
    ensureOpen();
    const audit = readRecords("audit-event").sort((a, b) => a.createdAt - b.createdAt);
    return audit.filter((event, index) => {
      if (event.payload.kind !== "apply" || eventState(event) !== "applied") return false;
      return !audit.slice(index + 1).some((candidate) =>
        candidate.payload.proposalId === event.payload.proposalId
        && candidate.createdAt >= event.createdAt
        && candidate.createdAt - event.createdAt <= RECOVERY_WINDOW_MS
        && eventState(candidate) === "readback-verified");
    });
  }

  function close() {
    if (closed) return;
    for (const [leaseKey, nonce] of ownedLeases) {
      const current = readLease(leaseKey);
      if (current?.nonce === nonce) {
        try { unlinkSync(leasePath(leaseKey)); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      }
    }
    ownedLeases.clear();
    closed = true;
  }

  initialize();
  for (const fileName of new Set(Object.values(STORE_FILES))) readFileRecords(fileName);
  loadSettings();

  return Object.freeze({
    getSettings,
    setGlobalSettings: (settings) => setSettings("global", settings),
    setRepoSettings: (settings) => setSettings("repo", settings),
    appendRecord,
    readRecords,
    getRecord,
    acquireLease,
    releaseLease,
    isLeaseHeld,
    runCas,
    retain,
    exportAll,
    purge,
    getRecoveryPending,
    close,
    // Read-only path getters for cross-module coordination. Snapshots live
    // under the project state subtree so privacy.purgeScope("project"|"all")
    // removes them along with the rest of the project's records.
    get snapshotRoot() {
      return snapshotsDir;
    },
    get stateDir() {
      return stateDir;
    },
  });
}
