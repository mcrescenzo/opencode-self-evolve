import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  dependencyPaths,
  evaluateAudit,
  isVersionAffected,
  parseAuditOutput,
  parseBunLock,
  validateException,
} from "../scripts/audit-dependencies.mjs";

const root = path.resolve(import.meta.dirname, "..");
const lock = parseBunLock(readFileSync(path.join(root, "bun.lock"), "utf8"));
const auditReport = JSON.stringify({
  "@babel/core": [{
    id: 1123528,
    url: "https://github.com/advisories/GHSA-4x5r-pxfx-6jf8",
    title: "@babel/core: Arbitrary File Read via sourceMappingURL Comment",
    severity: "low",
    vulnerable_versions: "<=7.29.0",
    cwe: ["CWE-22", "CWE-200"],
  }],
});

test("Dependabot monitors the Bun lockfile weekly", () => {
  const source = readFileSync(path.join(root, ".github/dependabot.yml"), "utf8");
  assert.match(source, /- package-ecosystem: bun\n    directory: \/\n    schedule:\n      interval: weekly/u);
});

test("audit parser rejects non-JSON output and accepts an empty report", () => {
  assert.throws(() => parseAuditOutput("bun audit found nothing"), /valid JSON/u);
  assert.deepEqual(parseAuditOutput("{}"), []);
  assert.deepEqual(evaluateAudit({ stdout: "{}", lock }), { findings: [], dispositions: [] });
});

test("Bun text lockfile parser handles trailing commas without changing strings", () => {
  assert.deepEqual(parseBunLock('{"value": "comma,}", "items": [1,],}'), { value: "comma,}", items: [1] });
  assert.throws(() => parseBunLock('{"broken":]'), /not valid Bun text lockfile JSON/u);
});

test("current advisory is applicable to the exact locked dependency path", () => {
  assert.equal(isVersionAffected("7.28.0", "<=7.29.0"), true);
  assert.equal(isVersionAffected("7.29.6", "<=7.29.0"), false);
  assert.deepEqual(dependencyPaths(lock, "@babel/core"), [
    "root > @opentui/solid@0.4.5 > @babel/core@7.28.0",
  ]);
  assert.throws(
    () => evaluateAudit({ stdout: auditReport, lock, exceptions: [], today: "2026-08-05" }),
    /unresolved GHSA-4x5r-pxfx-6jf8:.*owner-authored exception required/u,
  );
});

test("only an exact, bounded, unexpired owner disposition satisfies a finding", () => {
  const disposition = {
    advisoryUrl: "https://github.com/advisories/GHSA-4x5r-pxfx-6jf8",
    package: "@babel/core",
    installedVersion: "7.28.0",
    dependencyPaths: ["root > @opentui/solid@0.4.5 > @babel/core@7.28.0"],
    applicability: "trusted-repository-source-only",
  };
  const record = {
    ...disposition,
    scope: "TUI compilation of trusted repository source only.",
    owner: "repository-owner",
    reviewDate: "2026-08-05",
    expiresOn: "2026-10-05",
  };
  assert.equal(validateException(record, disposition, "2026-08-05"), record);
  assert.throws(() => validateException({ ...record, reviewDate: "2026-08-01", expiresOn: "2026-08-04" }, disposition, "2026-08-05"), /expired/u);
  assert.throws(() => validateException({ ...record, reviewDate: "2026-02-31" }, disposition, "2026-08-05"), /ISO calendar date/u);
  assert.throws(() => validateException({ ...record, dependencyPaths: ["root > @babel/core@7.28.0"] }, disposition, "2026-08-05"), /exactly match bun\.lock/u);
  assert.throws(() => validateException({ ...record, approval: "agent" }, disposition, "2026-08-05"), /must contain exactly/u);

  const result = evaluateAudit({
    stdout: auditReport,
    lock,
    exceptions: [{ name: "GHSA-4x5r-pxfx-6jf8.json", record }],
    today: "2026-08-05",
  });
  assert.equal(result.findings.length, 1);
});

test("reviewDate must be on or before the evaluation date (H15-003)", () => {
  const disposition = {
    advisoryUrl: "https://github.com/advisories/GHSA-4x5r-pxfx-6jf8",
    package: "@babel/core",
    installedVersion: "7.28.0",
    dependencyPaths: ["root > @opentui/solid@0.4.5 > @babel/core@7.28.0"],
    applicability: "trusted-repository-source-only",
  };
  const base = {
    ...disposition,
    scope: "TUI compilation of trusted repository source only.",
    owner: "repository-owner",
    expiresOn: "2026-10-05",
  };
  const today = "2026-08-12";
  // reviewDate == today is accepted.
  assert.deepEqual(validateException({ ...base, reviewDate: today }, disposition, today), { ...base, reviewDate: today });
  // Any past reviewDate is accepted.
  assert.deepEqual(validateException({ ...base, reviewDate: "2026-08-11" }, disposition, today), { ...base, reviewDate: "2026-08-11" });
  assert.deepEqual(validateException({ ...base, reviewDate: "2026-01-01" }, disposition, today), { ...base, reviewDate: "2026-01-01" });
  // reviewDate one day in the future is rejected.
  assert.throws(
    () => validateException({ ...base, reviewDate: "2026-08-13" }, disposition, today),
    /reviewDate must not be in the future: 2026-08-13 > 2026-08-12/u,
  );
  // A far-future "due date" style reviewDate is rejected (the H15-003 defect shape).
  assert.throws(
    () => validateException({ ...base, reviewDate: "2026-09-05" }, disposition, today),
    /reviewDate must not be in the future/u,
  );
  // The full evaluateAudit path also fails closed on a future reviewDate.
  assert.throws(
    () => evaluateAudit({
      stdout: auditReport,
      lock,
      exceptions: [{ name: "GHSA-4x5r-pxfx-6jf8.json", record: { ...base, reviewDate: "2026-09-05" } }],
      today,
    }),
    /reviewDate must not be in the future/u,
  );
});

test("changed advisory metadata fails closed before an exception is considered", () => {
  const changed = JSON.parse(auditReport);
  changed["@babel/core"][0].vulnerable_versions = "<=7.30.0";
  assert.throws(() => evaluateAudit({ stdout: JSON.stringify(changed), lock }), /metadata changed/u);
});

test("dependency audit is a mandatory publication gate wired into pack and release", () => {
  // The pack/release publication path must invoke `npm run audit:dependencies`
  // and fail closed before any pack operation. This static source check keeps
  // the gate wired; the full pack:check E2E behavior is exercised separately
  // by tests/pack-artifact-check.test.mjs. The audit runs AFTER the Node-only
  // structural/TUI checks (which test fixtures may deliberately fail early and
  // which must precede any `npm` invocation) and immediately BEFORE any
  // `npm pack` operation.
  const packCheck = readFileSync(path.join(root, "scripts", "pack-artifact-check.mjs"), "utf8");
  const releaseArtifact = readFileSync(path.join(root, "scripts", "release-artifact.mjs"), "utf8");

  // pack-artifact-check exports the shared gate helper and calls it from main()
  // after the TUI checks and before npm pack.
  assert.match(packCheck, /export function runDependencyAudit\(repoRoot/u);
  const packMainStart = packCheck.indexOf("export async function main(");
  const packManifestCall = packCheck.indexOf("assertPublicFilesManifest(packageJSON)", packMainStart);
  const packTuiCheckCall = packCheck.indexOf("assertCurrentTuiArtifact(", packMainStart);
  const packAuditCall = packCheck.indexOf("runDependencyAudit(repoRoot", packMainStart);
  const packPackCall = packCheck.indexOf('run("npm", ["pack"', packMainStart);
  assert.ok(packMainStart !== -1 && packManifestCall !== -1 && packTuiCheckCall !== -1 && packAuditCall !== -1 && packPackCall !== -1, "pack main() must run manifest, TUI, audit, and npm pack");
  assert.ok(packManifestCall < packTuiCheckCall, "manifest check must precede TUI check");
  assert.ok(packTuiCheckCall < packAuditCall, "TUI check must precede dependency audit (Node-only structural checks run before any npm invocation)");
  assert.ok(packAuditCall < packPackCall, "dependency audit must precede npm pack");

  // release-artifact imports the helper and calls it from createReleaseArtifact()
  // after the TUI/commit/checkout gates and before npm pack.
  assert.match(releaseArtifact, /import \{[\s\S]*runDependencyAudit[\s\S]*\} from "\.\/pack-artifact-check\.mjs";/u);
  const releaseFnStart = releaseArtifact.indexOf("export function createReleaseArtifact(");
  const releaseTuiCall = releaseArtifact.indexOf("checkTuiArtifact({ root: repoRoot", releaseFnStart);
  const releaseCleanCall = releaseArtifact.indexOf('assertCleanCheckout(checkoutStatus(repoRoot), "before packing")', releaseFnStart);
  const releaseAuditCall = releaseArtifact.indexOf("runDependencyAudit(repoRoot", releaseFnStart);
  const releasePackCall = releaseArtifact.indexOf('run("npm", [\n    "pack"', releaseFnStart);
  assert.ok(releaseFnStart !== -1 && releaseTuiCall !== -1 && releaseCleanCall !== -1 && releaseAuditCall !== -1 && releasePackCall !== -1, "release createReleaseArtifact() must run TUI check, clean checkout, dependency audit, and npm pack");
  assert.ok(releaseTuiCall < releaseCleanCall && releaseCleanCall < releaseAuditCall, "TUI/commit/checkout gates must precede dependency audit");
  assert.ok(releaseAuditCall < releasePackCall, "dependency audit must precede npm pack");

  // package.json exposes the script the gate invokes.
  const packageJSON = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(packageJSON.scripts["audit:dependencies"], "node scripts/audit-dependencies.mjs");
});
