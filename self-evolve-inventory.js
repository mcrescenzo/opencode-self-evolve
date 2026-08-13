import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  asPath,
  canonicalize,
  DEFAULT_CATALOG_LIMITS,
  makeApprovedGlobalRoot,
  makeCandidateTargetBinding,
  makeCatalogLimits,
  makeGlobalRootPolicy,
  makeRecommendationTargetBinding,
} from "./self-evolve-schemas.js";

const MUST_NOT_EXIST = "must-not-exist";
const MAX_EDIT_GROWTH = 8 * 1024;
const MAX_NEW_FILE_BYTES = 24 * 1024;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_HOST_RESPONSE_BYTES = 1024 * 1024;
const MAX_HOST_SKILLS = 4096;
const HOST_FETCH_TIMEOUT_MS = 5000;
const HOST_PATH_FIELDS = Object.freeze(["home", "state", "config", "worktree", "directory"]);
const HOST_SKILL_FIELDS = Object.freeze(["name", "description", "location", "content"]);
const HOST_VERSION_RE = /^1\.18\.(?:[3-9]|[1-9][0-9]+)(?:[-+].*)?$/u;
// O_NOFOLLOW refuses a symlink at the final path component. It is the kernel
// boundary that supplements the path-level rejectSymlinked walk used during
// catalog discovery: once we have a no-follow descriptor open, no symlink at
// the file boundary can redirect the bounded read. Unsupported hosts fail
// closed in acquireSkillContentProof so synthesis never falls back to a plain
// path-based read where the proof bytes could diverge from the catalog hash.
const NOFOLLOW = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : null;
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

function exactProjection(value, fields, label, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid-${label}`);
  const allowed = new Set(fields);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`unexpected-${label}-field`);
  for (const field of fields) {
    if (!optional.includes(field) && !Object.hasOwn(value, field)) throw new Error(`missing-${label}-${field}`);
  }
}

function boundedHostText(value, label, { optional = false, maxBytes = 256 * 1024 } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`invalid-${label}`);
  }
  return value;
}

function canonicalHostPath(value, label) {
  const source = boundedHostText(value, label, { maxBytes: 4096 });
  if (!path.isAbsolute(source) || source.includes("\0")) throw new Error(`invalid-${label}`);
  const normalized = path.normalize(source);
  if (normalized !== source && normalized !== source.replace(/[\\/]+$/u, "")) throw new Error(`noncanonical-${label}`);
  return normalized;
}

function hostOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("invalid-host-origin"); }
  if (!["http:", "https:"].includes(url.protocol)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("invalid-host-origin");
  }
  return url;
}

async function boundedHostResponseText(response, label) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared)) throw new Error(`invalid-host-${label}-content-length`);
    if (Number(declared) > MAX_HOST_RESPONSE_BYTES) throw new Error(`host-${label}-response-too-large`);
  }
  const chunks = [];
  let bytes = 0;
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_HOST_RESPONSE_BYTES) {
          try { await reader.cancel(); } catch {}
          throw new Error(`host-${label}-response-too-large`);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  } else {
    const chunk = Buffer.from(await response.arrayBuffer());
    bytes = chunk.length;
    if (bytes > MAX_HOST_RESPONSE_BYTES) throw new Error(`host-${label}-response-too-large`);
    chunks.push(chunk);
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)); }
  catch { throw new Error(`invalid-host-${label}-utf8`); }
}

async function fetchHostProjection(origin, pathname, directory, fetchImpl, signal) {
  const url = new URL(pathname, origin);
  const response = await fetchImpl(url, {
    redirect: "manual",
    headers: { "x-opencode-directory": encodeURIComponent(directory) },
    signal,
  });
  if (response.status !== 200 || response.type === "opaqueredirect" || response.headers.get("location")) {
    throw new Error(`host-${pathname.slice(1)}-status-${response.status}`);
  }
  const source = await boundedHostResponseText(response, pathname.slice(1));
  try { return JSON.parse(source); } catch { throw new Error(`invalid-host-${pathname.slice(1)}-json`); }
}

function hostPaths(value, requestedDirectory) {
  exactProjection(value, HOST_PATH_FIELDS, "path-projection");
  const result = Object.freeze(Object.fromEntries(HOST_PATH_FIELDS.map((field) => [field, canonicalHostPath(value[field], `path-${field}`)])));
  if (result.directory !== requestedDirectory || result.worktree !== requestedDirectory) {
    throw new Error("host-project-path-disagreement");
  }
  return result;
}

function configuredHostRoots(value, directory) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-config-projection");
  if (value.skills === undefined) return Object.freeze([]);
  exactProjection(value.skills, ["paths", "urls"], "config-skills", ["paths", "urls"]);
  if (value.skills.urls !== undefined && (!Array.isArray(value.skills.urls)
    || value.skills.urls.length > 128
    || value.skills.urls.some((item) => typeof item !== "string"))) {
    throw new Error("invalid-config-skill-urls");
  }
  if (value.skills.paths === undefined) return Object.freeze([]);
  if (!Array.isArray(value.skills.paths) || value.skills.paths.length > 128) throw new Error("invalid-config-skill-paths");
  const roots = [];
  for (let index = 0; index < value.skills.paths.length; index += 1) {
    const source = boundedHostText(value.skills.paths[index], `config-skill-path-${index}`, { maxBytes: 4096 });
    if (/^[a-z][a-z0-9+.-]*:/iu.test(source)) continue;
    roots.push(path.normalize(path.isAbsolute(source) ? source : path.resolve(directory, source)));
  }
  return Object.freeze([...new Set(roots)]);
}

function hostSkills(value, label) {
  if (!Array.isArray(value) || value.length > MAX_HOST_SKILLS) throw new Error(`invalid-${label}-skills`);
  return Object.freeze(value.map((item, index) => {
    exactProjection(item, HOST_SKILL_FIELDS, `${label}-skill`, ["description"]);
    return Object.freeze({
      name: boundedHostText(item.name, `${label}-skill-${index}-name`, { maxBytes: 1024 }),
      ...(item.description === undefined ? {} : {
        description: boundedHostText(item.description, `${label}-skill-${index}-description`, { maxBytes: 4096 }),
      }),
      location: boundedHostText(item.location, `${label}-skill-${index}-location`, { maxBytes: 4096 }),
      content: boundedHostText(item.content, `${label}-skill-${index}-content`),
    });
  }));
}

function compareHostSkills(left, right) {
  return compareCodepoints(left.name, right.name)
    || compareCodepoints(left.location, right.location)
    || compareCodepoints(left.description ?? "", right.description ?? "")
    || compareCodepoints(left.content, right.content);
}

function safeHostOwnership(stat) {
  if (typeof process.geteuid !== "function") return true;
  if (stat.uid !== process.geteuid() || (stat.mode & 0o002) !== 0) return false;
  if ((stat.mode & 0o020) === 0) return true;
  return typeof process.getegid === "function" && stat.gid === process.getegid();
}

function safeHostFilesystemEntry(filePath) {
  for (const candidate of [path.dirname(path.dirname(filePath)), path.dirname(filePath), filePath]) {
    const stat = fs.lstatSync(candidate);
    if (!safeHostOwnership(stat)) return false;
  }
  return true;
}

function safeHostRoot(rootPath) {
  return safeHostOwnership(fs.lstatSync(rootPath));
}

function sourceReceiptHash(receipt) {
  return hashSkillContent(`self-evolve-host-global-source-v1\n${JSON.stringify(receipt)}`);
}

function hostTargetBinding(record) {
  const body = {
    sourceReceiptHash: record.sourceReceiptHash,
    sourceRootHash: record.sourceRootHash,
    precedence: record.precedence,
    logicalName: record.logicalName,
    relativePath: record.relativePath,
    currentHash: record.currentHash,
    sizeBytes: record.sizeBytes,
  };
  return Object.freeze({ ...body, targetBindingHash: hashSkillContent(`self-evolve-host-global-target-v1\n${JSON.stringify(body)}`) });
}

function codeDiagnostic(code) {
  return typeof code === "string" && /^[a-z][a-z0-9-]{0,127}$/u.test(code) ? code : "host-catalog-error";
}

function isSameOrContained(candidateAbsPath, canonicalRoot) {
  return candidateAbsPath === canonicalRoot || isPathContained(candidateAbsPath, canonicalRoot);
}

export function buildHostGlobalSkillCatalog({
  origin,
  hostVersion,
  paths: pathProjection,
  globalConfig,
  projectConfig,
  globalSkills: globalSkillProjection,
  projectSkills: projectSkillProjection,
  requestedDirectory,
  catalogLimits = null,
} = {}) {
  const diagnostics = [];
  try {
    const official = hostOrigin(origin);
    if (typeof hostVersion !== "string" || !HOST_VERSION_RE.test(hostVersion)) throw new Error("unsupported-host-version");
    const requested = canonicalHostPath(requestedDirectory, "requested-directory");
    const paths = hostPaths(pathProjection, requested);
    const limits = catalogLimits ? makeCatalogLimits(catalogLimits) : DEFAULT_CATALOG_LIMITS;
    const configuredGlobal = configuredHostRoots(globalConfig, paths.config);
    const configuredProject = configuredHostRoots(projectConfig, requested);
    const globalSkills = Object.freeze([...hostSkills(globalSkillProjection, "global")].sort(compareHostSkills));
    const projectSkills = Object.freeze([...hostSkills(projectSkillProjection, "project")].sort(compareHostSkills));
    const rawRoots = [
      { sourceKind: "opencode-config", canonicalRoot: path.join(paths.config, "skills") },
      { sourceKind: "agents-global", canonicalRoot: path.join(paths.home, ".agents", "skills") },
      { sourceKind: "claude-global", canonicalRoot: path.join(paths.home, ".claude", "skills") },
      ...configuredGlobal.map((canonicalRoot) => ({ sourceKind: "configured-global", canonicalRoot })),
    ];
    const roots = [];
    const seenRoots = new Set();
    for (const root of rawRoots) {
      const canonicalRoot = path.normalize(root.canonicalRoot);
      if (seenRoots.has(canonicalRoot)) continue;
      seenRoots.add(canonicalRoot);
      roots.push(Object.freeze({
        sourceKind: root.sourceKind,
        canonicalRoot,
        sourceRootHash: hashSkillContent(`self-evolve-host-root-v1\n${canonicalRoot}`),
        precedence: roots.length,
      }));
    }
    const rootByPath = new Map();
    const invalidRoots = new Set();
    for (const root of roots) {
      if (isSameOrContained(root.canonicalRoot, paths.directory) || isSameOrContained(root.canonicalRoot, paths.worktree)) {
        diagnostics.push("project-contained-source");
        invalidRoots.add(root.canonicalRoot);
        continue;
      }
      try {
        if (fs.realpathSync(root.canonicalRoot) !== root.canonicalRoot
          || rejectSymlinked(root.canonicalRoot)
          || !fs.lstatSync(root.canonicalRoot).isDirectory()
          || !safeHostRoot(root.canonicalRoot)) {
          diagnostics.push("unsafe-global-root");
          invalidRoots.add(root.canonicalRoot);
          continue;
        }
      } catch (error) {
        diagnostics.push(error?.code === "ENOENT" ? "missing-global-root" : "unsafe-global-root");
        invalidRoots.add(root.canonicalRoot);
        continue;
      }
      let entries;
      try { entries = fs.readdirSync(root.canonicalRoot, { withFileTypes: true }); }
      catch {
        diagnostics.push("unreadable-global-root");
        invalidRoots.add(root.canonicalRoot);
        continue;
      }
      for (const entry of entries.sort((left, right) => compareCodepoints(left.name, right.name))) {
        if (entry.isSymbolicLink()) {
          diagnostics.push("symlinked-global-entry");
          continue;
        }
        if (!entry.isDirectory()) continue;
        const direct = path.join(root.canonicalRoot, entry.name, "SKILL.md");
        if (fs.existsSync(direct)) continue;
        const nested = findNestedSkill(path.join(root.canonicalRoot, entry.name), limits);
        if (nested.found) {
          diagnostics.push("nested-skill-collection-not-approved");
          continue;
        }
        if (nested.depthExceeded) {
          diagnostics.push("catalog-scan-depth-exceeded");
        }
      }
      rootByPath.set(root.canonicalRoot, root);
    }

    const sourceReceipt = Object.freeze({
      contract: "opencode-stable-1.18-host-skills-v1",
      hostVersion,
      hostOriginHash: hashSkillContent(official.origin),
      hostPathIdentityHash: hashSkillContent(canonicalize(paths)),
      globalConfigProjectionHash: hashSkillContent(canonicalize(globalConfig)),
      projectConfigProjectionHash: hashSkillContent(canonicalize(projectConfig)),
      globalSkillProjectionHash: hashSkillContent(canonicalize(globalSkills)),
      projectSkillProjectionHash: hashSkillContent(canonicalize(projectSkills)),
      projectConfiguredRootSetHash: hashSkillContent(JSON.stringify(configuredProject)),
      roots: Object.freeze(roots.map(({ sourceKind, sourceRootHash, precedence }) => Object.freeze({ sourceKind, sourceRootHash, precedence }))),
    });
    const receiptHash = sourceReceiptHash(sourceReceipt);
    const globalNameCounts = new Map();
    const globalLocationCounts = new Map();
    for (const item of globalSkills) {
      globalNameCounts.set(item.name, (globalNameCounts.get(item.name) ?? 0) + 1);
      globalLocationCounts.set(item.location, (globalLocationCounts.get(item.location) ?? 0) + 1);
    }
    const records = [];
    let aggregateBytes = 0;
    for (const item of globalSkills) {
      if (globalNameCounts.get(item.name) !== 1 || globalLocationCounts.get(item.location) !== 1) {
        diagnostics.push("ambiguous-global-skill");
        continue;
      }
      if (!LOGICAL_NAME_RE.test(item.name)) {
        diagnostics.push("invalid-global-skill-name");
        continue;
      }
      if (item.location === "<built-in>" || /^[a-z][a-z0-9+.-]*:/iu.test(item.location)) {
        diagnostics.push("non-local-source");
        continue;
      }
      let skillPath;
      try { skillPath = canonicalHostPath(item.location, "global-skill-location"); }
      catch {
        diagnostics.push("noncanonical-global-skill");
        continue;
      }
      if (path.basename(skillPath) !== "SKILL.md" || path.basename(path.dirname(skillPath)) !== item.name) {
        diagnostics.push("non-direct-global-skill");
        continue;
      }
      if (isSameOrContained(skillPath, paths.directory) || isSameOrContained(skillPath, paths.worktree)) {
        diagnostics.push("project-contained-source");
        continue;
      }
      const canonicalRoot = path.dirname(path.dirname(skillPath));
      const root = rootByPath.get(canonicalRoot);
      if (!root) {
        diagnostics.push(invalidRoots.has(canonicalRoot) ? "unsafe-global-source" : "unclassified-global-source");
        continue;
      }
      const matchingProject = projectSkills.filter((candidate) => candidate.name === item.name
        && candidate.location === item.location
        && candidate.content === item.content);
      if (matchingProject.length !== 1) {
        diagnostics.push(matchingProject.length === 0 ? "project-shadowed-global-skill" : "ambiguous-project-skill");
        continue;
      }
      let bytes;
      try {
        if (fs.realpathSync(skillPath) !== skillPath || rejectSymlinked(skillPath) || !safeHostFilesystemEntry(skillPath)) {
          throw new Error("unsafe");
        }
        const stat = fs.lstatSync(skillPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("unsafe");
        bytes = fs.readFileSync(skillPath);
      } catch (error) {
        diagnostics.push(error?.code === "ENOENT" ? "missing-global-skill" : "unsafe-global-skill");
        continue;
      }
      if (records.length + 1 > limits.maxCatalogEntries) {
        return Object.freeze({ ok: false, sourceReceipt, sourceReceiptHash: receiptHash, records: Object.freeze([]), catalogGenerationHash: null, diagnostics: Object.freeze(["catalog-entries-exceeded"]) });
      }
      if (bytes.length > limits.maxCatalogPerFileBytes) {
        return Object.freeze({ ok: false, sourceReceipt, sourceReceiptHash: receiptHash, records: Object.freeze([]), catalogGenerationHash: null, diagnostics: Object.freeze(["catalog-per-file-bytes-exceeded"]) });
      }
      aggregateBytes += bytes.length;
      if (aggregateBytes > limits.maxCatalogAggregateBytes) {
        return Object.freeze({ ok: false, sourceReceipt, sourceReceiptHash: receiptHash, records: Object.freeze([]), catalogGenerationHash: null, diagnostics: Object.freeze(["catalog-aggregate-bytes-exceeded"]) });
      }
      const parsedSource = parseSkillFrontmatter(bytes.toString("utf8"));
      const base = skillRecord(canonicalRoot, item.name, skillPath, bytes);
      if (base.frontmatterErrors.length > 0) {
        diagnostics.push("malformed-global-skill-frontmatter");
        continue;
      }
      if (base.parsedFrontmatter.name !== item.name
        || (item.description !== undefined && base.parsedFrontmatter.description !== item.description)) {
        diagnostics.push("host-frontmatter-drift");
        continue;
      }
      if (bytes.toString("utf8").slice(parsedSource.bodyStart) !== item.content) {
        diagnostics.push("host-content-drift");
        continue;
      }
      const binding = hostTargetBinding({
        ...base,
        sourceReceiptHash: receiptHash,
        sourceRootHash: root.sourceRootHash,
        precedence: root.precedence,
      });
      records.push(Object.freeze({
        ...base,
        parsedFrontmatter: Object.freeze({ ...base.parsedFrontmatter }),
        frontmatterErrors: Object.freeze([...base.frontmatterErrors]),
        sourceKind: root.sourceKind,
        sourceReceiptHash: receiptHash,
        sourceRootHash: root.sourceRootHash,
        precedence: root.precedence,
        targetBindingHash: binding.targetBindingHash,
      }));
    }
    records.sort((left, right) => compareCodepoints(left.logicalName, right.logicalName)
      || left.precedence - right.precedence
      || compareCodepoints(left.absolutePath, right.absolutePath));
    const duplicateAccepted = records.some((record, index) => index > 0 && records[index - 1].logicalName === record.logicalName);
    if (duplicateAccepted) {
      return Object.freeze({ ok: false, sourceReceipt, sourceReceiptHash: receiptHash, records: Object.freeze([]), catalogGenerationHash: null, diagnostics: Object.freeze(["ambiguous-global-skill"]) });
    }
    const catalogGenerationHash = hashSkillContent(`self-evolve-host-global-catalog-v1\n${JSON.stringify({
      sourceReceiptHash: receiptHash,
      records: records.map(({ logicalName, sourceRootHash, precedence, currentHash, targetBindingHash }) => ({
        logicalName,
        sourceRootHash,
        precedence,
        currentHash,
        targetBindingHash,
      })),
    })}`);
    return Object.freeze({
      ok: true,
      sourceReceipt,
      sourceReceiptHash: receiptHash,
      records: Object.freeze(records),
      catalogGenerationHash,
      diagnostics: Object.freeze([...new Set(diagnostics.map(codeDiagnostic))].sort()),
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      sourceReceipt: null,
      sourceReceiptHash: null,
      records: Object.freeze([]),
      catalogGenerationHash: null,
      diagnostics: Object.freeze([codeDiagnostic(error instanceof Error ? error.message : "host-catalog-error")]),
    });
  }
}

export async function discoverHostGlobalSkills({
  origin,
  directory,
  hostVersion,
  fetchImpl = globalThis.fetch,
  catalogLimits = null,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOST_FETCH_TIMEOUT_MS);
  try {
    if (typeof fetchImpl !== "function") throw new Error("fetch-unavailable");
    const official = hostOrigin(origin);
    const requestedDirectory = canonicalHostPath(directory, "requested-directory");
    const paths = hostPaths(await fetchHostProjection(official, "/path", requestedDirectory, fetchImpl, controller.signal), requestedDirectory);
    const [globalConfig, projectConfig, globalSkills, projectSkills] = await Promise.all([
      fetchHostProjection(official, "/config", paths.config, fetchImpl, controller.signal),
      fetchHostProjection(official, "/config", requestedDirectory, fetchImpl, controller.signal),
      fetchHostProjection(official, "/skill", paths.config, fetchImpl, controller.signal),
      fetchHostProjection(official, "/skill", requestedDirectory, fetchImpl, controller.signal),
    ]);
    return buildHostGlobalSkillCatalog({
      origin: official.origin,
      hostVersion,
      paths,
      globalConfig,
      projectConfig,
      globalSkills,
      projectSkills,
      requestedDirectory,
      catalogLimits,
    });
  } catch (error) {
    const diagnostic = controller.signal.aborted
      ? "host-request-timeout"
      : error instanceof Error ? error.message : "host-catalog-error";
    controller.abort();
    return Object.freeze({
      ok: false,
      sourceReceipt: null,
      sourceReceiptHash: null,
      records: Object.freeze([]),
      catalogGenerationHash: null,
      diagnostics: Object.freeze([codeDiagnostic(diagnostic)]),
    });
  } finally {
    clearTimeout(timer);
  }
}

export function adaptHostGlobalSkillCatalog(hostCatalog, { updatedAt = 0 } = {}) {
  if (!hostCatalog?.ok || !Array.isArray(hostCatalog.records)
      || typeof hostCatalog.catalogGenerationHash !== "string") {
    return {
      ok: false,
      policy: null,
      projectSkillRoot: null,
      canonicalRoots: [],
      records: [],
      catalogGenerationHash: null,
      blockers: [{ code: hostCatalog?.diagnostics?.[0] ?? "host-global-skill-catalog-unavailable" }],
    };
  }
  if (hostCatalog.records.length === 0) {
    return {
      ok: false,
      policy: null,
      projectSkillRoot: null,
      canonicalRoots: [],
      records: [],
      catalogGenerationHash: null,
      blockers: [{ code: "host-global-skill-catalog-empty" }],
    };
  }
  const roots = [...new Set(hostCatalog.records.map((record) => record.canonicalRoot))]
    .sort(compareCodepoints)
    .map((canonicalPath) => makeApprovedGlobalRoot({ canonicalPath, canUpdate: true, canCreate: false }));
  const policy = makeGlobalRootPolicy({
    roots,
    creationRootId: null,
    selectedBy: "host",
    updatedAt,
  });
  const rootIds = new Map(policy.roots.map((root) => [root.canonicalPath, root.rootId]));
  const records = hostCatalog.records.map((record) => ({
    ...record,
    rootId: rootIds.get(record.canonicalRoot),
    canUpdate: true,
    canCreate: false,
  }));
  inventoryScopes.set(records, new Map(policy.roots.map((root) => [root.canonicalPath, "global"])));
  return {
    ok: true,
    policy,
    projectSkillRoot: null,
    canonicalRoots: policy.roots.map((root) => root.canonicalPath),
    records,
    catalogGenerationHash: hostCatalog.catalogGenerationHash,
    blockers: [],
    hostAuthoritative: true,
    sourceReceiptHash: hostCatalog.sourceReceiptHash,
    diagnostics: hostCatalog.diagnostics,
  };
}

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

const PROOF_HASH_RE = /^[a-f0-9]{64}$/u;

// Bind the EXACT provider-bound SKILL.md bytes to the advertised catalog hash
// despite concurrent replacement, rewrite, symlink, growth, or truncation.
//
// The catalog records (currentHash, sizeBytes) at discovery time. Between that
// moment and provider dispatch the file can change. To close that TOCTOU window
// we open the file through a NO-FOLLOW descriptor, validate containment,
// identity, type, and size against both the recorded catalog proof and the
// configured per-file limit, read the bounded bytes from the descriptor, hash
// THOSE EXACT bytes, and return them as the single buffer the caller retains
// through prompt construction. After this function returns, no path-based read
// is permitted: the bytes are the proof.
//
// Returns { ok: true, bytes } where bytes is a Buffer whose sha256 hash equals
// target.currentHash and whose length equals target.sizeBytes (when recorded).
// Returns { ok: false, reason } on any mismatch; the caller must refuse
// synthesis (no provider dispatch) for any non-ok outcome.
export function acquireSkillContentProof(target, options = {}) {
  if (NOFOLLOW === null) return { ok: false, reason: "skill-content-no-follow-unsupported" };
  if (!target || typeof target !== "object") return { ok: false, reason: "skill-content-target-required" };
  const absolutePath = target.absolutePath;
  const canonicalRoot = target.canonicalRoot;
  const currentHash = target.currentHash;
  const sizeBytes = target.sizeBytes;
  if (typeof absolutePath !== "string" || !absolutePath) return { ok: false, reason: "skill-content-target-path-required" };
  if (typeof canonicalRoot !== "string" || !canonicalRoot) return { ok: false, reason: "skill-content-canonical-root-required" };
  if (currentHash === MUST_NOT_EXIST) return { ok: false, reason: "skill-content-target-must-not-exist" };
  if (typeof currentHash !== "string" || !PROOF_HASH_RE.test(currentHash)) return { ok: false, reason: "skill-content-target-hash-invalid" };
  if (!isPathContained(absolutePath, canonicalRoot)) return { ok: false, reason: "skill-content-target-escapes-root" };

  const limit = options.perFileBytesLimit ?? DEFAULT_CATALOG_LIMITS.maxCatalogPerFileBytes;
  if (!Number.isSafeInteger(limit) || limit < 1) return { ok: false, reason: "skill-content-limit-invalid" };

  // Revalidate the canonical root without storing extra state: the catalog
  // records the canonical path, so any drift (replacement, relocation, or a
  // newly-symlinked ancestor) is detected by re-deriving the realpath and
  // re-running the segment-level symlink walk.
  try {
    if (fs.realpathSync(canonicalRoot) !== canonicalRoot || rejectSymlinked(canonicalRoot)) {
      return { ok: false, reason: "skill-content-canonical-root-stale" };
    }
  } catch {
    return { ok: false, reason: "skill-content-canonical-root-stale" };
  }
  if (rejectSymlinked(absolutePath)) return { ok: false, reason: "skill-content-path-symlinked" };

  // Pre-open lstat for an inode/dev identity comparison against the descriptor
  // we are about to open. If the file is replaced between lstat and open, the
  // post-open fstat will disagree and we refuse before reading.
  let before;
  try {
    before = fs.lstatSync(absolutePath);
  } catch (error) {
    return { ok: false, reason: error?.code === "ENOENT" ? "skill-content-target-missing" : "skill-content-target-unavailable" };
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    return { ok: false, reason: "skill-content-path-rejected" };
  }
  if (before.size > limit) return { ok: false, reason: "skill-content-size-exceeds-limit" };

  let fd;
  try {
    fd = fs.openSync(absolutePath, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    return { ok: false, reason: error?.code === "ENOENT" ? "skill-content-target-missing" : "skill-content-path-rejected" };
  }

  try {
    let opened;
    try {
      opened = fs.fstatSync(fd);
    } catch {
      return { ok: false, reason: "skill-content-fstat-failed" };
    }
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1) {
      return { ok: false, reason: "skill-content-path-rejected" };
    }
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      return { ok: false, reason: "skill-content-target-replaced" };
    }
    if (opened.size > limit) return { ok: false, reason: "skill-content-size-exceeds-limit" };

    // Read bounded bytes from the descriptor only. The descriptor is the proof
    // handle: even if the path is replaced now, the bytes we read come from the
    // inode we just validated.
    let bytes;
    try {
      bytes = fs.readFileSync(fd);
    } catch {
      return { ok: false, reason: "skill-content-read-failed" };
    }
    if (bytes.length > limit) return { ok: false, reason: "skill-content-size-exceeds-limit" };
    if (Number.isSafeInteger(sizeBytes) && bytes.length !== sizeBytes) {
      return { ok: false, reason: "skill-content-size-mismatch" };
    }
    if (hashSkillContent(bytes) !== currentHash) return { ok: false, reason: "skill-content-hash-mismatch" };

    // Post-read lstat catches an in-window replacement: if the path now resolves
    // to a different inode, the file we read may have been swapped even though
    // the open descriptor still points at the original inode. The hash check
    // already bound the bytes; this guard refuses to certify a swap.
    let after;
    try {
      after = fs.lstatSync(absolutePath);
    } catch {
      return { ok: false, reason: "skill-content-target-replaced" };
    }
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1) {
      return { ok: false, reason: "skill-content-target-replaced" };
    }

    return { ok: true, bytes };
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
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
  const closing = /^(?:---|\.\.\.)[ \t]*\r?$/gmu;
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
    const block = /^([|>])[-+]?$/u.exec(raw);
    if (block) {
      const parts = [];
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) parts.push(lines[++index].trim());
      frontmatter[key] = block[1] === ">" ? parts.join(" ") : parts.join("\n");
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
    if (Buffer.byteLength(frontmatter.description, "utf8") > 4096) errors.push("frontmatter description exceeds 4096 bytes");
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

export function discoverSkills(canonicalRoots, options = {}) {
  const limits = options.catalogLimits ? makeCatalogLimits(options.catalogLimits) : DEFAULT_CATALOG_LIMITS;
  const records = [];
  let aggregateBytes = 0;
  let breach = null;

  rootLoop: for (const canonicalRoot of canonicalRoots) {
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
      let consumed = false;
      try {
        if (!rejectSymlinked(absolutePath) && fs.lstatSync(absolutePath).isFile()) {
          const real = fs.realpathSync(absolutePath);
          if (real === absolutePath && isPathContained(real, canonicalRoot)) {
            const bytes = fs.readFileSync(real);
            if (records.length + 1 > limits.maxCatalogEntries) { breach = "catalog-entries-exceeded"; break rootLoop; }
            if (bytes.length > limits.maxCatalogPerFileBytes) { breach = "catalog-per-file-bytes-exceeded"; break rootLoop; }
            aggregateBytes += bytes.length;
            if (aggregateBytes > limits.maxCatalogAggregateBytes) { breach = "catalog-aggregate-bytes-exceeded"; break rootLoop; }
            records.push(skillRecord(canonicalRoot, entry.name, real, bytes));
            consumed = true;
          }
        }
      } catch {}

      if (!consumed && !breach) {
        const nested = findNestedSkill(path.join(canonicalRoot, entry.name), limits);
        if (nested.found) { breach = "nested-skill-collection-not-approved"; break rootLoop; }
        if (nested.depthExceeded) { breach = "catalog-scan-depth-exceeded"; break rootLoop; }
      }
    }
  }

  if (breach) {
    records.length = 0;
    Object.defineProperty(records, "catalogReceipt", {
      value: { ok: false, code: breach },
      enumerable: false,
      writable: false,
      configurable: false,
    });
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
    "catalog-entries-exceeded": `Catalog entry count exceeds the configured limit (${details.limit ?? "unknown"}); reduce the collection or raise maxCatalogEntries.`,
    "catalog-per-file-bytes-exceeded": `Catalog skill ${logicalName ?? details.entryName ?? "unknown"} is ${details.sizeBytes ?? "unknown"} bytes, exceeding the per-file limit (${details.limit ?? "unknown"} bytes).`,
    "catalog-aggregate-bytes-exceeded": `Catalog aggregate content exceeds the configured limit (${details.limit ?? "unknown"} bytes); reduce the collection or raise maxCatalogAggregateBytes.`,
    "catalog-scan-depth-exceeded": `Catalog nested-collection scan reached the depth limit (${details.limit ?? "unknown"}); flatten the collection or raise maxCatalogScanDepth.`,
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

function findNestedSkill(collectionPath, limits) {
  // Recursively scans inside a directory that is a direct child of an approved
  // root but has no SKILL.md of its own. The detector's sole purpose is to emit
  // a setup blocker when a nested skill collection shape is found at any
  // supported depth. It never authorizes descendants.
  //
  // Symlinks are refused (skipped, never followed). Special files (block/char
  // devices, FIFOs, sockets) are likewise refused: Dirent.isFile() and
  // Dirent.isDirectory() both return false for them, so they fall through the
  // file/directory branches and are ignored.
  //
  // Returns { found: string|null, depthExceeded: boolean }. found is the
  // absolute path of the first nested SKILL.md discovered; depthExceeded is
  // true when subdirectories remain beyond the scan-depth ceiling, meaning the
  // scan cannot prove the absence of a deeper nested collection.
  let depthExceeded = false;
  function scan(directory, depth) {
    if (depth > limits.maxCatalogScanDepth) {
      depthExceeded = true;
      return null;
    }
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries.sort((left, right) => compareCodepoints(left.name, right.name))) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isFile()) {
        if (entry.name === "SKILL.md") return entryPath;
        continue;
      }
      if (entry.isDirectory()) {
        const nested = scan(entryPath, depth + 1);
        if (nested) return nested;
        continue;
      }
      // Special files (block/char devices, FIFOs, sockets) are refused.
    }
    return null;
  }
  const found = scan(collectionPath, 1);
  return { found, depthExceeded };
}

export function buildGlobalSkillCatalog(rootPolicy, { projectRoot = null, projectSkillRoot = null, catalogLimits = null } = {}) {
  const limits = catalogLimits ? makeCatalogLimits(catalogLimits) : DEFAULT_CATALOG_LIMITS;
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
  let aggregateBytes = 0;
  let limitBreached = false;

  rootLoop: for (const root of policy.roots) {
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
      let recordAccepted = false;
      try {
        const stat = fs.lstatSync(skillPath);
        skillExists = true;
        if (!rejectSymlinked(skillPath) && stat.isFile()) {
          const real = fs.realpathSync(skillPath);
          if (real === skillPath && isPathContained(real, root.canonicalPath)) {
            const fileBytes = fs.readFileSync(real);
            if (fileBytes.length > limits.maxCatalogPerFileBytes) {
              blockers.push(catalogBlocker("catalog-per-file-bytes-exceeded", root, { logicalName: entry.name, sizeBytes: fileBytes.length, limit: limits.maxCatalogPerFileBytes }));
              limitBreached = true;
              break rootLoop;
            }
            if (records.length + 1 > limits.maxCatalogEntries) {
              blockers.push(catalogBlocker("catalog-entries-exceeded", root, { limit: limits.maxCatalogEntries }));
              limitBreached = true;
              break rootLoop;
            }
            aggregateBytes += fileBytes.length;
            if (aggregateBytes > limits.maxCatalogAggregateBytes) {
              blockers.push(catalogBlocker("catalog-aggregate-bytes-exceeded", root, { limit: limits.maxCatalogAggregateBytes }));
              limitBreached = true;
              break rootLoop;
            }
            const record = {
              ...skillRecord(root.canonicalPath, entry.name, real, fileBytes),
              rootId: root.rootId,
              canUpdate: root.canUpdate,
              canCreate: root.canCreate,
            };
            if (LOGICAL_NAME_RE.test(entry.name) && validExistingTarget(record, entry.name)) {
              records.push(record);
              recordAccepted = true;
              continue;
            }
          }
        }
      } catch (error) {
        if (error?.code !== "ENOENT") skillExists = true;
      }
      if (recordAccepted) continue;
      if (skillExists) {
        blockers.push(catalogBlocker("global-skill-record-invalid", root, { logicalName: entry.name }));
        continue;
      }
      const nested = findNestedSkill(path.join(root.canonicalPath, entry.name), limits);
      if (nested.found) {
        blockers.push(catalogBlocker("nested-skill-collection-not-approved", root, { collectionName: entry.name }));
      } else if (nested.depthExceeded) {
        blockers.push(catalogBlocker("catalog-scan-depth-exceeded", root, { collectionName: entry.name, limit: limits.maxCatalogScanDepth }));
        limitBreached = true;
      }
    }
    if (limitBreached) break rootLoop;
  }

  if (!limitBreached) {
    const nameCounts = new Map();
    for (const record of records) nameCounts.set(record.logicalName, (nameCounts.get(record.logicalName) ?? 0) + 1);
    for (const [logicalName, count] of [...nameCounts].sort(([left], [right]) => compareCodepoints(left, right))) {
      if (count > 1) blockers.push(catalogBlocker("duplicate-global-skill-name", null, { logicalName }));
    }
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
  if (catalog.hostAuthoritative === true) {
    try {
      for (const record of catalog.records) {
        if (fs.realpathSync(record.canonicalRoot) !== record.canonicalRoot
            || fs.realpathSync(record.absolutePath) !== record.absolutePath
            || rejectSymlinked(record.absolutePath)
            || !isPathContained(record.absolutePath, record.canonicalRoot)
            || hashSkillContent(fs.readFileSync(record.absolutePath)) !== record.currentHash) {
          throw new Error("global-skill-catalog-stale");
        }
      }
      return { ok: true, reason: null, catalog };
    } catch {
      return { ok: false, reason: "global-skill-catalog-stale", catalog: null };
    }
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
  catalog: providedCatalog = null,
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
  let catalog;
  if (providedCatalog !== null) {
    const refreshed = refreshGlobalSkillCatalog(providedCatalog);
    if (!refreshed.ok) return unresolvedGlobalTarget(refreshed.reason);
    catalog = refreshed.catalog;
    if (catalog.policy.rootSetHash !== policy.rootSetHash) return unresolvedGlobalTarget("stale-root-set");
  } else {
    catalog = buildGlobalSkillCatalog(policy, { projectSkillRoot });
    if (!catalog.ok) return unresolvedGlobalTarget(catalog.blockers[0]?.code ?? "global-skill-catalog-invalid");
  }
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
  if (catalog.hostAuthoritative !== true
      && globalCatalogGenerationHash(policy, baselineRecords) !== binding.catalogGenerationHash) {
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
