import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { main as checkTuiArtifact } from "./check-tui-artifact.mjs";
import {
  artifactProvenance,
  assertSpawnSucceeded,
  parsePackResult,
  runDependencyAudit,
  validatePackedArtifact,
} from "./pack-artifact-check.mjs";

const defaultRepoRoot = path.resolve(import.meta.dirname, "..");

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  return assertSpawnSucceeded(spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
  }), command, args);
}

export function assertExactCommit(expected, actual) {
  if (!/^[a-f0-9]{40}$/u.test(expected ?? "")) fail("release commit must be a full 40-character SHA");
  if (actual.trim() !== expected) fail(`release checkout is ${actual.trim()}, expected ${expected}`);
}

export function assertCleanCheckout(status, phase) {
  if (status !== "") fail(`release checkout is not clean ${phase}\n${status}`);
}

export function planReleaseReconciliation({
  packageName,
  version,
  publishedIntegrity,
  expectedIntegrity,
  tagCommit,
  expectedCommit,
  releaseAssets,
  expectedAssets,
}) {
  const tag = `v${version}`;
  if (publishedIntegrity !== null && publishedIntegrity !== expectedIntegrity) {
    fail(`${packageName}@${version} has registry integrity ${publishedIntegrity}, expected ${expectedIntegrity}`);
  }
  if (tagCommit !== null && tagCommit !== expectedCommit) {
    fail(`tag ${tag} targets ${tagCommit}, expected ${expectedCommit}`);
  }
  if (releaseAssets !== null && tagCommit === null) {
    fail(`GitHub Release ${tag} exists but its tag is missing`);
  }
  if (publishedIntegrity === null && (tagCommit !== null || releaseAssets !== null)) {
    fail(`${packageName}@${version} is unpublished but downstream tag or release state already exists`);
  }
  if (releaseAssets !== null) {
    for (const [name, expectedSha256] of Object.entries(expectedAssets)) {
      const actualSha256 = releaseAssets[name];
      if (actualSha256 === undefined) {
        fail(`GitHub Release ${tag} is missing ${name}, expected SHA-256 ${expectedSha256}`);
      }
      if (actualSha256 !== expectedSha256) {
        fail(`${name} has SHA-256 ${actualSha256}, expected ${expectedSha256}`);
      }
    }
  }
  return {
    publish: publishedIntegrity === null,
    createTag: tagCommit === null,
    createRelease: releaseAssets === null,
  };
}

function checkoutStatus(repoRoot) {
  return run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repoRoot }).stdout;
}

export function createReleaseArtifact({ repoRoot = defaultRepoRoot, outputDir, commit }) {
  // This must precede every pack or publication-capable operation.
  checkTuiArtifact({ root: repoRoot, check: true });
  assertExactCommit(commit, run("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).stdout);
  assertCleanCheckout(checkoutStatus(repoRoot), "before packing");

  // The dependency audit is a mandatory publication gate. It runs after the
  // Node-only TUI/commit/checkout structural checks (which must precede any
  // `npm` invocation) and immediately before any pack or publication-capable
  // operation. It runs the dependency-free `npm run audit:dependencies`
  // (Bun JSON audit plus owner-exception verification, including the
  // no-future-reviewDate rule) and fails closed on any unresolved or malformed
  // finding.
  runDependencyAudit(repoRoot);

  if (!outputDir) fail("release artifact output directory is required");
  mkdirSync(outputDir, { recursive: true });
  if (readdirSync(outputDir).length) fail("release artifact output directory must be empty");
  const tempRoot = path.join(outputDir, ".validation");
  mkdirSync(tempRoot);
  const npmEnv = { ...process.env, npm_config_cache: path.join(tempRoot, "npm-cache") };
  const packed = parsePackResult(run("npm", [
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    outputDir,
  ], { cwd: repoRoot, env: npmEnv }).stdout);
  const tarballs = readdirSync(outputDir).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1 || tarballs[0] !== packed.filename) {
    fail(`release packing must create exactly one declared tarball; found ${tarballs.join(", ") || "none"}`);
  }
  const tarball = path.join(outputDir, packed.filename);
  if (!existsSync(tarball)) fail(`release tarball is missing: ${tarball}`);
  validatePackedArtifact({ repoRoot, packed, tarball, tempRoot, npmEnv });

  const provenance = artifactProvenance(packed, tarball, commit);
  const provenancePath = path.join(outputDir, "provenance.json");
  writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const provenanceSha256 = createHash("sha256").update(readFileSync(provenancePath)).digest("hex");
  rmSync(tempRoot, { recursive: true, force: true });
  assertCleanCheckout(checkoutStatus(repoRoot), "after packing and consumer validation");
  const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
  return { tarball, provenancePath, provenance, provenanceSha256, integrity };
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    const reconciliationPath = option("--reconcile");
    if (reconciliationPath) {
      const plan = planReleaseReconciliation(JSON.parse(readFileSync(path.resolve(reconciliationPath), "utf8")));
      if (process.env.GITHUB_OUTPUT) {
        writeFileSync(process.env.GITHUB_OUTPUT, [
          `publish=${plan.publish}`,
          `create_tag=${plan.createTag}`,
          `create_release=${plan.createRelease}`,
          "",
        ].join("\n"), { flag: "a" });
      }
      console.log(`Release reconciliation plan: ${JSON.stringify(plan)}`);
      process.exit(0);
    }
    const result = createReleaseArtifact({
      repoRoot: path.resolve(option("--root") ?? defaultRepoRoot),
      outputDir: option("--output") && path.resolve(option("--output")),
      commit: option("--commit"),
    });
    const githubOutput = process.env.GITHUB_OUTPUT;
    if (githubOutput) {
      writeFileSync(githubOutput, [
        `tarball=${result.tarball}`,
        `tarball_name=${path.basename(result.tarball)}`,
        `provenance=${result.provenancePath}`,
        `provenance_sha256=${result.provenanceSha256}`,
        `artifact_name=release-artifact-${result.provenance.commit}`,
        `sha256=${result.provenance.sha256}`,
        `integrity=${result.integrity}`,
        `inventory_sha256=${result.provenance.inventorySha256}`,
        `commit=${result.provenance.commit}`,
        "",
      ].join("\n"), { flag: "a" });
    }
    console.log(`Release artifact ready: ${result.tarball}`);
    console.log(`Release provenance: ${result.provenancePath}`);
  } catch (error) {
    console.error(`Release artifact check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
