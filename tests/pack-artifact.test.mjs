import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { artifactProvenance } from "../scripts/pack-artifact-check.mjs";
import {
  assertCleanCheckout,
  assertExactCommit,
  planReleaseReconciliation,
} from "../scripts/release-artifact.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const releaseScript = path.join(repoRoot, "scripts", "release-artifact.mjs");

test("release provenance binds commit, exact tarball bytes, and deterministic inventory", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-provenance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tarball = path.join(root, "candidate.tgz");
  writeFileSync(tarball, "exact candidate bytes");
  const packed = {
    filename: "candidate.tgz",
    files: [
      { path: "z.js", size: 2, mode: 0o644 },
      { path: "package.json", size: 1, mode: 0o644 },
    ],
  };
  const commit = "a".repeat(40);
  const first = artifactProvenance(packed, tarball, commit);
  const second = artifactProvenance({ ...packed, files: [...packed.files].reverse() }, tarball, commit);
  assert.equal(first.commit, commit);
  assert.equal(first.filename, packed.filename);
  assert.match(first.sha256, /^[a-f0-9]{64}$/u);
  assert.match(first.inventorySha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(first, second);
});

test("release commit and checkout guards fail closed", () => {
  assert.doesNotThrow(() => assertExactCommit("a".repeat(40), `${"a".repeat(40)}\n`));
  assert.throws(() => assertExactCommit("short", "short"), /full 40-character SHA/u);
  assert.throws(() => assertExactCommit("a".repeat(40), "b".repeat(40)), /expected/u);
  assert.doesNotThrow(() => assertCleanCheckout("", "after packing"));
  assert.throws(() => assertCleanCheckout(" M package.json\n", "after packing"), /not clean after packing/u);
});

test("release reconciliation plans only missing downstream mutations", async (t) => {
  const expected = {
    packageName: "@example/plugin",
    version: "1.2.3",
    expectedCommit: "a".repeat(40),
    expectedIntegrity: "sha512-local",
    expectedAssets: {
      "example-plugin-1.2.3.tgz": "1".repeat(64),
      "provenance.json": "2".repeat(64),
    },
  };
  const complete = {
    ...expected,
    publishedIntegrity: expected.expectedIntegrity,
    tagCommit: expected.expectedCommit,
    releaseAssets: expected.expectedAssets,
  };

  await t.test("unpublished", () => {
    assert.deepEqual(planReleaseReconciliation({
      ...expected,
      publishedIntegrity: null,
      tagCommit: null,
      releaseAssets: null,
    }), { publish: true, createTag: true, createRelease: true });
  });
  await t.test("published with no tag", () => {
    assert.deepEqual(planReleaseReconciliation({
      ...complete,
      tagCommit: null,
      releaseAssets: null,
    }), { publish: false, createTag: true, createRelease: true });
  });
  await t.test("published with tag and no release", () => {
    assert.deepEqual(planReleaseReconciliation({
      ...complete,
      releaseAssets: null,
    }), { publish: false, createTag: false, createRelease: true });
  });
  await t.test("wrong tag target stops with evidence", () => {
    assert.throws(() => planReleaseReconciliation({
      ...complete,
      tagCommit: "b".repeat(40),
    }), new RegExp(`tag v1\\.2\\.3 targets ${"b".repeat(40)}, expected ${"a".repeat(40)}`, "u"));
  });
  await t.test("conflicting registry artifact stops with evidence", () => {
    assert.throws(() => planReleaseReconciliation({
      ...complete,
      publishedIntegrity: "sha512-registry-conflict",
    }), /@example\/plugin@1\.2\.3 has registry integrity sha512-registry-conflict, expected sha512-local/u);
  });
  await t.test("conflicting release artifact or provenance stops with evidence", () => {
    for (const asset of Object.keys(expected.expectedAssets)) {
      assert.throws(() => planReleaseReconciliation({
        ...complete,
        releaseAssets: { ...complete.releaseAssets, [asset]: "f".repeat(64) },
      }), new RegExp(`${asset} has SHA-256 ${"f".repeat(64)}, expected ${expected.expectedAssets[asset]}`, "u"));
      const withoutAsset = { ...complete.releaseAssets };
      delete withoutAsset[asset];
      assert.throws(() => planReleaseReconciliation({
        ...complete,
        releaseAssets: withoutAsset,
      }), new RegExp(`missing ${asset}, expected SHA-256 ${expected.expectedAssets[asset]}`, "u"));
    }
  });
  await t.test("fully complete rerun is mutation-free", () => {
    assert.deepEqual(planReleaseReconciliation(complete), {
      publish: false,
      createTag: false,
      createRelease: false,
    });
  });
});

test("stale generated TUI fails before any package command", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-stale-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of ["package.json", "self-evolve-tui.tsx", "self-evolve-tui.generated.js"]) {
    cpSync(path.join(repoRoot, file), path.join(root, file));
  }
  cpSync(
    path.join(repoRoot, "tests", "fixtures", "release-artifact", "stale.generated.js"),
    path.join(root, "self-evolve-tui.generated.js"),
  );
  const bin = path.join(root, "bin");
  const marker = path.join(root, "npm-invoked");
  mkdirSync(bin);
  const fakeNpm = path.join(bin, "npm");
  writeFileSync(fakeNpm, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 99\n`);
  chmodSync(fakeNpm, 0o755);

  const result = spawnSync(process.execPath, [
    releaseScript,
    "--root", root,
    "--output", path.join(root, "artifact"),
    "--commit", "a".repeat(40),
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /generated TUI artifact is stale/u);
  assert.equal(existsSync(marker), false, "npm unexpectedly ran before stale artifact rejection");
});
