import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const exceptionRoot = path.join(repoRoot, "security/audit-exceptions");
const MAX_EXCEPTION_FILES = 32;
const MAX_EXCEPTION_BYTES = 16 * 1024;

const ADVISORY_POLICIES = Object.freeze({
  "https://github.com/advisories/GHSA-4x5r-pxfx-6jf8": Object.freeze({
    package: "@babel/core",
    severity: "low",
    vulnerableVersions: "<=7.29.0",
    installedVersion: "7.28.0",
    dependencyPaths: Object.freeze([
      "root > @opentui/solid@0.4.5 > @babel/core@7.28.0",
    ]),
    applicability: "trusted-repository-source-only",
    fixedVersions: Object.freeze(["7.29.6"]),
  }),
});

const EXCEPTION_KEYS = Object.freeze([
  "advisoryUrl",
  "package",
  "installedVersion",
  "dependencyPaths",
  "applicability",
  "scope",
  "owner",
  "reviewDate",
  "expiresOn",
]);

function fail(message) {
  throw new Error(message);
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function boundedString(value, label, max = 1024) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.trim() !== value) {
    fail(`${label} must be a non-empty trimmed string of at most ${max} characters`);
  }
  return value;
}

function parseVersion(version, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(version);
  if (!match) fail(`${label} is not a supported exact semantic version: ${version}`);
  return { numbers: match.slice(1, 4).map(Number), prerelease: match[4] ?? null };
}

function compareVersions(left, right) {
  const a = parseVersion(left, "installed version");
  const b = parseVersion(right, "advisory version");
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] < b.numbers[index] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease.localeCompare(b.prerelease, "en", { numeric: true });
}

export function isVersionAffected(version, range) {
  const alternatives = boundedString(range, "vulnerable_versions", 256).split("||").map((part) => part.trim());
  return alternatives.some((alternative) => {
    const clauses = alternative.split(/[ ,]+/u).filter(Boolean);
    if (!clauses.length) fail(`unsupported vulnerable_versions range: ${range}`);
    return clauses.every((clause) => {
      const match = /^(<=|>=|<|>|=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(clause);
      if (!match) fail(`unsupported vulnerable_versions range: ${range}`);
      const comparison = compareVersions(version, match[2]);
      return ({ "<": comparison < 0, "<=": comparison <= 0, ">": comparison > 0, ">=": comparison >= 0, "=": comparison === 0 })[match[1] ?? "="];
    });
  });
}

function packageVersion(name, record) {
  if (!Array.isArray(record) || typeof record[0] !== "string" || !record[0].startsWith(`${name}@`)) {
    fail(`bun.lock package record for ${name} is malformed`);
  }
  return record[0].slice(name.length + 1);
}

export function dependencyPaths(lock, targetName) {
  plainObject(lock, "bun.lock");
  const workspace = plainObject(lock.workspaces?.[""], "bun.lock root workspace");
  const packages = plainObject(lock.packages, "bun.lock packages");
  const roots = Object.keys(plainObject(workspace.devDependencies, "bun.lock root devDependencies")).sort();
  const results = [];

  function visit(name, pathParts, visited) {
    if (visited.has(name)) return;
    const record = packages[name];
    if (!record) fail(`bun.lock has no package record for ${name}`);
    const version = packageVersion(name, record);
    const nextPath = [...pathParts, `${name}@${version}`];
    if (name === targetName) {
      results.push(`root > ${nextPath.join(" > ")}`);
      if (results.length > 256) fail(`bun.lock has too many paths to ${targetName}`);
      return;
    }
    const metadata = record[2] === undefined ? {} : plainObject(record[2], `bun.lock metadata for ${name}`);
    const dependencies = metadata.dependencies === undefined ? {} : plainObject(metadata.dependencies, `bun.lock dependencies for ${name}`);
    const nextVisited = new Set(visited).add(name);
    for (const dependency of Object.keys(dependencies).sort()) visit(dependency, nextPath, nextVisited);
  }

  for (const name of roots) visit(name, [], new Set());
  return [...new Set(results)].sort();
}

export function parseAuditOutput(stdout) {
  if (typeof stdout !== "string" || stdout.length > 1024 * 1024) fail("bun audit stdout must be bounded JSON text");
  let report;
  try { report = JSON.parse(stdout); } catch { fail("bun audit --json did not produce valid JSON on stdout"); }
  plainObject(report, "bun audit report");
  const entries = Object.entries(report);
  if (entries.length > 256) fail("bun audit report contains too many packages");
  const findings = [];
  for (const [packageName, packageFindings] of entries) {
    boundedString(packageName, "audit package", 214);
    if (!Array.isArray(packageFindings) || packageFindings.length > 256) fail(`audit findings for ${packageName} must be a bounded array`);
    for (const finding of packageFindings) {
      plainObject(finding, `audit finding for ${packageName}`);
      if (!Number.isSafeInteger(finding.id) || finding.id < 1) fail(`audit finding for ${packageName} has an invalid id`);
      boundedString(finding.url, "advisory URL", 256);
      boundedString(finding.title, "advisory title", 512);
      if (!["low", "moderate", "high", "critical"].includes(finding.severity)) fail(`audit finding for ${packageName} has an invalid severity`);
      boundedString(finding.vulnerable_versions, "vulnerable_versions", 256);
      findings.push({ packageName, ...finding });
    }
  }
  return findings;
}

export function parseBunLock(source) {
  if (typeof source !== "string" || source.length > 16 * 1024 * 1024) fail("bun.lock must be bounded text");
  let normalized = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      normalized += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      normalized += character;
      continue;
    }
    if (character === ",") {
      let next = index + 1;
      while (/\s/u.test(source[next] ?? "")) next += 1;
      if (source[next] === "}" || source[next] === "]") continue;
    }
    normalized += character;
  }
  if (inString) fail("bun.lock contains an unterminated string");
  try { return JSON.parse(normalized); } catch { fail("bun.lock is not valid Bun text lockfile JSON"); }
}

function exactKeys(record, label) {
  const keys = Object.keys(record).sort();
  const expected = [...EXCEPTION_KEYS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) fail(`${label} must contain exactly: ${EXCEPTION_KEYS.join(", ")}`);
}

function isoDate(value, label) {
  boundedString(value, label, 10);
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    fail(`${label} must be an ISO calendar date`);
  }
  return value;
}

export function validateException(record, disposition, today) {
  plainObject(record, "audit exception");
  exactKeys(record, "audit exception");
  for (const key of ["advisoryUrl", "package", "installedVersion", "applicability"]) {
    if (record[key] !== disposition[key]) fail(`audit exception ${key} does not match the audited disposition`);
  }
  if (!Array.isArray(record.dependencyPaths) || JSON.stringify(record.dependencyPaths) !== JSON.stringify(disposition.dependencyPaths)) {
    fail("audit exception dependencyPaths do not exactly match bun.lock");
  }
  boundedString(record.scope, "audit exception scope", 1024);
  boundedString(record.owner, "audit exception owner", 256);
  const reviewDate = isoDate(record.reviewDate, "audit exception reviewDate");
  const expiresOn = isoDate(record.expiresOn, "audit exception expiresOn");
  if (reviewDate > expiresOn) fail("audit exception reviewDate must not be after expiresOn");
  if (expiresOn < today) fail(`audit exception expired on ${expiresOn}`);
  return record;
}

export function dispositionsFor(findings, lock) {
  return findings.map((finding) => {
    const policy = ADVISORY_POLICIES[finding.url];
    if (!policy) fail(`unrecognized advisory requires an audited policy update: ${finding.url}`);
    if (finding.packageName !== policy.package || finding.severity !== policy.severity || finding.vulnerable_versions !== policy.vulnerableVersions) {
      fail(`advisory metadata changed for ${finding.url}; review the upstream advisory`);
    }
    const paths = dependencyPaths(lock, finding.packageName);
    if (JSON.stringify(paths) !== JSON.stringify(policy.dependencyPaths)) fail(`dependency path changed for ${finding.url}; review bun.lock`);
    if (!isVersionAffected(policy.installedVersion, finding.vulnerable_versions)) fail(`installed version is outside the reported range for ${finding.url}`);
    return {
      advisoryUrl: finding.url,
      package: finding.packageName,
      installedVersion: policy.installedVersion,
      dependencyPaths: paths,
      applicability: policy.applicability,
      fixedVersions: [...policy.fixedVersions],
    };
  });
}

export function readExceptions(root = exceptionRoot) {
  if (!existsSync(root)) return [];
  const names = readdirSync(root).filter((name) => name.endsWith(".json")).sort();
  if (names.length > MAX_EXCEPTION_FILES) fail(`at most ${MAX_EXCEPTION_FILES} audit exceptions are allowed`);
  return names.map((name) => {
    if (!/^GHSA-[0-9a-z-]+\.json$/u.test(name)) fail(`invalid audit exception filename: ${name}`);
    const source = readFileSync(path.join(root, name), "utf8");
    if (Buffer.byteLength(source) > MAX_EXCEPTION_BYTES) fail(`audit exception is too large: ${name}`);
    try { return { name, record: JSON.parse(source) }; } catch { fail(`audit exception is not valid JSON: ${name}`); }
  });
}

export function evaluateAudit({ stdout, lock, exceptions = [], today = new Date().toISOString().slice(0, 10) }) {
  const findings = parseAuditOutput(stdout);
  if (!findings.length) return { findings: [], dispositions: [] };
  const dispositions = dispositionsFor(findings, lock);
  for (const disposition of dispositions) {
    const ghsa = disposition.advisoryUrl.split("/").at(-1);
    const match = exceptions.find(({ name }) => name === `${ghsa}.json`);
    if (!match) {
      fail(`unresolved ${ghsa}: ${disposition.package}@${disposition.installedVersion} via ${disposition.dependencyPaths.join("; ")}; applicability=${disposition.applicability}; fixed=${disposition.fixedVersions.join(",")}; owner-authored exception required at security/audit-exceptions/${ghsa}.json`);
    }
    validateException(match.record, disposition, today);
  }
  return { findings, dispositions };
}

function main() {
  const audit = spawnSync("bun", ["audit", "--json"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (audit.error) fail(`could not run bun audit --json: ${audit.error.message}`);
  if (audit.signal) fail(`bun audit --json terminated by ${audit.signal}`);
  const lock = parseBunLock(readFileSync(path.join(repoRoot, "bun.lock"), "utf8"));
  const result = evaluateAudit({ stdout: audit.stdout, lock, exceptions: readExceptions() });
  if (audit.status !== 0 && result.findings.length === 0) fail(`bun audit --json exited ${audit.status} without findings`);
  if (result.findings.length === 0) {
    console.log("Dependency audit passed: no findings.");
    return;
  }
  for (const disposition of result.dispositions) {
    console.log(`Dependency audit passed with owner exception: ${disposition.advisoryUrl}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`Dependency audit failed: ${error.message}`); process.exitCode = 1; }
}
