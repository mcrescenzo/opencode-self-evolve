import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverHostGlobalSkills } from "../self-evolve-inventory.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const SKILL_FIELDS = Object.freeze(["name", "description", "location", "content"]);
const PATH_FIELDS = Object.freeze(["home", "state", "config", "worktree", "directory"]);

function fail(reason) {
  throw new Error(reason);
}

function exactKeys(value, allowed, label, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`invalid-${label}`);
  const keys = Object.keys(value).sort();
  const allowedSet = new Set(allowed);
  if (keys.some((key) => !allowedSet.has(key))) fail(`unexpected-${label}-field`);
  for (const key of allowed) {
    if (!optional.includes(key) && !Object.hasOwn(value, key)) fail(`missing-${label}-${key}`);
  }
}

function boundedText(value, label, { optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 256 * 1024) {
    fail(`invalid-${label}`);
  }
  return value;
}

function canonicalAbsolute(value, label) {
  const source = boundedText(value, label);
  if (!path.isAbsolute(source) || source.includes("\0")) fail(`invalid-${label}`);
  const normalized = path.normalize(source);
  if (normalized !== source && normalized !== source.replace(/[\\/]+$/u, "")) fail(`noncanonical-${label}`);
  return normalized;
}

function containedBy(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function officialOrigin(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)
    || url.username || url.password || url.search || url.hash
    || url.pathname !== "/") {
    fail("invalid-host-origin");
  }
  return url;
}

async function fetchJson(origin, pathname, directory, fetchImpl) {
  const url = new URL(pathname, origin);
  const response = await fetchImpl(url, {
    redirect: "manual",
    headers: directory ? { "x-opencode-directory": encodeURIComponent(directory) } : {},
  });
  if (response.status !== 200 || response.type === "opaqueredirect" || response.headers.get("location")) {
    fail(`host-${pathname.slice(1)}-status-${response.status}`);
  }
  const source = await response.text();
  if (Buffer.byteLength(source, "utf8") > MAX_RESPONSE_BYTES) fail(`host-${pathname.slice(1)}-response-too-large`);
  try {
    return JSON.parse(source);
  } catch {
    return fail(`invalid-host-${pathname.slice(1)}-json`);
  }
}

function pathProjection(value) {
  exactKeys(value, PATH_FIELDS, "path-projection");
  return Object.freeze(Object.fromEntries(PATH_FIELDS.map((field) => [field, canonicalAbsolute(value[field], `path-${field}`)])));
}

function configSkillPaths(value, configDirectory) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-config-projection");
  if (value.skills === undefined) return Object.freeze([]);
  exactKeys(value.skills, ["paths", "urls"], "config-skills", ["paths", "urls"]);
  if (value.skills.urls !== undefined && (!Array.isArray(value.skills.urls)
    || value.skills.urls.some((item) => typeof item !== "string"))) {
    fail("invalid-config-skill-urls");
  }
  if (value.skills.paths === undefined) return Object.freeze([]);
  if (!Array.isArray(value.skills.paths) || value.skills.paths.length > 128) fail("invalid-config-skill-paths");
  const resolved = value.skills.paths.map((item, index) => {
    const source = boundedText(item, `config-skill-path-${index}`);
    if (/^[a-z][a-z0-9+.-]*:/iu.test(source)) fail("remote-config-skill-path");
    return path.normalize(path.isAbsolute(source) ? source : path.resolve(configDirectory, source));
  });
  return Object.freeze([...new Set(resolved)].sort());
}

function skillProjection(value, label) {
  if (!Array.isArray(value) || value.length > 4096) fail(`invalid-${label}-skills`);
  return Object.freeze(value.map((item, index) => {
    exactKeys(item, SKILL_FIELDS, `${label}-skill`, ["description"]);
    return Object.freeze({
      name: boundedText(item.name, `${label}-skill-${index}-name`),
      ...(item.description === undefined ? {} : { description: boundedText(item.description, `${label}-skill-${index}-description`) }),
      location: boundedText(item.location, `${label}-skill-${index}-location`),
      content: boundedText(item.content, `${label}-skill-${index}-content`),
    });
  }));
}

function directSkillRoot(location) {
  if (!path.isAbsolute(location) || path.basename(location) !== "SKILL.md") return null;
  return path.dirname(path.dirname(path.normalize(location)));
}

function catalogSummary({ paths, globalConfiguredRoots, projectConfiguredRoots, globalSkills, projectSkills }) {
  const roots = [...new Set([
    path.join(paths.config, "skills"),
    path.join(paths.home, ".agents", "skills"),
    path.join(paths.home, ".claude", "skills"),
    ...globalConfiguredRoots,
  ].map((item) => path.normalize(item)))].sort();
  const duplicateNames = new Set();
  const seenNames = new Set();
  for (const skill of globalSkills) {
    if (seenNames.has(skill.name)) duplicateNames.add(skill.name);
    seenNames.add(skill.name);
  }
  const diagnostics = [];
  const eligible = [];
  for (const skill of globalSkills) {
    if (duplicateNames.has(skill.name)) {
      diagnostics.push("duplicate-global-name");
      continue;
    }
    if (skill.location === "<built-in>" || /^[a-z][a-z0-9+.-]*:/iu.test(skill.location)) {
      diagnostics.push("non-local-source");
      continue;
    }
    const skillPath = path.normalize(skill.location);
    const root = directSkillRoot(skillPath);
    if (!root || !roots.includes(root)) {
      diagnostics.push("unclassified-global-source");
      continue;
    }
    if (containedBy(skillPath, paths.directory) || containedBy(skillPath, paths.worktree)) {
      diagnostics.push("project-contained-source");
      continue;
    }
    const matching = projectSkills.filter((candidate) => candidate.name === skill.name
      && candidate.location === skill.location && candidate.content === skill.content);
    if (matching.length !== 1) {
      diagnostics.push("host-project-disagreement");
      continue;
    }
    eligible.push(Object.freeze({
      name: skill.name,
      locationHash: sha256(skillPath),
      contentHash: sha256(skill.content),
    }));
  }
  return Object.freeze({
    globalSkillCount: globalSkills.length,
    projectSkillCount: projectSkills.length,
    configuredRootCount: globalConfiguredRoots.length,
    projectConfiguredRootCount: projectConfiguredRoots.length,
    eligible: Object.freeze(eligible.sort((left, right) => left.name.localeCompare(right.name))),
    diagnostics: Object.freeze([...new Set(diagnostics)].sort()),
  });
}

export async function probeHostSkillContract({ origin, directory, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") fail("fetch-unavailable");
  const official = officialOrigin(origin);
  const requestedDirectory = canonicalAbsolute(directory, "probe-directory");
  const paths = pathProjection(await fetchJson(official, "/path", requestedDirectory, fetchImpl));
  if (paths.directory !== requestedDirectory || paths.worktree !== requestedDirectory) fail("host-project-path-disagreement");
  const [globalConfig, projectConfig, globalRaw, projectRaw] = await Promise.all([
    fetchJson(official, "/config", paths.config, fetchImpl),
    fetchJson(official, "/config", requestedDirectory, fetchImpl),
    fetchJson(official, "/skill", paths.config, fetchImpl),
    fetchJson(official, "/skill", requestedDirectory, fetchImpl),
  ]);
  const globalConfiguredRoots = configSkillPaths(globalConfig, paths.config);
  const projectConfiguredRoots = configSkillPaths(projectConfig, requestedDirectory);
  const summary = catalogSummary({
    paths,
    globalConfiguredRoots,
    projectConfiguredRoots,
    globalSkills: skillProjection(globalRaw, "global"),
    projectSkills: skillProjection(projectRaw, "project"),
  });
  return Object.freeze({
    contract: "opencode-stable-1.18-host-skills-v1",
    pathProjectionHash: sha256(JSON.stringify(paths)),
    globalConfigProjectionHash: sha256(JSON.stringify(globalConfig)),
    projectConfigProjectionHash: sha256(JSON.stringify(projectConfig)),
    ...summary,
  });
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--url") result.origin = value;
    else if (key === "--directory") result.directory = value;
    else if (key === "--host-version") result.hostVersion = value;
    else fail(`unknown-argument-${key}`);
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const options = parseArguments(process.argv.slice(2));
  const run = options.hostVersion
    ? discoverHostGlobalSkills({
        origin: options.origin,
        directory: options.directory,
        hostVersion: options.hostVersion,
      })
    : probeHostSkillContract(options);
  run.then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
