import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { asPath } from "./self-evolve-schemas.js";

const MUST_NOT_EXIST = "must-not-exist";
const MAX_EDIT_GROWTH = 8 * 1024;
const MAX_FILE_BYTES = 64 * 1024;
const GLOB_RE = /[*?[]/;
const LOGICAL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const UNSAFE_SCHEME_RE = /(?:\]\(\s*|\b)(?:javascript|data|vbscript|file):/iu;
const PRIVATE_KEY_MARKER_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|-----END [A-Z ]*PRIVATE KEY-----/g;
const COMMON_PROVIDER_TOKEN_RE = /\b(?:AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|sk-(?:proj|svcacct|ant-api03)-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[a-z]-[A-Za-z0-9-]{10,}|xapp-\d-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{20,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|dop_v1_[A-Fa-f0-9]{32,})\b/g;
const INJECTION_PATTERNS = [
  ["ignore-prior-instructions", /\bignore (?:all |any )?(?:prior|previous|earlier) instructions\b/iu],
  ["system-override", /\bsystem\s*(?::|\s+(?:prompt\s+)?override\b)/iu],
  ["apply-authority-escalation", /\byou must now apply\b/iu],
  ["mode-authority-escalation", /\byou are now in (?:auto|yolo) mode\b/iu],
];
const rootScopes = new WeakMap();
const inventoryScopes = new WeakMap();

function compareCodepoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function rootInput(entry) {
  return typeof entry === "string" ? { root: entry, boundary: null } : {
    root: entry?.path ?? entry?.root,
    boundary: entry?.configRoot ?? entry?.boundary ?? null,
  };
}

function canonicalizeRoot(entry, scope, projectRoot, errors) {
  const { root, boundary } = rootInput(entry);
  if (typeof root !== "string" || !root || GLOB_RE.test(root)) {
    errors.push(`${scope} skill root is invalid or contains glob characters: ${String(root)}`);
    return null;
  }
  try {
    const real = fs.realpathSync(root);
    if (real !== root) {
      errors.push(`${scope} skill root resolves through a symlink or is not canonical: ${root}`);
      return null;
    }
    if (rejectSymlinked(root)) {
      errors.push(`${scope} skill root contains a symlink: ${root}`);
      return null;
    }
    const containmentRoot = scope === "repo" ? projectRoot : boundary;
    if (containmentRoot) {
      const canonicalBoundary = fs.realpathSync(containmentRoot);
      if (canonicalBoundary !== containmentRoot || rejectSymlinked(containmentRoot) || !isPathContained(real, canonicalBoundary)) {
        errors.push(`${scope} skill root escapes its canonical boundary: ${root}`);
        return null;
      }
    }
    return real;
  } catch (error) {
    errors.push(`${scope} skill root cannot be canonicalized: ${root} (${errorText(error)})`);
    return null;
  }
}

export function loadAllowlist({ globalSkillRoots = [], repoSkillRoots = [], projectRoot } = {}) {
  const errors = [];
  const canonicalRoots = [];
  const scopes = new Map();
  let canonicalProjectRoot = null;
  if (repoSkillRoots.length) {
    try {
      canonicalProjectRoot = fs.realpathSync(projectRoot);
      if (canonicalProjectRoot !== projectRoot || rejectSymlinked(projectRoot)) throw new Error("project root is symlinked or non-canonical");
    } catch (error) {
      errors.push(`project root cannot be canonicalized: ${String(projectRoot)} (${errorText(error)})`);
    }
  }
  for (const [scope, entries] of [["global", globalSkillRoots], ["repo", repoSkillRoots]]) {
    for (const entry of entries) {
      if (scope === "repo" && !canonicalProjectRoot) continue;
      const real = canonicalizeRoot(entry, scope, canonicalProjectRoot, errors);
      if (!real) continue;
      if (scopes.has(real)) {
        if (scopes.get(real) !== scope) errors.push(`skill root is ambiguously both global and repo-scoped: ${real}`);
        continue;
      }
      canonicalRoots.push(real);
      scopes.set(real, scope);
    }
  }
  rootScopes.set(canonicalRoots, scopes);
  return { canonicalRoots, errors };
}

export function hashSkillContent(textOrBuffer) {
  return createHash("sha256").update(textOrBuffer).digest("hex");
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { return null; }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

export function parseSkillFrontmatter(text) {
  const source = String(text);
  const errors = [];
  if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) {
    return { ok: false, frontmatter: null, errors: ["frontmatter must start with ---"], bodyStart: 0 };
  }
  const firstBreak = source.indexOf("\n") + 1;
  const closing = /^(?:---|\.\.\.)\s*\r?$/gmu;
  closing.lastIndex = firstBreak;
  const match = closing.exec(source);
  if (!match) return { ok: false, frontmatter: null, errors: ["frontmatter closing delimiter is missing"], bodyStart: 0 };
  const frontmatter = {};
  const lines = source.slice(firstBreak, match.index).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const field = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(line);
    if (!field) {
      errors.push(`malformed frontmatter line ${index + 2}`);
      continue;
    }
    const [, key, raw = ""] = field;
    if (Object.hasOwn(frontmatter, key)) {
      errors.push(`duplicate frontmatter field: ${key}`);
      continue;
    }
    if (raw === "|" || raw === ">") {
      const parts = [];
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) parts.push(lines[++index].trim());
      frontmatter[key] = raw === ">" ? parts.join(" ") : parts.join("\n");
    } else {
      frontmatter[key] = parseScalar(raw);
    }
  }
  for (const field of ["name", "description"]) {
    if (typeof frontmatter[field] !== "string" || !frontmatter[field].trim()) errors.push(`frontmatter ${field} is required`);
  }
  if (typeof frontmatter.name === "string" && (/[\\/]/u.test(frontmatter.name) || GLOB_RE.test(frontmatter.name))) {
    errors.push("frontmatter name contains a path separator or glob character");
  }
  if (typeof frontmatter.description === "string") {
    if (frontmatter.description.includes("\0")) errors.push("frontmatter description contains NUL");
    if (CONTROL_RE.test(frontmatter.description)) errors.push("frontmatter description contains control characters");
    if (UNSAFE_SCHEME_RE.test(frontmatter.description)) errors.push("frontmatter description contains an unsafe link");
    if (frontmatter.description.length > 300) errors.push("frontmatter description exceeds 300 characters");
  }
  const bodyBreak = source.indexOf("\n", match.index + match[0].length);
  const bodyStart = bodyBreak === -1 ? source.length : bodyBreak + 1;
  return { ok: errors.length === 0, frontmatter, errors, bodyStart };
}

function skillRecord(canonicalRoot, logicalName, absolutePath, bytes) {
  const parsed = parseSkillFrontmatter(bytes.toString("utf8"));
  const frontmatterErrors = [...parsed.errors];
  if (parsed.frontmatter?.name && parsed.frontmatter.name !== logicalName) {
    frontmatterErrors.push(`frontmatter name does not match skill directory: ${logicalName}`);
  }
  return {
    canonicalRoot,
    relativePath: `${logicalName}/SKILL.md`,
    logicalName,
    absolutePath,
    exists: true,
    currentHash: hashSkillContent(bytes),
    sizeBytes: bytes.length,
    parsedFrontmatter: parsed.frontmatter,
    frontmatterErrors,
  };
}

export function discoverSkills(canonicalRoots) {
  const records = [];
  for (const canonicalRoot of canonicalRoots) {
    let entries;
    try {
      if (fs.realpathSync(canonicalRoot) !== canonicalRoot || rejectSymlinked(canonicalRoot)) continue;
      entries = fs.readdirSync(canonicalRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => compareCodepoints(a.name, b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const absolutePath = path.join(canonicalRoot, entry.name, "SKILL.md");
      try {
        if (rejectSymlinked(absolutePath) || !fs.lstatSync(absolutePath).isFile()) continue;
        const real = fs.realpathSync(absolutePath);
        if (real !== absolutePath || !isPathContained(real, canonicalRoot)) continue;
        records.push(skillRecord(canonicalRoot, entry.name, real, fs.readFileSync(real)));
      } catch {}
    }
  }
  inventoryScopes.set(records, rootScopes.get(canonicalRoots) ?? new Map(canonicalRoots.map((root) => [root, "unknown"])));
  return records;
}

export function isPathContained(candidateAbsPath, canonicalRoot) {
  const relative = path.relative(canonicalRoot, candidateAbsPath);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export function rejectSymlinked(segmentPath) {
  const absolute = path.resolve(segmentPath);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      return true;
    }
  }
  return false;
}

function proposalContent(proposal) {
  const content = proposal?.proposedContent;
  return typeof content === "string" || Buffer.isBuffer(content) ? content : null;
}

export function estimateGrowth(proposal, inventory) {
  const target = inventory.find((record) => record.canonicalRoot === proposal?.skillTarget?.canonicalRoot && record.relativePath === proposal?.skillTarget?.relativePath);
  const beforeBytes = target?.exists ? target.sizeBytes : 0;
  const content = proposalContent(proposal);
  const afterBytes = content === null ? Number.POSITIVE_INFINITY : Buffer.byteLength(content);
  const deltaBytes = afterBytes - beforeBytes;
  return {
    beforeBytes,
    afterBytes,
    deltaBytes,
    withinBudget: Number.isFinite(afterBytes) && Math.max(0, deltaBytes) <= MAX_EDIT_GROWTH && afterBytes <= MAX_FILE_BYTES,
    budgetMax: MAX_EDIT_GROWTH,
  };
}

export function scanForSecretCanaries(content) {
  const text = Buffer.isBuffer(content) ? content.toString("utf8") : String(content ?? "");
  const hits = [];
  for (const [label, pattern] of [["private-key-marker", PRIVATE_KEY_MARKER_RE], ["provider-token", COMMON_PROVIDER_TOKEN_RE]]) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) hits.push(label);
  }
  return { flagged: hits.length > 0, hits };
}

export function scanForUnsafeContent(content) {
  const text = Buffer.isBuffer(content) ? content.toString("utf8") : String(content ?? "");
  const issues = [];
  if (text.includes("\0")) issues.push("nul-byte");
  if (CONTROL_RE.test(text)) issues.push("control-character");
  if (UNSAFE_SCHEME_RE.test(text)) issues.push("unsafe-link");
  for (const [label, pattern] of INJECTION_PATTERNS) if (pattern.test(text)) issues.push(label);
  return { flagged: issues.length > 0, issues };
}

function globalProposalLeaksRepositoryIdentifier(proposal, scope) {
  if (scope !== "global" || !proposal || typeof proposal !== "object") return false;
  const forbiddenKey = /^(?:repository|repo|project|worktree|source)(?:id|identifier|name|path|root)$/iu;
  return Object.entries(proposal).some(([key, value]) => key !== "projectFingerprint" && forbiddenKey.test(key) && value !== null && value !== "");
}

function targetPath(relativePath) {
  const clean = asPath(relativePath);
  if (path.isAbsolute(clean) || /^[A-Za-z]:\//u.test(clean) || clean.includes("\0")) throw new TypeError("relative path must be relative and contain no NUL");
  const parts = clean.split("/");
  if (parts.length !== 2 || parts[1] !== "SKILL.md" || !parts[0] || /[\\/]/u.test(parts[0]) || GLOB_RE.test(parts[0])) {
    throw new TypeError("relative path must have the form <name>/SKILL.md");
  }
  return clean;
}

function absentRecord(root, relativePath, absolutePath, currentHash = null) {
  return {
    canonicalRoot: root,
    relativePath,
    logicalName: relativePath.split("/")[0],
    absolutePath,
    exists: false,
    currentHash,
    sizeBytes: 0,
    parsedFrontmatter: null,
    frontmatterErrors: [],
  };
}

function unresolvedTarget(reason) {
  return { ok: false, reason, target: null, inventory: null };
}

function validExistingTarget(record, logicalName) {
  if (!record || record.exists !== true || record.logicalName !== logicalName) return false;
  if (record.relativePath !== `${logicalName}/SKILL.md`) return false;
  if (typeof record.canonicalRoot !== "string" || typeof record.absolutePath !== "string") return false;
  if (record.absolutePath !== path.join(record.canonicalRoot, record.relativePath)) return false;
  if (!/^[a-f0-9]{64}$/u.test(record.currentHash)) return false;
  if (!Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 0) return false;
  if (!record.parsedFrontmatter || record.parsedFrontmatter.name !== logicalName) return false;
  if (typeof record.parsedFrontmatter.description !== "string" || !record.parsedFrontmatter.description.trim()) return false;
  return Array.isArray(record.frontmatterErrors) && record.frontmatterErrors.length === 0;
}

export function resolveSkillTarget(targetLogicalName, inventory) {
  if (typeof targetLogicalName !== "string" || targetLogicalName.length > 64 || !LOGICAL_NAME_RE.test(targetLogicalName)) {
    return unresolvedTarget(targetLogicalName === null || targetLogicalName === undefined
      ? "target-logical-name-missing"
      : "target-logical-name-invalid");
  }
  if (!Array.isArray(inventory)) return unresolvedTarget("target-inventory-invalid");

  const matches = inventory.filter((record) => record?.logicalName === targetLogicalName);
  if (matches.length > 1) return unresolvedTarget("target-inventory-match-ambiguous");
  if (matches.length === 1) {
    const target = matches[0];
    if (!validExistingTarget(target, targetLogicalName)) return unresolvedTarget("target-inventory-record-invalid");
    try {
      if (fs.realpathSync(target.canonicalRoot) !== target.canonicalRoot || rejectSymlinked(target.canonicalRoot)) {
        return unresolvedTarget("target-canonical-root-stale");
      }
      if (rejectSymlinked(target.absolutePath) || fs.realpathSync(target.absolutePath) !== target.absolutePath) {
        return unresolvedTarget("target-inventory-path-stale");
      }
      const bytes = fs.readFileSync(target.absolutePath);
      if (bytes.length !== target.sizeBytes || hashSkillContent(bytes) !== target.currentHash) {
        return unresolvedTarget("target-inventory-hash-stale");
      }
      const parsed = parseSkillFrontmatter(bytes.toString("utf8"));
      if (!parsed.ok || parsed.frontmatter?.name !== targetLogicalName) {
        return unresolvedTarget("target-inventory-record-invalid");
      }
      return { ok: true, reason: null, target: { ...target, currentContent: bytes.toString("utf8") }, inventory };
    } catch {
      return unresolvedTarget("target-inventory-path-stale");
    }
  }

  const scopeMap = inventoryScopes.get(inventory) ?? new Map();
  const repositoryRoots = [...scopeMap].filter(([, scope]) => scope === "repo").map(([root]) => root);
  if (repositoryRoots.length === 0) return unresolvedTarget("target-repository-root-unavailable");
  if (repositoryRoots.length !== 1) return unresolvedTarget("target-repository-root-ambiguous");
  const canonicalRoot = repositoryRoots[0];
  const relativePath = `${targetLogicalName}/SKILL.md`;
  const directory = path.join(canonicalRoot, targetLogicalName);
  const absolutePath = path.join(canonicalRoot, relativePath);
  try {
    if (fs.realpathSync(canonicalRoot) !== canonicalRoot || rejectSymlinked(canonicalRoot)) {
      return unresolvedTarget("target-canonical-root-stale");
    }
    if (rejectSymlinked(absolutePath)) return unresolvedTarget("target-absent-path-symlinked");
    try {
      fs.lstatSync(directory);
      return unresolvedTarget("target-absent-path-collision");
    } catch (error) {
      if (error?.code !== "ENOENT") return unresolvedTarget("target-absent-path-unavailable");
    }
    try {
      fs.lstatSync(absolutePath);
      return unresolvedTarget("target-absent-path-collision");
    } catch (error) {
      if (error?.code !== "ENOENT") return unresolvedTarget("target-absent-path-unavailable");
    }
  } catch {
    return unresolvedTarget("target-canonical-root-stale");
  }
  const target = absentRecord(canonicalRoot, relativePath, absolutePath, MUST_NOT_EXIST);
  const resolvedInventory = [...inventory, target];
  inventoryScopes.set(resolvedInventory, scopeMap);
  return { ok: true, reason: null, target, inventory: resolvedInventory };
}

export function validateProposalTarget(proposal, inventory) {
  const errors = [];
  let canonicalTarget = null;
  const scopeMap = inventoryScopes.get(inventory) ?? new Map(inventory.map((record) => [record.canonicalRoot, "unknown"]));
  const roots = [...scopeMap.keys()];
  const requestedRoot = proposal?.skillTarget?.canonicalRoot;
  if (typeof requestedRoot !== "string" || !roots.includes(requestedRoot)) errors.push("proposal targets an unknown canonical root");
  let relativePath = null;
  try { relativePath = targetPath(proposal?.skillTarget?.relativePath); } catch (error) { errors.push(errorText(error)); }
  if (errors.length) return { ok: false, errors, canonicalTarget: null };

  const candidate = path.resolve(requestedRoot, relativePath);
  if (!isPathContained(candidate, requestedRoot)) errors.push("proposal target escapes its canonical root");
  try {
    if (fs.realpathSync(requestedRoot) !== requestedRoot) errors.push("canonical root changed since discovery");
    if (rejectSymlinked(candidate)) errors.push("proposal target contains a symlink");
  } catch (error) {
    errors.push(`canonical root cannot be revalidated: ${errorText(error)}`);
  }
  if (globalProposalLeaksRepositoryIdentifier(proposal, scopeMap.get(requestedRoot))) errors.push("global proposal leaks a repository identifier");

  const matches = inventory.filter((record) => record.canonicalRoot === requestedRoot && record.relativePath === relativePath);
  if (matches.length > 1) errors.push("proposal target is ambiguous in inventory");
  let existsNow = false;
  let bytes = null;
  try {
    const stat = fs.lstatSync(candidate);
    existsNow = true;
    if (!stat.isFile()) errors.push("proposal target is not a regular file");
    const real = fs.realpathSync(candidate);
    if (real !== candidate || !isPathContained(real, requestedRoot)) errors.push("proposal target does not resolve to a real child of its root");
    bytes = fs.readFileSync(candidate);
  } catch (error) {
    if (error?.code !== "ENOENT") errors.push(`proposal target cannot be inspected: ${errorText(error)}`);
  }

  const expectedHash = proposal?.skillTarget?.currentHash;
  if (expectedHash === MUST_NOT_EXIST) {
    if (existsNow || matches.some((record) => record.exists)) errors.push("proposal requires a target that must not exist");
    canonicalTarget = absentRecord(requestedRoot, relativePath, candidate, MUST_NOT_EXIST);
  } else {
    if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/u.test(expectedHash)) errors.push("proposal currentHash must be a SHA-256 hash or must-not-exist");
    if (!existsNow || matches.length !== 1 || !matches[0].exists) errors.push("existing proposal target is missing from inventory or disk");
    if (bytes && matches.length === 1) {
      const diskHash = hashSkillContent(bytes);
      if (matches[0].currentHash !== diskHash) errors.push("inventory target hash is stale");
      if (expectedHash !== diskHash) errors.push("proposal currentHash does not match current content");
    }
    canonicalTarget = matches.length === 1 ? matches[0] : null;
  }

  const content = proposalContent(proposal);
  if (content === null) errors.push("proposal proposedContent is required");
  else {
    const contentHash = hashSkillContent(content);
    if (proposal?.proposedContentHash !== contentHash) errors.push("proposal proposedContentHash does not match proposedContent");
    const frontmatter = parseSkillFrontmatter(Buffer.isBuffer(content) ? content.toString("utf8") : content);
    if (!frontmatter.ok) errors.push(...frontmatter.errors.map((error) => `proposed content: ${error}`));
    if (frontmatter.frontmatter?.name && frontmatter.frontmatter.name !== relativePath.split("/")[0]) errors.push("proposed content name does not match target directory");
    const secrets = scanForSecretCanaries(content);
    if (secrets.flagged) errors.push(`proposed content contains secret canaries: ${secrets.hits.join(", ")}`);
    const unsafe = scanForUnsafeContent(content);
    if (unsafe.flagged) errors.push(`proposed content is unsafe: ${unsafe.issues.join(", ")}`);
  }
  const growth = estimateGrowth(proposal, inventory);
  if (!growth.withinBudget) errors.push(`proposal exceeds growth budget (${growth.deltaBytes} byte delta, ${growth.afterBytes} byte file)`);
  if (errors.length || !canonicalTarget) return { ok: false, errors, canonicalTarget: null };
  return { ok: true, errors: [], canonicalTarget };
}
