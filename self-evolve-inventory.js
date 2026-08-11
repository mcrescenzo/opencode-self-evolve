import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  asPath,
  makeCandidateTargetBinding,
  makeGlobalRootPolicy,
  makeRecommendationTargetBinding,
} from "./self-evolve-schemas.js";

const MUST_NOT_EXIST = "must-not-exist";
const MAX_EDIT_GROWTH = 8 * 1024;
const MAX_NEW_FILE_BYTES = 24 * 1024;
const MAX_FILE_BYTES = 64 * 1024;
const GLOB_RE = /[*?[]/;
const LOGICAL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
export const FATAL_CONTENT_ISSUES = new Set([
  "nul-byte",
  "control-character",
  "control-characters",
  "provider-token",
  "private-key",
  "private-key-marker",
  "prompt-injection-marker",
  "ignore-prior-instructions",
  "system-override",
  "authority-escalation",
  "apply-authority-escalation",
  "mode-authority-escalation",
  "unsafe-link",
  "javascript-link",
  "data-link",
]);
const UNSAFE_SCHEME_RE = new RegExp(
  "(?:"
    + "(?:!?\\]\\(\\s*|<[^>]*\\b(?:href|src)\\s*=\\s*[\"']?\\s*)(?:javascript|vbscript|data|file):"
    + "|"
    + "(?:^|[\\s\"'`=(])(?:javascript|vbscript):[ \\t]*\\S{2,}"
    + "|"
    + "(?:^|[\\s\"'`=(])(?:data|file):[^\\s\"'()<>]{2,}"
  + ")",
  "iu",
);
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
    if (scope === "repo"
        && error?.code === "ENOENT"
        && typeof projectRoot === "string"
        && path.resolve(root) === root
        && !rejectSymlinked(root)
        && isPathContained(root, projectRoot)) return root;
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

function catalogBlocker(code, root, details = {}) {
  const collectionName = details.collectionName;
  const logicalName = details.logicalName;
  const messages = {
    "global-root-policy-required": "An operator-approved global root policy is required before catalog discovery.",
    "global-root-policy-invalid": "The operator-approved global root policy is invalid.",
    "approved-root-noncanonical": `Approved global root is missing, symlinked, relocated, or noncanonical: ${root?.canonicalPath ?? "unknown"}`,
    "approved-root-not-directory": `Approved global root is not a directory: ${root?.canonicalPath ?? "unknown"}`,
    "approved-root-symlink-entry": `Approved global root contains a symlinked direct child: ${details.entryName ?? "unknown"}`,
    "project-root-noncanonical": "The current project root is missing, symlinked, or noncanonical, so global roots cannot be separated safely.",
    "project-skill-root-prohibited": "A project-local .opencode/skills folder cannot be an autonomous global root.",
    "nested-skill-collection-not-approved": `Approved root contains nested skill collection ${collectionName}; approve the exact collection root instead.`,
    "duplicate-global-skill-name": `Logical skill name ${logicalName} exists in more than one approved global root.`,
    "global-skill-record-invalid": `Direct global skill ${logicalName ?? details.entryName ?? "unknown"} is malformed, symlinked, or noncanonical.`,
  };
  return {
    code,
    rootId: root?.rootId ?? null,
    ...(collectionName ? { collectionName } : {}),
    ...(logicalName ? { logicalName } : {}),
    message: messages[code] ?? code,
  };
}

function globalCatalogGenerationHash(policy, records) {
  return hashSkillContent(`self-evolve-global-skill-catalog-v1\n${JSON.stringify({
    rootSetHash: policy.rootSetHash,
    records: records.map((record) => ({
      rootId: record.rootId,
      logicalName: record.logicalName,
      relativePath: record.relativePath,
      currentHash: record.currentHash,
    })),
  })}`);
}

function containsDirectSkill(collectionPath) {
  let entries;
  try { entries = fs.readdirSync(collectionPath, { withFileTypes: true }); } catch { return false; }
  return entries.some((entry) => {
    if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
    const skillPath = path.join(collectionPath, entry.name, "SKILL.md");
    try {
      return !rejectSymlinked(skillPath)
        && fs.lstatSync(skillPath).isFile()
        && fs.realpathSync(skillPath) === skillPath
        && isPathContained(skillPath, collectionPath);
    } catch {
      return false;
    }
  });
}

export function buildGlobalSkillCatalog(rootPolicy, { projectRoot = null, projectSkillRoot = null } = {}) {
  let excludedProjectSkillRoot = projectSkillRoot;
  if (excludedProjectSkillRoot === null && projectRoot !== null && projectRoot !== undefined) {
    try {
      const resolvedProjectRoot = path.resolve(projectRoot);
      const canonicalProjectRoot = fs.realpathSync(resolvedProjectRoot);
      if (canonicalProjectRoot !== resolvedProjectRoot || rejectSymlinked(resolvedProjectRoot)) {
        return { ok: false, policy: null, projectSkillRoot: null, canonicalRoots: [], records: [], catalogGenerationHash: null, blockers: [catalogBlocker("project-root-noncanonical")] };
      }
      excludedProjectSkillRoot = path.join(canonicalProjectRoot, ".opencode", "skills");
    } catch {
      return { ok: false, policy: null, projectSkillRoot: null, canonicalRoots: [], records: [], catalogGenerationHash: null, blockers: [catalogBlocker("project-root-noncanonical")] };
    }
  }
  let policy;
  try {
    if (rootPolicy === null || rootPolicy === undefined) {
      return { ok: false, policy: null, projectSkillRoot: excludedProjectSkillRoot, canonicalRoots: [], records: [], catalogGenerationHash: null, blockers: [catalogBlocker("global-root-policy-required")] };
    }
    policy = makeGlobalRootPolicy(rootPolicy);
  } catch (error) {
    return {
      ok: false,
      policy: null,
      projectSkillRoot: excludedProjectSkillRoot,
      canonicalRoots: [],
      records: [],
      catalogGenerationHash: null,
      blockers: [{ ...catalogBlocker("global-root-policy-invalid"), detail: errorText(error).slice(0, 256) }],
    };
  }

  const blockers = [];
  const records = [];
  for (const root of policy.roots) {
    if (/\/\.opencode\/skills$/u.test(root.canonicalPath)
        || (excludedProjectSkillRoot !== null && root.canonicalPath === excludedProjectSkillRoot)) {
      blockers.push(catalogBlocker("project-skill-root-prohibited", root));
      continue;
    }
    let entries;
    try {
      if (fs.realpathSync(root.canonicalPath) !== root.canonicalPath || rejectSymlinked(root.canonicalPath)) {
        blockers.push(catalogBlocker("approved-root-noncanonical", root));
        continue;
      }
      if (!fs.lstatSync(root.canonicalPath).isDirectory()) {
        blockers.push(catalogBlocker("approved-root-not-directory", root));
        continue;
      }
      entries = fs.readdirSync(root.canonicalPath, { withFileTypes: true });
    } catch {
      blockers.push(catalogBlocker("approved-root-noncanonical", root));
      continue;
    }

    for (const entry of entries.sort((left, right) => compareCodepoints(left.name, right.name))) {
      if (entry.isSymbolicLink()) {
        blockers.push(catalogBlocker("approved-root-symlink-entry", root, { entryName: entry.name }));
        continue;
      }
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(root.canonicalPath, entry.name, "SKILL.md");
      let skillExists = false;
      try {
        const stat = fs.lstatSync(skillPath);
        skillExists = true;
        if (!rejectSymlinked(skillPath) && stat.isFile()) {
          const real = fs.realpathSync(skillPath);
          if (real === skillPath && isPathContained(real, root.canonicalPath)) {
            const record = {
              ...skillRecord(root.canonicalPath, entry.name, real, fs.readFileSync(real)),
              rootId: root.rootId,
              canUpdate: root.canUpdate,
              canCreate: root.canCreate,
            };
            if (LOGICAL_NAME_RE.test(entry.name) && validExistingTarget(record, entry.name)) {
              records.push(record);
              continue;
            }
          }
        }
      } catch (error) {
        if (error?.code !== "ENOENT") skillExists = true;
      }
      if (skillExists) {
        blockers.push(catalogBlocker("global-skill-record-invalid", root, { logicalName: entry.name }));
        continue;
      }
      if (containsDirectSkill(path.join(root.canonicalPath, entry.name))) {
        blockers.push(catalogBlocker("nested-skill-collection-not-approved", root, { collectionName: entry.name }));
      }
    }
  }

  const nameCounts = new Map();
  for (const record of records) nameCounts.set(record.logicalName, (nameCounts.get(record.logicalName) ?? 0) + 1);
  for (const [logicalName, count] of [...nameCounts].sort(([left], [right]) => compareCodepoints(left, right))) {
    if (count > 1) blockers.push(catalogBlocker("duplicate-global-skill-name", null, { logicalName }));
  }

  if (blockers.length) {
    return { ok: false, policy, projectSkillRoot: excludedProjectSkillRoot, canonicalRoots: [], records: [], catalogGenerationHash: null, blockers };
  }
  const catalogGenerationHash = globalCatalogGenerationHash(policy, records);
  const canonicalRoots = policy.roots.map((root) => root.canonicalPath);
  inventoryScopes.set(records, new Map(canonicalRoots.map((root) => [root, "global"])));
  return { ok: true, policy, projectSkillRoot: excludedProjectSkillRoot, canonicalRoots, records, catalogGenerationHash, blockers: [] };
}

function normalizedSkillBody(content) {
  let body = String(content ?? "").replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  if (/^---\s*\n/u.test(body)) {
    const closing = /^---\s*$/gmu;
    closing.lastIndex = body.indexOf("\n") + 1;
    const match = closing.exec(body);
    if (match) body = body.slice(match.index + match[0].length);
  }
  return body
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/^\s*(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gmu, "")
    .replace(/[*_~`]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

export function detectGlobalSkillBodyOverlap(proposedContent, catalog, excludedTarget = null) {
  const proposedBody = normalizedSkillBody(proposedContent);
  if (!proposedBody || !Array.isArray(catalog?.records)) return [];
  const overlaps = [];
  for (const record of catalog.records) {
    if (record.canonicalRoot === excludedTarget?.canonicalRoot && record.relativePath === excludedTarget?.relativePath) continue;
    let content;
    try {
      if (rejectSymlinked(record.absolutePath) || fs.realpathSync(record.absolutePath) !== record.absolutePath) {
        throw new Error("global-skill-catalog-stale");
      }
      content = fs.readFileSync(record.absolutePath, "utf8");
      if (hashSkillContent(content) !== record.currentHash) throw new Error("global-skill-catalog-stale");
    } catch (error) {
      if (error?.message === "global-skill-catalog-stale") throw error;
      throw new Error("global-skill-catalog-stale");
    }
    const otherBody = normalizedSkillBody(content);
    const substantial = Buffer.byteLength(otherBody, "utf8") >= 160
      && otherBody.split(/\s+/u).length >= 20;
    if (otherBody && (proposedBody === otherBody || (substantial && proposedBody.includes(otherBody)))) {
      overlaps.push(record.logicalName);
    }
  }
  return overlaps.sort((left, right) => compareCodepoints(left, right));
}

function unresolvedGlobalTarget(reason) {
  return { ok: false, reason, targetKind: null, binding: null, target: null, catalog: null };
}

function refreshGlobalSkillCatalog(catalog) {
  if (!catalog?.ok || !catalog.policy || typeof catalog.catalogGenerationHash !== "string") {
    return { ok: false, reason: catalog?.blockers?.[0]?.code ?? "global-skill-catalog-invalid", catalog: null };
  }
  const refreshed = buildGlobalSkillCatalog(catalog.policy, { projectSkillRoot: catalog.projectSkillRoot ?? null });
  if (!refreshed.ok) return { ok: false, reason: refreshed.blockers[0]?.code ?? "global-skill-catalog-invalid", catalog: null };
  if (refreshed.catalogGenerationHash !== catalog.catalogGenerationHash) {
    return { ok: false, reason: "global-skill-catalog-stale", catalog: null };
  }
  return { ok: true, reason: null, catalog: refreshed };
}

export function resolveGlobalSkillCandidate(targetLogicalName, catalog) {
  if (targetLogicalName !== null
      && (typeof targetLogicalName !== "string" || targetLogicalName.length > 64 || !LOGICAL_NAME_RE.test(targetLogicalName))) {
    return unresolvedGlobalTarget(targetLogicalName === undefined ? "target-logical-name-missing" : "target-logical-name-invalid");
  }
  const current = refreshGlobalSkillCatalog(catalog);
  if (!current.ok) return unresolvedGlobalTarget(current.reason);
  const matches = targetLogicalName === null
    ? []
    : current.catalog.records.filter((record) => record.logicalName === targetLogicalName);
  if (matches.length > 1) return unresolvedGlobalTarget("duplicate-global-skill-name");
  if (matches.length === 1) {
    const target = matches[0];
    if (!target.canUpdate) return unresolvedGlobalTarget("global-skill-root-update-not-approved");
    const binding = makeCandidateTargetBinding({
      targetKind: "existing-global-skill",
      rootId: target.rootId,
      logicalName: target.logicalName,
      relativePath: target.relativePath,
      currentHash: target.currentHash,
      catalogGenerationHash: current.catalog.catalogGenerationHash,
      rootSetHash: current.catalog.policy.rootSetHash,
    }, current.catalog.policy);
    return {
      ok: true,
      reason: null,
      targetKind: binding.targetKind,
      binding,
      target: { ...target, currentContent: fs.readFileSync(target.absolutePath, "utf8") },
      catalog: current.catalog,
    };
  }
  const creationRootId = current.catalog.policy.creationRootId;
  if (creationRootId === null) return unresolvedGlobalTarget("primary-creation-root-required");
  const binding = makeCandidateTargetBinding({
    targetKind: "new-global-skill",
    rootId: creationRootId,
    logicalName: null,
    relativePath: null,
    currentHash: MUST_NOT_EXIST,
    catalogGenerationHash: current.catalog.catalogGenerationHash,
    rootSetHash: current.catalog.policy.rootSetHash,
  }, current.catalog.policy);
  return { ok: true, reason: null, targetKind: binding.targetKind, binding, target: null, catalog: current.catalog };
}

export function resolveNewGlobalSkillTarget(candidateBinding, suggestedLogicalName, catalog) {
  if (typeof suggestedLogicalName !== "string"
      || suggestedLogicalName.length > 64
      || !LOGICAL_NAME_RE.test(suggestedLogicalName)) {
    return unresolvedGlobalTarget("target-logical-name-invalid");
  }
  const current = refreshGlobalSkillCatalog(catalog);
  if (!current.ok) return unresolvedGlobalTarget(current.reason);
  let candidate;
  try {
    candidate = makeCandidateTargetBinding(candidateBinding, current.catalog.policy);
  } catch (error) {
    return unresolvedGlobalTarget(errorText(error).split(":", 1)[0] || "candidate-target-binding-invalid");
  }
  if (candidate.targetKind !== "new-global-skill") return unresolvedGlobalTarget("candidate-target-kind-mismatch");
  if (candidate.catalogGenerationHash !== current.catalog.catalogGenerationHash) {
    return unresolvedGlobalTarget("global-skill-catalog-stale");
  }
  if (current.catalog.records.some((record) => record.logicalName === suggestedLogicalName)) {
    return unresolvedGlobalTarget("new-global-skill-logical-name-collision");
  }
  const root = current.catalog.policy.roots.find((item) => item.rootId === candidate.rootId);
  if (!root || !root.canCreate || current.catalog.policy.creationRootId !== root.rootId) {
    return unresolvedGlobalTarget("primary-creation-root-mismatch");
  }
  const relativePath = `${suggestedLogicalName}/SKILL.md`;
  const directory = path.join(root.canonicalPath, suggestedLogicalName);
  const absolutePath = path.join(root.canonicalPath, relativePath);
  if (!isPathContained(directory, root.canonicalPath) || !isPathContained(absolutePath, root.canonicalPath)) {
    return unresolvedGlobalTarget("new-global-skill-path-escape");
  }
  if (rejectSymlinked(directory) || rejectSymlinked(absolutePath)) {
    return unresolvedGlobalTarget("new-global-skill-path-symlinked");
  }
  for (const candidatePath of [directory, absolutePath]) {
    try {
      fs.lstatSync(candidatePath);
      return unresolvedGlobalTarget("new-global-skill-path-collision");
    } catch (error) {
      if (error?.code !== "ENOENT") return unresolvedGlobalTarget("new-global-skill-path-unavailable");
    }
  }
  let binding;
  try {
    binding = makeRecommendationTargetBinding({
      targetKind: "new-global-skill",
      rootId: root.rootId,
      logicalName: suggestedLogicalName,
      relativePath,
      currentHash: MUST_NOT_EXIST,
      catalogGenerationHash: current.catalog.catalogGenerationHash,
      rootSetHash: current.catalog.policy.rootSetHash,
      candidateBindingHash: candidate.bindingHash,
    }, candidate, current.catalog.policy);
  } catch (error) {
    return unresolvedGlobalTarget(errorText(error).split(":", 1)[0] || "recommendation-target-binding-invalid");
  }
  const target = {
    ...absentRecord(root.canonicalPath, relativePath, absolutePath, MUST_NOT_EXIST),
    rootId: root.rootId,
    canUpdate: root.canUpdate,
    canCreate: root.canCreate,
  };
  return { ok: true, reason: null, targetKind: binding.targetKind, binding, target, catalog: current.catalog };
}

export function resolveGlobalRecommendationTarget(targetBinding, rootPolicy, {
  action,
  proposedContentHash,
  projectSkillRoot = null,
  preparedNewTarget = null,
} = {}) {
  if (!["apply", "undo"].includes(action) || !/^[a-f0-9]{64}$/u.test(String(proposedContentHash))) {
    return unresolvedGlobalTarget("global-decision-target-input-invalid");
  }
  let policy;
  let binding;
  try {
    policy = makeGlobalRootPolicy(rootPolicy);
    const candidate = makeCandidateTargetBinding({
      targetKind: targetBinding?.targetKind,
      rootId: targetBinding?.rootId,
      logicalName: targetBinding?.targetKind === "new-global-skill" ? null : targetBinding?.logicalName,
      relativePath: targetBinding?.targetKind === "new-global-skill" ? null : targetBinding?.relativePath,
      currentHash: targetBinding?.currentHash,
      catalogGenerationHash: targetBinding?.catalogGenerationHash,
      rootSetHash: targetBinding?.rootSetHash,
      bindingHash: targetBinding?.candidateBindingHash,
    }, policy);
    binding = makeRecommendationTargetBinding(targetBinding, candidate, policy);
  } catch (error) {
    return unresolvedGlobalTarget(errorText(error).split(":", 1)[0] || "recommendation-target-binding-invalid");
  }
  const catalog = buildGlobalSkillCatalog(policy, { projectSkillRoot });
  if (!catalog.ok) return unresolvedGlobalTarget(catalog.blockers[0]?.code ?? "global-skill-catalog-invalid");
  const root = policy.roots.find((item) => item.rootId === binding.rootId);
  if (!root) return unresolvedGlobalTarget("unapproved-global-root");
  const matches = catalog.records.filter((record) => record.logicalName === binding.logicalName);

  if (action === "apply") {
    if (catalog.catalogGenerationHash !== binding.catalogGenerationHash) return unresolvedGlobalTarget("global-skill-catalog-stale");
    if (binding.targetKind === "existing-global-skill") {
      if (matches.length !== 1 || matches[0].rootId !== binding.rootId
          || matches[0].relativePath !== binding.relativePath || matches[0].currentHash !== binding.currentHash) {
        return unresolvedGlobalTarget(matches.length > 1 ? "duplicate-global-skill-name" : "global-recommendation-target-stale");
      }
      return { ok: true, reason: null, targetKind: binding.targetKind, binding, target: matches[0], catalog };
    }
    if (matches.length) return unresolvedGlobalTarget("new-global-skill-logical-name-collision");
    const directory = path.join(root.canonicalPath, binding.logicalName);
    const absolutePath = path.join(root.canonicalPath, binding.relativePath);
    if (!isPathContained(directory, root.canonicalPath) || !isPathContained(absolutePath, root.canonicalPath)) {
      return unresolvedGlobalTarget("new-global-skill-path-escape");
    }
    if (rejectSymlinked(directory) || rejectSymlinked(absolutePath)) return unresolvedGlobalTarget("new-global-skill-path-symlinked");
    if (preparedNewTarget !== null) {
      if (!preparedNewTarget || typeof preparedNewTarget !== "object" || Array.isArray(preparedNewTarget)
          || Object.keys(preparedNewTarget).sort().join(",") !== "expectedHash,temporaryName"
          || typeof preparedNewTarget.temporaryName !== "string"
          || preparedNewTarget.temporaryName.includes("/") || preparedNewTarget.temporaryName.includes("\\")
          || !/^[a-f0-9]{64}$/u.test(String(preparedNewTarget.expectedHash))) {
        return unresolvedGlobalTarget("new-global-skill-preparation-invalid");
      }
      const temporary = path.join(directory, preparedNewTarget.temporaryName);
      try {
        const directoryStat = fs.lstatSync(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || fs.realpathSync(directory) !== directory
            || !isPathContained(directory, root.canonicalPath)) return unresolvedGlobalTarget("new-global-skill-path-symlinked");
        const entries = fs.readdirSync(directory);
        if (entries.length !== 1 || entries[0] !== preparedNewTarget.temporaryName) {
          return unresolvedGlobalTarget("new-global-skill-path-collision");
        }
        const temporaryStat = fs.lstatSync(temporary);
        if (!temporaryStat.isFile() || temporaryStat.isSymbolicLink() || temporaryStat.nlink !== 1
            || fs.realpathSync(temporary) !== temporary || hashSkillContent(fs.readFileSync(temporary)) !== preparedNewTarget.expectedHash) {
          return unresolvedGlobalTarget("new-global-skill-preparation-invalid");
        }
        try {
          fs.lstatSync(absolutePath);
          return unresolvedGlobalTarget("new-global-skill-path-collision");
        } catch (error) {
          if (error?.code !== "ENOENT") return unresolvedGlobalTarget("new-global-skill-path-unavailable");
        }
      } catch (error) {
        if (error?.code === "ENOENT") return unresolvedGlobalTarget("new-global-skill-preparation-missing");
        return unresolvedGlobalTarget("new-global-skill-path-unavailable");
      }
    } else for (const candidatePath of [directory, absolutePath]) {
      try {
        fs.lstatSync(candidatePath);
        return unresolvedGlobalTarget("new-global-skill-path-collision");
      } catch (error) {
        if (error?.code !== "ENOENT") return unresolvedGlobalTarget("new-global-skill-path-unavailable");
      }
    }
    return {
      ok: true,
      reason: null,
      targetKind: binding.targetKind,
      binding,
      target: {
        ...absentRecord(root.canonicalPath, binding.relativePath, absolutePath, MUST_NOT_EXIST),
        rootId: root.rootId,
        canUpdate: root.canUpdate,
        canCreate: root.canCreate,
      },
      catalog,
    };
  }

  if (matches.length !== 1 || matches[0].rootId !== binding.rootId
      || matches[0].relativePath !== binding.relativePath || matches[0].currentHash !== proposedContentHash) {
    return unresolvedGlobalTarget(matches.length > 1 ? "duplicate-global-skill-name" : "global-undo-target-stale");
  }
  const baselineRecords = binding.targetKind === "new-global-skill"
    ? catalog.records.filter((record) => record !== matches[0])
    : catalog.records.map((record) => record === matches[0] ? { ...record, currentHash: binding.currentHash } : record);
  if (globalCatalogGenerationHash(policy, baselineRecords) !== binding.catalogGenerationHash) {
    return unresolvedGlobalTarget("global-skill-catalog-stale");
  }
  return { ok: true, reason: null, targetKind: binding.targetKind, binding, target: matches[0], catalog };
}

export function scopeOf(inventory, canonicalRoot) {
  return inventoryScopes.get(inventory)?.get(canonicalRoot) ?? null;
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
    withinBudget: Number.isFinite(afterBytes)
      && afterBytes <= MAX_FILE_BYTES
      && (target?.exists ? Math.max(0, deltaBytes) <= MAX_EDIT_GROWTH : afterBytes <= MAX_NEW_FILE_BYTES),
    budgetMax: target?.exists ? MAX_EDIT_GROWTH : MAX_NEW_FILE_BYTES,
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
    try {
      if (fs.realpathSync(canonicalRoot) !== canonicalRoot || rejectSymlinked(canonicalRoot)) {
        return unresolvedTarget("target-canonical-root-stale");
      }
    } catch (error) {
      if (error?.code !== "ENOENT" || rejectSymlinked(canonicalRoot)) {
        return unresolvedTarget("target-canonical-root-stale");
      }
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
  const contentAdvisories = [];
  let canonicalTarget = null;
  const scopeMap = inventoryScopes.get(inventory) ?? new Map(inventory.map((record) => [record.canonicalRoot, "unknown"]));
  const roots = [...scopeMap.keys()];
  const requestedRoot = proposal?.skillTarget?.canonicalRoot;
  if (typeof requestedRoot !== "string" || !roots.includes(requestedRoot)) errors.push("proposal targets an unknown canonical root");
  let relativePath = null;
  try { relativePath = targetPath(proposal?.skillTarget?.relativePath); } catch (error) { errors.push(errorText(error)); }
  if (errors.length) return { ok: false, errors, canonicalTarget: null, contentAdvisories };

  const candidate = path.resolve(requestedRoot, relativePath);
  if (!isPathContained(candidate, requestedRoot)) errors.push("proposal target escapes its canonical root");
  try {
    if (fs.realpathSync(requestedRoot) !== requestedRoot) errors.push("canonical root changed since discovery");
  } catch (error) {
    const prospectiveRepoRoot = error?.code === "ENOENT"
      && scopeMap.get(requestedRoot) === "repo"
      && !rejectSymlinked(requestedRoot);
    if (!prospectiveRepoRoot) errors.push(`canonical root cannot be revalidated: ${errorText(error)}`);
  }
  if (rejectSymlinked(candidate)) errors.push("proposal target contains a symlink");
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
    const fatalSecrets = secrets.hits.filter((issue) => FATAL_CONTENT_ISSUES.has(issue));
    contentAdvisories.push(...secrets.hits.filter((issue) => !FATAL_CONTENT_ISSUES.has(issue)));
    if (fatalSecrets.length) errors.push(`proposed content contains secret canaries: ${fatalSecrets.join(", ")}`);
    const unsafe = scanForUnsafeContent(content);
    const fatalUnsafe = unsafe.issues.filter((issue) => FATAL_CONTENT_ISSUES.has(issue));
    contentAdvisories.push(...unsafe.issues.filter((issue) => !FATAL_CONTENT_ISSUES.has(issue)));
    if (fatalUnsafe.length) errors.push(`proposed content is unsafe: ${fatalUnsafe.join(", ")}`);
  }
  const growth = estimateGrowth(proposal, inventory);
  if (!growth.withinBudget) errors.push(`proposal exceeds growth budget (${growth.deltaBytes} byte delta, ${growth.afterBytes} byte file, ${growth.budgetMax} byte budget)`);
  const uniqueAdvisories = [...new Set(contentAdvisories)];
  if (errors.length || !canonicalTarget) return { ok: false, errors, canonicalTarget: null, contentAdvisories: uniqueAdvisories };
  return { ok: true, errors: [], canonicalTarget, contentAdvisories: uniqueAdvisories };
}
