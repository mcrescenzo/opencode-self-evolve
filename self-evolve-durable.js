// Power-loss-durable namespace mutation primitives shared by the store, applier,
// and the downstream root-epoch / apply-undo journal work.
//
// Every authoritative primitive fsyncs the file CONTENT and then the PARENT
// DIRECTORY entry that names it: file content fsync alone survives a crash that
// tears an in-progress write, but only a parent-directory fsync after the
// namespace mutation (create, rename, replace, unlink) survives a crash that
// loses the directory entry itself. Replacing a file via rename is durable only
// once both the new directory entry and (for replace) the removal of the old
// entry have reached stable storage, which is exactly what fsyncing the parent
// directory guarantees.
//
// On hosts where an O_RDONLY directory descriptor cannot be fsynced, durable
// authoritative writes fail closed with the stable reason
// `DIRECTORY_FSYNC_UNAVAILABLE`; read-only analysis paths never touch this
// module and so remain available.
//
// Permanent capability boundary: this module uses only local filesystem and
// hashing primitives. It must never gain subprocess, source-control, remote I/O,
// package-manager, model/agent, dynamic-loader, or publication capabilities, and
// (dual-target invariant) it must not import the TUI target.

import {
  closeSync,
  constants,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

const FILE_MODE = 0o600;

const NOFOLLOW = Number.isInteger(constants.O_NOFOLLOW) && constants.O_NOFOLLOW !== 0
  ? constants.O_NOFOLLOW
  : null;
const DIRECTORY_FLAG = Number.isInteger(constants.O_DIRECTORY) && constants.O_DIRECTORY !== 0
  ? constants.O_DIRECTORY
  : null;

export const DURABLE_FILE_MODE = FILE_MODE;
export const DIRECTORY_FSYNC_UNAVAILABLE = "directory-fsync-unavailable";

const CAPABILITY_AVAILABLE = Object.freeze({ available: true, reason: null });
const CAPABILITY_PROBE_MISSING = Object.freeze({ available: false, reason: "directory-fsync-probe-unavailable" });

function fileCreateFlags(base) {
  return NOFOLLOW === null ? base : base | NOFOLLOW;
}

function directoryOpenFlags() {
  // O_NOFOLLOW refuses a symlink at the directory boundary and O_DIRECTORY
  // refuses a non-directory, preserving path-boundary authority the same way the
  // applier's directory capture already does.
  let flags = constants.O_RDONLY;
  if (DIRECTORY_FLAG !== null) flags |= DIRECTORY_FLAG;
  if (NOFOLLOW !== null) flags |= NOFOLLOW;
  return flags;
}

// Open a directory read-only and fsync its descriptor. This is the canonical
// parent-directory durability step. Refuses symlinks at the directory boundary.
export function syncDirectoryFsync(directory) {
  if (typeof directory !== "string" || !directory) throw new TypeError("directory-required");
  let descriptor;
  try {
    descriptor = openSync(directory, directoryOpenFlags());
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
  }
}

// Probe once whether parent-directory fsync is available on the host for the
// given probe directory. Bounded: any probe error is treated as unavailable.
// The returned reason is stable and distinguishable regardless of the host's
// underlying errno so callers can gate on it deterministically.
export function probeDirectoryFsyncCapability({ syncDirectory = syncDirectoryFsync, probeDirectory = null } = {}) {
  if (typeof probeDirectory !== "string" || !probeDirectory) return CAPABILITY_PROBE_MISSING;
  if (typeof syncDirectory !== "function") return CAPABILITY_PROBE_MISSING;
  try {
    syncDirectory(probeDirectory);
    return CAPABILITY_AVAILABLE;
  } catch {
    return Object.freeze({ available: false, reason: DIRECTORY_FSYNC_UNAVAILABLE });
  }
}

function resolveCapability(capability, probeDirectory, syncDirectory) {
  if (capability && typeof capability === "object" && typeof capability.available === "boolean") {
    return Object.freeze({
      available: capability.available,
      reason: capability.reason ?? (capability.available ? null : DIRECTORY_FSYNC_UNAVAILABLE),
    });
  }
  if (typeof probeDirectory === "string" && probeDirectory) {
    return probeDirectoryFsyncCapability({ syncDirectory, probeDirectory });
  }
  return CAPABILITY_AVAILABLE;
}

// Create a bound set of durable primitives over one set of injectable
// filesystem-sync dependencies. `syncFile` is the file-content fsync seam
// (mirrors the store's historical `filesystemSync` parameter); `syncDirectory`
// is the parent-directory fsync seam. `faultInjection` is the internal loss
// seam: it fires after each namespace mutation but before the directory fsync,
// so a test that throws from it models a "visible but not durable" entry.
export function createDurableFilesystem({
  syncFile = fsyncSync,
  syncDirectory = syncDirectoryFsync,
  probeDirectory = null,
  capability = null,
  faultInjection = null,
  fileMode = FILE_MODE,
} = {}) {
  if (typeof syncFile !== "function") throw new TypeError("durable-sync-file-must-be-function");
  if (typeof syncDirectory !== "function") throw new TypeError("durable-sync-directory-must-be-function");
  const resolvedCapability = resolveCapability(capability, probeDirectory, syncDirectory);
  const inject = typeof faultInjection === "function" ? faultInjection : () => {};

  function assertAuthoritative() {
    if (!resolvedCapability.available) {
      throw new Error(resolvedCapability.reason ?? DIRECTORY_FSYNC_UNAVAILABLE);
    }
  }

  function durableCreateExclusive(filePath, contents, { mode = fileMode } = {}) {
    assertAuthoritative();
    if (typeof filePath !== "string" || !filePath) throw new TypeError("file-path-required");
    let descriptor;
    try {
      descriptor = openSync(filePath, fileCreateFlags(constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY), mode);
      writeFileSync(descriptor, contents);
      syncFile(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      // The namespace entry now exists and its content is fsynced. The remaining
      // durability step is the parent-directory fsync; a fault thrown here models
      // the entry being visible but not namespace-durable.
      inject("durable-create-after-mutation", { filePath });
      syncDirectory(path.dirname(filePath));
    } catch (error) {
      // Only clean up if the file was never fully written + closed. After a
      // successful close the file is content-durable; a later directory-fsync
      // failure leaves it intentionally visible-but-not-durable.
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch {}
        try { unlinkSync(filePath); } catch {}
      }
      throw error;
    }
  }

  function durableReplaceFile(filePath, contents, { mode = fileMode } = {}) {
    assertAuthoritative();
    if (typeof filePath !== "string" || !filePath) throw new TypeError("file-path-required");
    const parent = path.dirname(filePath);
    const temporary = path.join(
      parent,
      `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    let descriptor;
    let renamed = false;
    try {
      descriptor = openSync(temporary, fileCreateFlags(constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY), mode);
      writeFileSync(descriptor, contents);
      syncFile(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, filePath);
      renamed = true;
      // rename is the durability-critical namespace mutation: the target now
      // carries the new content but the directory entry is not stable until the
      // parent-directory fsync below succeeds.
      inject("durable-replace-after-rename", { filePath, temporary });
      syncDirectory(parent);
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch {}
        try { unlinkSync(temporary); } catch {}
      } else if (!renamed) {
        // rename failed (or was never reached): remove the orphaned temp.
        try { unlinkSync(temporary); } catch {}
      }
      // If renamed === true the target is published and visible; a directory
      // fsync failure leaves it visible-but-not-durable, which the caller must
      // resolve. We never undo a completed rename here.
      throw error;
    }
  }

  function durableRename(src, dst) {
    assertAuthoritative();
    if (typeof src !== "string" || !src) throw new TypeError("source-path-required");
    if (typeof dst !== "string" || !dst) throw new TypeError("destination-path-required");
    const srcParent = path.dirname(src);
    const dstParent = path.dirname(dst);
    renameSync(src, dst);
    inject("durable-rename-after-rename", { src, dst });
    syncDirectory(dstParent);
    if (srcParent !== dstParent) syncDirectory(srcParent);
  }

  function durableUnlink(filePath) {
    assertAuthoritative();
    if (typeof filePath !== "string" || !filePath) throw new TypeError("file-path-required");
    unlinkSync(filePath);
    // The entry is removed from the namespace; the removal is not stable until
    // the parent-directory fsync confirms it.
    inject("durable-unlink-after-removal", { filePath });
    syncDirectory(path.dirname(filePath));
  }

  return Object.freeze({
    capability: resolvedCapability,
    durableCreateExclusive,
    durableReplaceFile,
    durableRename,
    durableUnlink,
  });
}
