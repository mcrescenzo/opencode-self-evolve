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
    reviewDate: "2026-09-05",
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

test("changed advisory metadata fails closed before an exception is considered", () => {
  const changed = JSON.parse(auditReport);
  changed["@babel/core"][0].vulnerable_versions = "<=7.30.0";
  assert.throws(() => evaluateAudit({ stdout: JSON.stringify(changed), lock }), /metadata changed/u);
});
