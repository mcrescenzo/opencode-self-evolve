import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import nodeTest from "node:test";
import {
  DIRECTORY_FSYNC_UNAVAILABLE,
  createDurableFilesystem,
  probeDirectoryFsyncCapability,
  syncDirectoryFsync,
} from "../self-evolve-durable.js";
import { openStore } from "../self-evolve-store.js";
import { withStateMutationLock } from "../self-evolve-lock.js";

const H = (character) => character.repeat(64);
const PROJECT = H("a");
const HAS_NOFOLLOW = Number.isInteger(fs.constants.O_NOFOLLOW) && fs.constants.O_NOFOLLOW !== 0;

function test(name, options, callback) {
  if (typeof options === "function") { callback = options; options = undefined; }
  return nodeTest(name, options, async (t) => {
    const roots = [];
    t.after(() => { for (const root of roots.reverse()) fs.rmSync(root, { recursive: true, force: true }); });
    const tmp = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-durable-")); roots.push(root); return root; };
    try { return await callback(t, tmp); } catch (error) { error.tmp = roots; throw error; }
  });
}

function mkdir(root, ...segments) {
  const directory = path.join(root, ...segments);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

// Supported systems persist file content and parent directory in the documented order.
test("durableReplaceFile fsyncs the file content before rename and the parent directory after rename", (t, tmp) => {
  const root = tmp();
  const dir = mkdir(root, "data");
  const target = path.join(dir, "record.json");
  const events = [];
  const durable = createDurableFilesystem({
    syncFile: (descriptor) => { events.push({ step: "file-fsync", targetExists: fs.existsSync(target) }); fs.fsyncSync(descriptor); },
    syncDirectory: (directory) => { events.push({ step: "dir-fsync", directory, targetExists: fs.existsSync(target) }); syncDirectoryFsync(directory); },
    capability: { available: true, reason: null },
  });

  assert.equal(durable.capability.available, true);
  durable.durableReplaceFile(target, "{\"v\":1}\n");

  assert.equal(events.length, 2);
  assert.equal(events[0].step, "file-fsync");
  assert.equal(events[0].targetExists, false, "file content must be fsynced before the target exists");
  assert.equal(events[1].step, "dir-fsync");
  assert.equal(events[1].targetExists, true, "parent directory must be fsynced after the rename is visible");
  assert.equal(fs.readFileSync(target, "utf8"), "{\"v\":1}\n");
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), [], "no temp remains after a durable replace");
});

test("durableCreateExclusive fsyncs the file content then the parent directory", (t, tmp) => {
  const root = tmp();
  const dir = mkdir(root, "data");
  const target = path.join(dir, "lease.lock");
  const order = [];
  const durable = createDurableFilesystem({
    syncFile: (descriptor) => { order.push("file-fsync"); fs.fsyncSync(descriptor); },
    syncDirectory: (directory) => { order.push("dir-fsync"); syncDirectoryFsync(directory); },
    capability: { available: true, reason: null },
  });

  durable.durableCreateExclusive(target, "{\"pid\":1}\n");

  assert.deepEqual(order, ["file-fsync", "dir-fsync"]);
  assert.equal(fs.readFileSync(target, "utf8"), "{\"pid\":1}\n");
});

test("durableRename fsyncs the destination parent then the source parent after the rename", (t, tmp) => {
  const root = tmp();
  const srcDir = mkdir(root, "src");
  const dstDir = mkdir(root, "dst");
  const src = path.join(srcDir, "a.json");
  const dst = path.join(dstDir, "b.json");
  fs.writeFileSync(src, "payload\n");
  const synced = [];
  const durable = createDurableFilesystem({
    syncDirectory: (directory) => { synced.push({ directory, dstExists: fs.existsSync(dst), srcExists: fs.existsSync(src) }); syncDirectoryFsync(directory); },
    capability: { available: true, reason: null },
  });

  durable.durableRename(src, dst);

  assert.equal(synced.length, 2, "both parents are fsynced when src and dst differ");
  assert.equal(synced[0].directory, dstDir);
  assert.equal(synced[0].dstExists, true, "destination directory is fsynced after the rename is visible");
  assert.equal(synced[0].srcExists, false);
  assert.equal(synced[1].directory, srcDir);
  assert.equal(fs.existsSync(src), false);
  assert.equal(fs.readFileSync(dst, "utf8"), "payload\n");
});

test("durableRename fsyncs the single parent once when renaming inside the same directory", (t, tmp) => {
  const root = tmp();
  const dir = mkdir(root, "same");
  const src = path.join(dir, "old.json");
  const dst = path.join(dir, "new.json");
  fs.writeFileSync(src, "x\n");
  let count = 0;
  const durable = createDurableFilesystem({
    syncDirectory: (directory) => { count += 1; syncDirectoryFsync(directory); },
    capability: { available: true, reason: null },
  });

  durable.durableRename(src, dst);

  assert.equal(count, 1);
  assert.equal(fs.existsSync(src), false);
  assert.equal(fs.readFileSync(dst, "utf8"), "x\n");
});

test("durableUnlink fsyncs the parent directory after the removal", (t, tmp) => {
  const root = tmp();
  const dir = mkdir(root, "data");
  const target = path.join(dir, "gone.json");
  fs.writeFileSync(target, "x\n");
  let removalObservedBeforeSync = null;
  const durable = createDurableFilesystem({
    syncDirectory: (directory) => { removalObservedBeforeSync = !fs.existsSync(target); syncDirectoryFsync(directory); },
    probeDirectory: root,
  });

  durable.durableUnlink(target);

  assert.equal(removalObservedBeforeSync, true, "the entry is removed before the parent directory is fsynced");
  assert.equal(fs.existsSync(target), false);
});

// Tests model visible versus durable namespace entries and inject loss after each primitive.
for (const [label, point, setupKey] of [
  ["durableReplaceFile", "durable-replace-after-rename", "replace"],
  ["durableCreateExclusive", "durable-create-after-mutation", "create"],
  ["durableUnlink", "durable-unlink-after-removal", "unlink"],
  ["durableRename", "durable-rename-after-rename", "rename"],
]) {
  test(`loss injected after ${label} leaves the entry visible but the operation fails closed`, (t, tmp) => {
    const root = tmp();
    const dir = mkdir(root, "data");
    const durable = createDurableFilesystem({
      syncDirectory: syncDirectoryFsync,
      probeDirectory: dir,
      faultInjection: (received) => { if (received === point) throw new Error("injected-loss"); },
    });
    let thrown = null;

    if (setupKey === "replace") {
      const target = path.join(dir, "r.json");
      try { durable.durableReplaceFile(target, "new\n"); } catch (error) { thrown = error; }
      assert.equal(thrown?.message, "injected-loss");
      assert.equal(fs.existsSync(target), true, "rename is visible even though durability was not confirmed");
      assert.equal(fs.readFileSync(target, "utf8"), "new\n");
      assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
    } else if (setupKey === "create") {
      const target = path.join(dir, "c.json");
      try { durable.durableCreateExclusive(target, "created\n"); } catch (error) { thrown = error; }
      assert.equal(thrown?.message, "injected-loss");
      assert.equal(fs.existsSync(target), true, "created file is visible even though durability was not confirmed");
      assert.equal(fs.readFileSync(target, "utf8"), "created\n");
    } else if (setupKey === "unlink") {
      const target = path.join(dir, "u.json");
      fs.writeFileSync(target, "x\n");
      try { durable.durableUnlink(target); } catch (error) { thrown = error; }
      assert.equal(thrown?.message, "injected-loss");
      assert.equal(fs.existsSync(target), false, "removal is visible even though durability was not confirmed");
    } else {
      const src = path.join(dir, "s.json");
      const dst = path.join(dir, "d.json");
      fs.writeFileSync(src, "x\n");
      try { durable.durableRename(src, dst); } catch (error) { thrown = error; }
      assert.equal(thrown?.message, "injected-loss");
      assert.equal(fs.existsSync(src), false);
      assert.equal(fs.existsSync(dst), true, "rename is visible even though durability was not confirmed");
    }
  });
}

test("without an injected loss the directory fsync runs and the operation succeeds", (t, tmp) => {
  const root = tmp();
  const dir = mkdir(root, "data");
  let dirSyncs = 0;
  const durable = createDurableFilesystem({
    syncDirectory: (directory) => { dirSyncs += 1; syncDirectoryFsync(directory); },
    capability: { available: true, reason: null },
  });
  const target = path.join(dir, "ok.json");
  durable.durableReplaceFile(target, "ok\n");
  assert.equal(dirSyncs, 1);
  assert.equal(fs.readFileSync(target, "utf8"), "ok\n");
});

// Unsupported directory-fsync capability disables authoritative writes with a stable reason
// while read-only analysis remains available.
test("an unsupported directory-fsync capability is reported once with a stable reason", () => {
  const capability = probeDirectoryFsyncCapability({
    probeDirectory: os.tmpdir(),
    syncDirectory: () => { throw Object.assign(new Error("EINVAL"), { code: "EINVAL" }); },
  });
  assert.deepEqual(capability, { available: false, reason: DIRECTORY_FSYNC_UNAVAILABLE });
});

test("a missing probe directory yields a stable unavailable capability", () => {
  assert.deepEqual(probeDirectoryFsyncCapability({ syncDirectory: syncDirectoryFsync }), {
    available: false,
    reason: "directory-fsync-probe-unavailable",
  });
});

test("authoritative primitives fail closed with the stable reason when capability is unavailable, without mutating the tree", (t, tmp) => {
  const root = tmp();
  const dir = mkdir(root, "data");
  const durable = createDurableFilesystem({
    syncDirectory: () => { throw new Error("unsupported"); },
    probeDirectory: dir,
  });
  assert.equal(durable.capability.available, false);
  assert.equal(durable.capability.reason, DIRECTORY_FSYNC_UNAVAILABLE);

  const target = path.join(dir, "noauth.json");
  for (const op of [
    () => durable.durableCreateExclusive(target, "x\n"),
    () => durable.durableReplaceFile(target, "x\n"),
    () => durable.durableRename(path.join(dir, "a"), path.join(dir, "b")),
    () => durable.durableUnlink(target),
  ]) {
    assert.throws(op, new RegExp(DIRECTORY_FSYNC_UNAVAILABLE, "u"));
  }
  assert.equal(fs.existsSync(target), false, "fail-closed happens before any namespace mutation");
  assert.deepEqual(fs.readdirSync(dir), [], "no authoritative bytes are written");
  // Read-only analysis remains available: reads do not route through the durable primitives.
  const readable = path.join(dir, "read-only.json");
  fs.writeFileSync(readable, "still-readable\n");
  assert.equal(fs.readFileSync(readable, "utf8"), "still-readable\n");
});

test("an explicit unavailable capability object is honored by the primitives", (t, tmp) => {
  const root = tmp();
  const dir = mkdir(root, "data");
  const durable = createDurableFilesystem({
    syncDirectory: syncDirectoryFsync,
    capability: { available: false, reason: DIRECTORY_FSYNC_UNAVAILABLE },
  });
  assert.equal(durable.capability.available, false);
  assert.throws(() => durable.durableCreateExclusive(path.join(dir, "x"), "y"), /directory-fsync-unavailable/u);
});

test("an explicit available capability object skips the probe", (t, tmp) => {
  let probed = false;
  const durable = createDurableFilesystem({
    syncDirectory: (directory) => { probed = true; syncDirectoryFsync(directory); },
    capability: { available: true, reason: null },
    probeDirectory: null,
  });
  assert.equal(durable.capability.available, true);
  assert.equal(probed, false, "an explicit capability short-circuits the probe");
});

// Path, symlink, create-exclusive, and cleanup behavior remains correct.
test("durableCreateExclusive is create-exclusive and refuses a symlink at the file boundary", { skip: !HAS_NOFOLLOW }, (t, tmp) => {
  const root = tmp();
  const dir = mkdir(root, "data");
  const target = path.join(dir, "exclusive.json");
  const outside = path.join(root, "outside");
  fs.writeFileSync(outside, "secret\n");

  const durable = createDurableFilesystem({ probeDirectory: dir });
  durable.durableCreateExclusive(target, "first\n");
  assert.throws(() => durable.durableCreateExclusive(target, "second\n"), (error) => error.code === "EEXIST");
  assert.equal(fs.readFileSync(target, "utf8"), "first\n");

  const linked = path.join(dir, "symlink-target.json");
  fs.symlinkSync(outside, linked);
  assert.throws(
    () => durable.durableCreateExclusive(linked, "hijack\n"),
    (error) => error.code === "ELOOP" || error.code === "EEXIST",
    "a symlink at the file boundary is refused, not followed",
  );
  assert.equal(fs.readFileSync(outside, "utf8"), "secret\n", "symlink target was not followed");
});

test("durableReplaceFile cleans up its temp when the content write fails and leaves the target untouched", (t, tmp) => {
  const root = tmp();
  const dir = mkdir(root, "data");
  const target = path.join(dir, "replace.json");
  fs.writeFileSync(target, "original\n");
  const durable = createDurableFilesystem({
    syncFile: () => { throw new Error("content-fsync-failure"); },
    probeDirectory: dir,
  });

  assert.throws(() => durable.durableReplaceFile(target, "new\n"), /content-fsync-failure/u);
  assert.equal(fs.readFileSync(target, "utf8"), "original\n", "target is unchanged when the replace fails before rename");
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), [], "temp is cleaned up on write failure");
});

test("durableReplaceFile cleans up its temp when the file open fails in a read-only parent", { skip: process.platform === "win32" }, (t, tmp) => {
  const root = tmp();
  const dir = mkdir(root, "data");
  const target = path.join(dir, "replace-open.json");
  fs.writeFileSync(target, "original\n");
  fs.chmodSync(dir, 0o500);
  const durable = createDurableFilesystem({ probeDirectory: root });
  let caught;
  try {
    try { durable.durableReplaceFile(target, "x\n"); } catch (error) { caught = error; }
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  assert.ok(caught, "creating a temp in a read-only parent must fail");
  assert.equal(fs.readFileSync(target, "utf8"), "original\n", "target is unchanged");
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), [], "no temp leaks when open fails");
});

test("syncDirectoryFsync rejects an empty path and refuses a symlinked directory", { skip: !HAS_NOFOLLOW }, (t, tmp) => {
  const root = tmp();
  assert.throws(() => syncDirectoryFsync(""), /directory-required/u);
  const real = mkdir(root, "real");
  const link = path.join(root, "link");
  fs.symlinkSync(real, link, "dir");
  assert.throws(() => syncDirectoryFsync(link), (error) => error.code === "ELOOP" || error.code === "ENOTDIR");
  // Real directories fsync without error.
  syncDirectoryFsync(real);
});

test("createDurableFilesystem validates its injectable sync dependencies", () => {
  assert.throws(() => createDurableFilesystem({ syncFile: null }), /durable-sync-file-must-be-function/u);
  assert.throws(() => createDurableFilesystem({ syncDirectory: null }), /durable-sync-directory-must-be-function/u);
});

// Existing store and lock behavior remains correct, now with directory fsync on the authoritative path.
test("store authoritative writes route through the durable directory-fsync seam while the file-fsync seam is preserved", (t, tmp) => {
  const root = tmp();
  let dirSyncs = 0;
  let fileSyncs = 0;
  const store = openStore(root, {
    projectFingerprint: PROJECT,
    now: () => 1_000,
    filesystemSync: (descriptor) => { fileSyncs += 1; fs.fsyncSync(descriptor); },
    filesystemSyncDirectory: (directory) => { dirSyncs += 1; syncDirectoryFsync(directory); },
  });
  const beforeDir = dirSyncs;
  const beforeFile = fileSyncs;

  assert.equal(store.updateGlobalSettings((settings) => ({
    ...settings,
    retentionDays: settings.retentionDays + 1,
    updatedAt: settings.updatedAt + 1,
  })).ok, true);

  assert.ok(dirSyncs > beforeDir, "the authoritative settings write now fsyncs the parent directory");
  assert.ok(fileSyncs > beforeFile, "the historical file-content fsync seam is still exercised");
  store.close();
});

test("store opens read-only after partition creation even though authoritative writes are durable", (t, tmp) => {
  const root = tmp();
  const store = openStore(root, { projectFingerprint: PROJECT, now: () => 1_000 });
  assert.equal(store.getSettings().global.mode, "manual");
  store.close();

  const reopened = openStore(root, { projectFingerprint: PROJECT, now: () => 2_000 });
  assert.equal(reopened.getSettings().global.mode, "manual");
  reopened.close();
});

test("the cross-process mutation lock still acquires and releases with a durable store present", (t, tmp) => {
  const root = tmp();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let ran = false;
  const result = withStateMutationLock(root, () => { ran = true; return "done"; }, { lockTimeoutMs: 500, staleLockMs: 500 });
  assert.equal(result, "done");
  assert.equal(ran, true);
});
