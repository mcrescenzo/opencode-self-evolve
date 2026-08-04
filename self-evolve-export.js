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
import { errorReasonCode } from "./self-evolve-schemas.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const DEFAULT_TEMP_QUOTA_BYTES = 128 * 1024 * 1024;
const HASH_RE = /^[a-f0-9]{64}$/u;
const NOFOLLOW = Number.isInteger(constants.O_NOFOLLOW) ? constants.O_NOFOLLOW : 0;

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

export function createSensitiveExportManager({
  stateRoot,
  projectFingerprint,
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
  maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES,
  temporaryQuotaBytes = DEFAULT_TEMP_QUOTA_BYTES,
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

  function cleanup(timestamp = now()) {
    let removed = 0;
    let bytes = 0;
    for (const entry of readdirSync(projectRoot, { withFileTypes: true })) {
      const filePath = path.join(projectRoot, entry.name);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("export-artifact-rejected");
      const stat = lstatSync(filePath);
      if (stat.nlink !== 1 || (stat.mode & 0o077) !== 0) throw new Error("export-artifact-rejected");
      if (entry.name === "active.lock") {
        try {
          const lock = JSON.parse(readFileSync(filePath, "utf8"));
          if (!Number.isSafeInteger(lock.expiresAt) || lock.expiresAt <= timestamp) removed += removeFile(filePath);
        } catch {
          removed += removeFile(filePath);
        }
        continue;
      }
      const createdAt = /^\.?([0-9]+)-/u.exec(entry.name)?.[1];
      const expiresAt = createdAt && Number.isSafeInteger(Number(createdAt))
        ? Number(createdAt) + ttlMs
        : stat.mtimeMs + ttlMs;
      if (entry.name.endsWith(".tmp") || expiresAt <= timestamp) {
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
    try {
      descriptor = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, FILE_MODE);
      const source = `${JSON.stringify({
        pid: process.pid,
        issuedAt: timestamp,
        expiresAt: timestamp + ttlMs,
        nonce: randomBytes(16).toString("hex"),
      })}\n`;
      writeSync(descriptor, source);
      fsyncSync(descriptor);
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== FILE_MODE) throw new Error("export-lock-rejected");
      active = true;
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error("export-job-active");
      throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  function release() {
    active = false;
    try { removeFile(lockPath); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  function run({ scope, archive }) {
    const timestamp = now();
    acquire(timestamp);
    const id = randomBytes(16).toString("hex");
    const temporaryPath = path.join(projectRoot, `.${timestamp}-${id}.json.tmp`);
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
      writeSync(descriptor, Buffer.from("\n"));
      bytes += 1;
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
      metadataTemporaryPath = `${metadataPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
      try {
        metadataDescriptor = openSync(metadataTemporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, FILE_MODE);
        writeSync(metadataDescriptor, `${JSON.stringify(result)}\n`);
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
    let removed = 0;
    for (const entry of readdirSync(projectRoot, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("export-artifact-rejected");
      removed += removeFile(path.join(projectRoot, entry.name));
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
        || !["observations", "proposals", "project", "all"].includes(value.scope)
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
