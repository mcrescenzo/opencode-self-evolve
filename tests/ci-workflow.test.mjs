import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const workflow = readFileSync(path.resolve(import.meta.dirname, "../.github/workflows/ci.yml"), "utf8");
const releaseWorkflow = readFileSync(path.resolve(import.meta.dirname, "../.github/workflows/release.yml"), "utf8");
const releaseArtifactScript = readFileSync(path.resolve(import.meta.dirname, "../scripts/release-artifact.mjs"), "utf8");
const dependabot = readFileSync(path.resolve(import.meta.dirname, "../.github/dependabot.yml"), "utf8");

function jobSource(name, nextName) {
  const start = workflow.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1, `missing ${name} job`);
  const end = nextName ? workflow.indexOf(`  ${nextName}:\n`, start) : workflow.length;
  assert.notEqual(end, -1, `missing ${nextName} job`);
  return workflow.slice(start, end);
}

function releaseJobSource(name, nextName) {
  const start = releaseWorkflow.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1, `missing ${name} release job`);
  const end = nextName ? releaseWorkflow.indexOf(`  ${nextName}:\n`, start) : releaseWorkflow.length;
  assert.notEqual(end, -1, `missing ${nextName} release job`);
  return releaseWorkflow.slice(start, end);
}

test("canonical CI pins the supported toolchain and preserves the locked graph", () => {
  const source = jobSource("canonical-validation", "node-compatibility");

  assert.match(source, /node-version: "22\.11\.0"/u);
  assert.match(source, /bun-version: "1\.3\.8"/u);
  assert.match(source, /test "\$node_version" = "v22\.11\.0"/u);
  assert.match(source, /test "\$bun_version" = "1\.3\.8"/u);
  assert.match(source, /bun install --frozen-lockfile/u);
  assert.match(source, /bun pm ls --all/u);
  assert.match(source, /git diff --exit-code -- package\.json bun\.lock/u);
  assert.doesNotMatch(source, /npm install/u);
});

test("alternate dependency graphs run outside canonical validation", () => {
  const canonical = jobSource("canonical-validation", "node-compatibility");
  const openCode = jobSource("opencode-contract-compatibility", "packed-tui-compatibility");
  const openTui = jobSource("packed-tui-compatibility");

  assert.doesNotMatch(canonical, /matrix\.|test:tui-matrix/u);
  assert.match(openCode, /matrix\.opencode-plugin-version/u);
  assert.match(openCode, /Check out isolated compatibility workspace/u);
  assert.match(openTui, /npm run test:tui-matrix/u);
});

test("release complete-suite validation uses the residue-checking npm wrapper", () => {
  assert.match(releaseWorkflow, /- name: Test[\s\S]*?run: npm test/u);
  assert.doesNotMatch(releaseWorkflow, /node --test tests\/\*\.test\.mjs/u);
});

test("release actions are immutable reviewed commits and remain Dependabot-maintained", () => {
  const usesLines = releaseWorkflow.match(/^\s*uses:.*$/gmu) ?? [];
  const actionUses = [...releaseWorkflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#\s*(v\d+\.\d+\.\d+))?$/gmu)];
  assert.ok(actionUses.length > 0);
  assert.equal(actionUses.length, usesLines.length, "every uses line must match the pinned action format");
  for (const [, action, tag] of actionUses) {
    assert.match(action, /^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/u);
    assert.match(tag, /^v\d+\.\d+\.\d+$/u);
  }
  assert.match(dependabot, /package-ecosystem: github-actions[\s\S]*directory: \/[\s\S]*interval: weekly/u);
  assert.match(dependabot, /package-ecosystem: bun[\s\S]*directory: \/[\s\S]*interval: weekly/u);
});

test("release pins the exact supported Node, Bun, and npm toolchain", () => {
  assert.match(releaseWorkflow, /node-version: "22\.11\.0"/u);
  assert.doesNotMatch(releaseWorkflow, /node-version: (?:22|"22")\s*$/mu);
  assert.match(releaseWorkflow, /bun-version: "1\.3\.8"/u);
  assert.match(releaseWorkflow, /npm@11\.5\.1/u);
  assert.match(releaseWorkflow, /test "\$\(npm --version\)" = "11\.5\.1"/u);
  assert.doesNotMatch(releaseWorkflow, /npm@latest/u);
});

test("release waits for successful CI and binds checkout plus artifact to its exact commit", () => {
  assert.match(releaseWorkflow, /workflow_run:[\s\S]*workflows: \[CI\][\s\S]*types: \[completed\][\s\S]*branches: \[main\]/u);
  assert.match(releaseWorkflow, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/u);
  assert.match(releaseWorkflow, /RELEASE_COMMIT: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/u);
  assert.doesNotMatch(releaseWorkflow, /workflow_dispatch:|\n  push:/u);
});

test("release rejects PR and non-main workflow runs before privileged publication", () => {
  assert.match(releaseWorkflow, /github\.event\.workflow_run\.event == 'push' &&[\s\S]*github\.event\.workflow_run\.conclusion == 'success' &&[\s\S]*github\.event\.workflow_run\.head_branch == 'main'/u);
});

test("release jobs separate validation, OIDC publication, and contents delivery permissions", () => {
  const validate = releaseJobSource("validate", "publish");
  const publish = releaseJobSource("publish", "deliver");
  const deliver = releaseJobSource("deliver");

  assert.match(releaseWorkflow, /^permissions: \{\}$/mu);
  assert.match(validate, /permissions:\n      contents: read\n    outputs:/u);
  assert.match(publish, /permissions:\n      id-token: write\n    steps:/u);
  assert.match(deliver, /permissions:\n      contents: write\n    steps:/u);
  assert.doesNotMatch(`${publish}\n${deliver}`, /actions\/checkout@/u);
});

test("TUI generation remains explicit while validation and packaging are non-mutating", () => {
  const packageJSON = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"));
  assert.equal(packageJSON.scripts["build:tui"], "node scripts/check-tui-artifact.mjs");
  assert.match(packageJSON.scripts.check, /npm run build:tui -- --check/u);
  assert.equal(packageJSON.scripts.prepack, "npm run build:tui -- --check");
});

test("release transfers, re-verifies, publishes, and delivers the one validated tarball", () => {
  const create = releaseWorkflow.indexOf("Create and validate the one commit-bound release artifact");
  const record = releaseWorkflow.indexOf("Record release artifact provenance");
  const upload = releaseWorkflow.indexOf("Upload the exact validated artifact");
  const publishVerify = releaseWorkflow.indexOf("Verify publication artifact identity");
  const publish = releaseWorkflow.indexOf("Publish exact validated tarball to npm");
  const deliveryVerify = releaseWorkflow.indexOf("Verify delivery artifact identity");
  assert.ok(create !== -1 && create < record && record < upload && upload < publishVerify && publishVerify < publish && publish < deliveryVerify);
  assert.match(releaseWorkflow, /artifact_name: \$\{\{ steps\.artifact\.outputs\.artifact_name \}\}/u);
  assert.match(releaseWorkflow, /artifact_digest: \$\{\{ steps\.upload\.outputs\.artifact-digest \}\}/u);
  assert.equal(releaseWorkflow.match(/name: \$\{\{ needs\.validate\.outputs\.artifact_name \}\}/gu)?.length, 2);
  assert.equal(releaseWorkflow.match(/sha256sum --check --status/gu)?.length, 4);
  assert.match(releaseWorkflow, /npm publish "\$TARBALL"/u);
  assert.match(releaseWorkflow, /gh release create[\s\S]*"\$TARBALL"[\s\S]*"\$PROVENANCE#release provenance"/u);
  assert.doesNotMatch(releaseWorkflow, /run: npm publish\s*$/mu);
  assert.match(releaseArtifactScript, /sha256/u);
  assert.match(releaseArtifactScript, /provenanceSha256/u);
  assert.match(releaseArtifactScript, /inventorySha256/u);
  assert.match(releaseArtifactScript, /commit/u);
  assert.match(releaseArtifactScript, /rmSync\(tempRoot/u);
  assert.equal(releaseArtifactScript.match(/"pack",/gu)?.length, 1);
  assert.match(releaseArtifactScript, /assertCleanCheckout\(checkoutStatus\(repoRoot\), "after packing and consumer validation"\)/u);
});

test("release reconciles partial external state without widening privileged jobs", () => {
  const validate = releaseJobSource("validate", "publish");
  const publish = releaseJobSource("publish", "deliver");
  const deliver = releaseJobSource("deliver");

  assert.match(validate, /Classify npm publication state/u);
  assert.match(validate, /Plan release reconciliation/u);
  assert.match(validate, /HTTP 404/u);
  assert.match(validate, /code E404/u);
  assert.match(validate, /if: steps\.reconciliation\.outputs\.publish == 'true' \|\| steps\.reconciliation\.outputs\.create_release == 'true'/u);
  assert.doesNotMatch(validate, /npm publish|gh api --method POST|gh release create/u);
  assert.match(publish, /if: needs\.validate\.outputs\.publish == 'true'/u);
  assert.match(deliver, /needs\.validate\.outputs\.create_tag == 'true' \|\| needs\.validate\.outputs\.create_release == 'true'/u);
  assert.match(deliver, /if: needs\.validate\.outputs\.create_tag == 'true'/u);
  assert.match(deliver, /if: needs\.validate\.outputs\.create_release == 'true'/u);
  assert.doesNotMatch(publish, /contents: write/u);
  assert.doesNotMatch(deliver, /id-token: write|npm publish/u);
});
