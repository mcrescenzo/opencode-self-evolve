import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  revalidateStateRootBoundary,
  stateRootIdentity,
  validateStateRootBoundary,
  walkStateRootDirectories,
} from "../self-evolve-state-root.js";

function fixture(t, label = "self-evolve-state-root-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), label));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("validated state roots have one canonical path and identity", (t) => {
  const root = fixture(t);
  const boundary = validateStateRootBoundary(root);

  assert.equal(boundary.path, root);
  assert.equal(boundary.identity, stateRootIdentity(root));
  assert.equal(Object.isFrozen(boundary), true);
});

test("a symlinked state root is rejected without touching its target", (t) => {
  const parent = fixture(t);
  const outside = fixture(t, "self-evolve-state-root-outside-");
  const alias = path.join(parent, "state-alias");
  fs.writeFileSync(path.join(outside, "sentinel"), "unchanged");
  fs.symlinkSync(outside, alias, "dir");

  assert.throws(() => validateStateRootBoundary(alias), /state-root-boundary-rejected/u);
  assert.deepEqual(fs.readdirSync(outside), ["sentinel"]);
  assert.equal(fs.readFileSync(path.join(outside, "sentinel"), "utf8"), "unchanged");
});

test("missing canonical roots are created one component at a time and retain one identity", (t) => {
  const parent = fixture(t);
  const root = path.join(parent, "state", "opencode");
  const boundary = validateStateRootBoundary(root, { create: true });

  assert.equal(boundary.path, root);
  assert.equal(revalidateStateRootBoundary(boundary), root);
  assert.equal(walkStateRootDirectories(boundary, ["self-evolve", "global"], { create: true }), path.join(root, "self-evolve", "global"));
  assert.equal(boundary.identity, stateRootIdentity(root));
});

test("shared directory walks reject nested symlinks and observed root replacement", (t) => {
  const parent = fixture(t);
  const root = path.join(parent, "state");
  const held = path.join(parent, "held-state");
  const outside = fixture(t, "self-evolve-state-root-walk-outside-");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(outside, "sentinel"), "unchanged");
  const boundary = validateStateRootBoundary(root);
  fs.symlinkSync(outside, path.join(root, "self-evolve"), "dir");
  assert.throws(
    () => walkStateRootDirectories(boundary, ["self-evolve", "project"], { create: true }),
    /state-root-ancestor-rejected/u,
  );
  assert.deepEqual(fs.readdirSync(outside), ["sentinel"]);

  fs.unlinkSync(path.join(root, "self-evolve"));
  fs.renameSync(root, held);
  fs.symlinkSync(outside, root, "dir");
  assert.throws(() => revalidateStateRootBoundary(boundary), /state-root-boundary-rejected/u);
  assert.deepEqual(fs.readdirSync(outside), ["sentinel"]);
});
