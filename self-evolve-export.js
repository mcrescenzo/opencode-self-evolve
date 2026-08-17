import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { assertGlobalIdentitySafe, errorReasonCode } from "./self-evolve-schemas.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const DEFAULT_TEMP_QUOTA_BYTES = 128 * 1024 * 1024;
const HASH_RE = /^[a-f0-9]{64}$/u;
const NONCE_RE = /^[a-f0-9]{32}$/u;
const OWNED_TEMP_RE = /^\.([0-9]+)-([0-9]+)-([a-f0-9]{32})-.+\.tmp$/u;
const NOFOLLOW = Number.isInteger(constants.O_NOFOLLOW) ? constants.O_NOFOLLOW : 0;

function conservativeProcessIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function assertDirectory(directory, boundary) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory) {
    throw new Error("export-directory-rejected");
  }
  if ((stat.mode & 0o077) !== 0) throw new Error("export-directory-permissions-rejected");
  const relative = path.relative(boundary, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("export-path-escape-rejected");
}

function ensureDirectory(directory, boundary) {
  try { mkdirSync(directory, { mode: DIRECTORY_MODE }); } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  assertDirectory(directory, boundary);
}

function* encodeJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    yield JSON.stringify(value);
    return;
  }
  if (Array.isArray(value)) {
    yield "[";
    for (let index = 0; index < value.length; index += 1) {
      if (index) yield ",";
      yield* encodeJson(value[index]);
    }
    yield "]";
    return;
  }
  if (!value || typeof value !== "object") throw new TypeError("export-value-rejected");
  yield "{";
  let first = true;
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    if (!first) yield ",";
    first = false;
    yield JSON.stringify(key);
    yield ":";
    yield* encodeJson(child);
  }
  yield "}";
}

function removeFile(filePath) {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("export-artifact-rejected");
  unlinkSync(filePath);
  return 1;
}

function validateSensitiveExportArchive(scope, archive, projectFingerprint) {
  if (!archive || typeof archive !== "object" || Array.isArray(archive)) throw new Error("export-archive-rejected");
  if (archive.projectFingerprint !== undefined && archive.projectFingerprint !== projectFingerprint) {
    throw new Error("cross-project-export-forbidden");
  }
  if (archive.projects !== undefined) {
    if (!Array.isArray(archive.projects) || archive.projects.length > 1
        || archive.projects.some((project) => project?.projectFingerprint !== projectFingerprint)) {
      throw new Error("cross-project-export-forbidden");
    }
  }
  if (archive.projects !== undefined && archive.bridge !== undefined) {
    if (!Array.isArray(archive.bridge) || archive.bridge.length > 1
        || archive.bridge.some((project) => project?.projectFingerprint !== projectFingerprint)) {
      throw new Error("cross-project-export-forbidden");
    }
  }
  const projects = archive.projects ?? [archive];
  for (const project of projects) {
    if (project.capsules !== undefined && (!Array.isArray(project.capsules)
        || project.capsules.some((entry) => entry?.classification !== "sensitive-evidence-capsule"
          || !entry.capsule || typeof entry.capsule !== "object"))) {
      throw new Error("export-capsule-classification-required");
    }
    if (project.snapshots !== undefined && (!Array.isArray(project.snapshots)
        || project.snapshots.some((entry) => entry?.classification !== "sensitive-skill-snapshot"))) {
      throw new Error("export-snapshot-classification-required");
    }
  }
  if (archive.global !== undefined) {
    assertGlobalIdentitySafe(archive.global, { forbiddenIdentityValues: [projectFingerprint] });
    if (Object.hasOwn(archive.global, "capsules") || Object.hasOwn(archive.global, "capsuleIds")) {
      throw new Error("forbidden-global-identity");
    }
    if (archive.global.recommendationContent !== undefined
        && (!Array.isArray(archive.global.recommendationContent)
          || archive.global.recommendationContent.some((entry) => entry?.classification !== "sensitive-skill-content"))) {
      throw new Error("export-content-classification-required");
    }
    if (archive.global.skillSnapshots !== undefined
        && (!Array.isArray(archive.global.skillSnapshots)
          || archive.global.skillSnapshots.some((entry) => entry?.classification !== "sensitive-skill-snapshot"))) {
      throw new Error("export-snapshot-classification-required");
    }
  }
  if (scope === "all" && archive.global === undefined && archive.exportScope === "all") {
    throw new Error("export-global-member-required");
  }
  return archive;
}

export function createSensitiveExportManager({
  stateRoot,
  projectFingerprint,
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
  maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES,
  temporaryQuotaBytes = DEFAULT_TEMP_QUOTA_BYTES,
  processIsAlive = conservativeProcessIsAlive,
  faultInjection,
} = {}) {
  const boundary = path.resolve(String(stateRoot ?? ""));
  if (!HASH_RE.test(String(projectFingerprint ?? ""))) throw new TypeError("invalid-project-fingerprint");
  assertDirectory(boundary, boundary);
  const selfEvolveRoot = path.join(boundary, "self-evolve");
  ensureDirectory(selfEvolveRoot, boundary);
  const exportsRoot = path.join(selfEvolveRoot, "exports");
  ensureDirectory(exportsRoot, boundary);
  const projectRoot = path.join(exportsRoot, projectFingerprint);
  ensureDirectory(projectRoot, boundary);
  const lockPath = path.join(projectRoot, "active.lock");
  let active = false;
  let activeNonce = null;

  function readLock() {
    const stat = lstatOptional(lockPath);
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== FILE_MODE) {
      throw new Error("export-lock-rejected");
    }
    let owner;
    try { owner = JSON.parse(readFileSync(lockPath, "utf8")); } catch { return Object.freeze({ valid: false }); }
    return Object.freeze({
      valid: Number.isSafeInteger(owner?.pid) && owner.pid > 0
        && Number.isSafeInteger(owner?.issuedAt)
        && Number.isSafeInteger(owner?.expiresAt)
        && NONCE_RE.test(String(owner?.nonce ?? "")),
      pid: owner?.pid,
      issuedAt: owner?.issuedAt,
      expiresAt: owner?.expiresAt,
      nonce: owner?.nonce,
      dev: stat.dev,
      ino: stat.ino,
    });
  }

  function removeOwnedLock(expected) {
    const current = readLock();
    if (!current?.valid
        || current.pid !== expected.pid
        || current.nonce !== expected.nonce
        || (expected.dev !== undefined && (current.dev !== expected.dev || current.ino !== expected.ino))) return 0;
    unlinkSync(lockPath);
    return 1;
  }

  function cleanup(timestamp = now()) {
    let removed = 0;
    let bytes = 0;
    const lock = readLock();
    if (lock?.valid && lock.expiresAt <= timestamp && !processIsAlive(lock.pid)) {
      removed += removeOwnedLock(lock);
    }
    for (const entry of readdirSync(projectRoot, { withFileTypes: true })) {
      const filePath = path.join(projectRoot, entry.name);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("export-artifact-rejected");
      const stat = lstatSync(filePath);
      if (stat.nlink !== 1 || (stat.mode & 0o077) !== 0) throw new Error("export-artifact-rejected");
      if (entry.name === "active.lock") continue;
      const createdAt = /^\.?([0-9]+)-/u.exec(entry.name)?.[1];
      const expiresAt = createdAt && Number.isSafeInteger(Number(createdAt))
        ? Number(createdAt) + ttlMs
        : stat.mtimeMs + ttlMs;
      const temporaryOwner = OWNED_TEMP_RE.exec(entry.name);
      if (temporaryOwner) {
        const ownerPid = Number(temporaryOwner[2]);
        if (expiresAt <= timestamp && Number.isSafeInteger(ownerPid) && ownerPid > 0 && !processIsAlive(ownerPid)) {
          removed += removeFile(filePath);
        } else {
          bytes += stat.size;
        }
      } else if (entry.name.endsWith(".tmp")) {
        bytes += stat.size;
      } else if (expiresAt <= timestamp) {
        removed += removeFile(filePath);
      } else {
        bytes += stat.size;
      }
    }
    return { removed, bytes };
  }

  function acquire(timestamp) {
    if (active) throw new Error("export-job-active");
    cleanup(timestamp);
    let descriptor;
    let created = false;
    const nonce = randomBytes(16).toString("hex");
    try {
      descriptor = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, FILE_MODE);
      created = true;
      const source = Buffer.from(`${JSON.stringify({
        pid: process.pid,
        issuedAt: timestamp,
        expiresAt: timestamp + ttlMs,
        nonce,
      })}\n`, "utf8");
      // BH-6: writeSync may write fewer bytes than supplied — it does not loop the
      // way writeFileSync does. A short write leaves an unparseable lock record,
      // and the size readback below is what proves the whole record landed.
      let written = 0;
      while (written < source.length) {
        const chunk = writeSync(descriptor, source, written, source.length - written);
        if (!(chunk > 0)) throw new Error("export-lock-rejected");
        written += chunk;
      }
      faultInjection?.("export-after-lock-write", { lockPath });
      fsyncSync(descriptor);
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== FILE_MODE || stat.size !== source.length) {
        throw new Error("export-lock-rejected");
      }
      active = true;
      activeNonce = nonce;
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error("export-job-active");
      // BH-6: this lock was created by this call and never became active. Leaving
      // it behind wedges every later job: a partial record is unparseable, and
      // both removeOwnedLock and cleanup ignore a lock they cannot parse, so
      // nothing would ever reclaim it.
      if (created) {
        try { unlinkSync(lockPath); } catch { /* nothing further to reclaim */ }
      }
      throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  function release() {
    active = false;
    const nonce = activeNonce;
    activeNonce = null;
    if (!nonce) return;
    try { removeOwnedLock({ pid: process.pid, nonce }); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  function run({ scope, archive }) {
    try { validateSensitiveExportArchive(scope, archive, projectFingerprint); }
    catch (error) { return { ok: false, reason: errorReasonCode(error, "export-archive-rejected") }; }
    const timestamp = now();
    acquire(timestamp);
    const id = randomBytes(16).toString("hex");
    const temporaryPath = path.join(projectRoot, `.${timestamp}-${process.pid}-${activeNonce}-${id}.json.tmp`);
    const artifactPath = path.join(projectRoot, `${timestamp}-${id}.json`);
    let descriptor;
    let metadataDescriptor;
    let metadataPath;
    let metadataTemporaryPath;
    let published = false;
    let bytes = 0;
    const hash = createHash("sha256");
    try {
      const usage = cleanup(timestamp);
      descriptor = openSync(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, FILE_MODE);
      faultInjection?.("export-after-temporary-open", { temporaryPath });
      for (const chunk of encodeJson({
        ...archive,
        exportScope: scope,
        classification: "sensitive-self-evolve-archive",
        createdAt: timestamp,
        expiresAt: timestamp + ttlMs,
      })) {
        const buffer = Buffer.from(chunk, "utf8");
        bytes += buffer.length;
        if (bytes > maxArtifactBytes || usage.bytes + bytes > temporaryQuotaBytes) {
          throw new Error(bytes > maxArtifactBytes ? "export-size-exceeded" : "export-temporary-quota-exceeded");
        }
        writeSync(descriptor, buffer);
        hash.update(buffer);
      }
      bytes += 1;
      if (bytes > maxArtifactBytes || usage.bytes + bytes > temporaryQuotaBytes) {
        throw new Error(bytes > maxArtifactBytes ? "export-size-exceeded" : "export-temporary-quota-exceeded");
      }
      writeSync(descriptor, Buffer.from("\n"));
      hash.update("\n");
      fsyncSync(descriptor);
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== FILE_MODE || stat.size !== bytes) {
        throw new Error("export-readback-rejected");
      }
      closeSync(descriptor);
      descriptor = undefined;
      if (lstatOptional(artifactPath)) throw new Error("export-collision");
      renameSync(temporaryPath, artifactPath);
      published = true;
      faultInjection?.("export-after-publication", { artifactPath });
      const publishedStat = lstatSync(artifactPath);
      if (!publishedStat.isFile() || publishedStat.isSymbolicLink() || publishedStat.nlink !== 1
          || (publishedStat.mode & 0o777) !== FILE_MODE || publishedStat.size !== bytes) {
        throw new Error("export-publication-rejected");
      }
      const result = Object.freeze({
        ok: true,
        scope,
        path: artifactPath,
        bytes,
        sha256: hash.digest("hex"),
        expiresAt: timestamp + ttlMs,
        classification: "sensitive-self-evolve-archive",
      });
      metadataPath = `${artifactPath}.meta.json`;
      metadataTemporaryPath = path.join(projectRoot, `.${timestamp}-${process.pid}-${activeNonce}-${id}.meta.json.tmp`);
      const metadataSource = Buffer.from(`${JSON.stringify(result)}\n`, "utf8");
      if (usage.bytes + bytes + metadataSource.length > temporaryQuotaBytes) {
        throw new Error("export-temporary-quota-exceeded");
      }
      try {
        metadataDescriptor = openSync(metadataTemporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, FILE_MODE);
        writeSync(metadataDescriptor, metadataSource);
        fsyncSync(metadataDescriptor);
        closeSync(metadataDescriptor);
        metadataDescriptor = undefined;
        renameSync(metadataTemporaryPath, metadataPath);
      } finally {
        if (metadataDescriptor !== undefined) closeSync(metadataDescriptor);
        try { removeFile(metadataTemporaryPath); } catch {}
      }
      return result;
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (metadataDescriptor !== undefined) closeSync(metadataDescriptor);
      try { removeFile(published ? artifactPath : temporaryPath); } catch {}
      if (metadataTemporaryPath) try { removeFile(metadataTemporaryPath); } catch {}
      if (metadataPath) try { removeFile(metadataPath); } catch {}
      return { ok: false, reason: errorReasonCode(error, "export-failed") };
    } finally {
      release();
    }
  }

  function purge() {
    acquire(now());
    let removed = 0;
    try {
      for (const entry of readdirSync(projectRoot, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("export-artifact-rejected");
        if (entry.name === "active.lock") continue;
        removed += removeFile(path.join(projectRoot, entry.name));
      }
    } finally {
      release();
    }
    try { rmdirSync(projectRoot); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    return { ok: true, removed };
  }

  cleanup();
  return Object.freeze({ run, cleanup, purge, root: projectRoot });
}

function lstatOptional(filePath) {
  try { return lstatSync(filePath); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function readLatestSensitiveExport({
  stateRoot,
  projectFingerprint,
  now = Date.now(),
} = {}) {
  const boundary = path.resolve(String(stateRoot ?? ""));
  if (!HASH_RE.test(String(projectFingerprint ?? ""))) throw new TypeError("invalid-project-fingerprint");
  const projectRoot = path.join(boundary, "self-evolve", "exports", projectFingerprint);
  const root = lstatOptional(projectRoot);
  if (!root) return null;
  assertDirectory(projectRoot, boundary);
  const candidates = readdirSync(projectRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json.meta.json"))
    .map((entry) => path.join(projectRoot, entry.name))
    .sort()
    .reverse();
  for (const metadataPath of candidates) {
    const metadataStat = lstatSync(metadataPath);
    if (!metadataStat.isFile() || metadataStat.nlink !== 1 || (metadataStat.mode & 0o777) !== FILE_MODE || metadataStat.size > 4096) {
      throw new Error("export-metadata-rejected");
    }
    let value;
    try { value = JSON.parse(readFileSync(metadataPath, "utf8")); } catch { continue; }
    if (value?.ok !== true
        || !["observations", "proposals", "global-recommendations", "project", "all"].includes(value.scope)
        || typeof value.path !== "string"
        || path.dirname(value.path) !== projectRoot
        || !Number.isSafeInteger(value.bytes)
        || value.bytes < 0
        || !HASH_RE.test(String(value.sha256 ?? ""))
        || !Number.isSafeInteger(value.expiresAt)
        || value.expiresAt <= now
        || value.classification !== "sensitive-self-evolve-archive") continue;
    const artifact = lstatOptional(value.path);
    if (!artifact || !artifact.isFile() || artifact.isSymbolicLink() || artifact.nlink !== 1
        || (artifact.mode & 0o777) !== FILE_MODE || artifact.size !== value.bytes) continue;
    return Object.freeze(value);
  }
  return null;
}
