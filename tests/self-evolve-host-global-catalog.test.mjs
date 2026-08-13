import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildHostGlobalSkillCatalog,
  discoverHostGlobalSkills,
} from "../self-evolve-inventory.js";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-host-catalog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const config = path.join(root, "custom-opencode-config");
  const project = path.join(root, "project");
  const state = path.join(root, "state");
  for (const directory of [home, config, project, state]) mkdirSync(directory, { recursive: true });
  return { root, home, config, project, state };
}

function skill(root, name, body = "# Guidance\n") {
  const directory = path.join(root, name);
  mkdirSync(directory, { recursive: true });
  chmodSync(root, 0o755);
  chmodSync(directory, 0o755);
  const location = path.join(directory, "SKILL.md");
  const content = body;
  writeFileSync(location, `---\nname: ${name}\ndescription: ${name} host-global guidance.\n---\n${content}`, "utf8");
  chmodSync(location, 0o644);
  return { name, description: `${name} host-global guidance.`, location, content };
}

function projection(f, overrides = {}) {
  const roots = {
    standard: path.join(f.config, "skills"),
    agents: path.join(f.home, ".agents", "skills"),
    claude: path.join(f.home, ".claude", "skills"),
    relative: path.join(f.config, "relative-skills"),
    absolute: path.join(f.root, "absolute-global-skills"),
    project: path.join(f.project, ".opencode", "skills"),
  };
  for (const root of Object.values(roots)) {
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o755);
  }
  const globalSkills = overrides.globalSkills ?? [
    skill(roots.standard, "standard-skill"),
    skill(roots.agents, "agents-skill"),
    skill(roots.claude, "claude-skill"),
    skill(roots.relative, "relative-skill"),
    skill(roots.absolute, "absolute-skill"),
    { name: "built-in", location: "<built-in>", content: "# Built in" },
    { name: "remote-skill", location: "https://example.invalid/remote/SKILL.md", content: "# Remote" },
    { name: "cache-skill", location: "cache:skills/cache-skill/SKILL.md", content: "# Cache" },
    { name: "embedded-skill", location: "embedded:skills/embedded-skill/SKILL.md", content: "# Embedded" },
  ];
  const projectOnly = skill(roots.project, "project-skill");
  return {
    input: {
      origin: "http://127.0.0.1:41983/",
      hostVersion: "1.18.18",
      paths: { home: f.home, state: f.state, config: f.config, worktree: f.project, directory: f.project },
      globalConfig: { skills: { paths: ["relative-skills", roots.absolute], urls: ["https://example.invalid/catalog"] } },
      projectConfig: { skills: { paths: [roots.project], urls: [] } },
      globalSkills,
      projectSkills: overrides.projectSkills ?? [...globalSkills, projectOnly],
      requestedDirectory: f.project,
      ...overrides.input,
    },
    roots,
    projectOnly,
  };
}

test("zero-setup catalog discovers every eligible local global source and excludes project/remote/built-in", (t) => {
  const f = fixture(t);
  const base = projection(f);
  const projectAgents = skill(path.join(f.project, ".agents", "skills"), "project-agents-skill");
  const projectClaude = skill(path.join(f.project, ".claude", "skills"), "project-claude-skill");
  const input = {
    ...base.input,
    globalSkills: [...base.input.globalSkills, projectAgents, projectClaude],
    projectSkills: [...base.input.projectSkills, projectAgents, projectClaude],
  };
  const result = buildHostGlobalSkillCatalog(input);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.records.map((record) => record.logicalName), [
    "absolute-skill",
    "agents-skill",
    "claude-skill",
    "relative-skill",
    "standard-skill",
  ], JSON.stringify(result.diagnostics));
  assert.deepEqual(result.diagnostics, ["non-local-source", "project-contained-source"]);
  assert.equal(result.records.some((record) => record.logicalName === "project-skill"), false);
  assert.equal(result.records.some((record) => record.logicalName.startsWith("project-")), false);
  assert.equal(result.diagnostics.includes("project-contained-source"), true);
  assert.equal("automationGeneration" in result, false);
  assert.equal("automaticRecommendationsEnabled" in result, false);
});

test("catalog hashes deterministically bind host source, precedence, and content", (t) => {
  const f = fixture(t);
  const { input } = projection(f);
  const first = buildHostGlobalSkillCatalog(input);
  const same = buildHostGlobalSkillCatalog(input);
  assert.equal(first.sourceReceiptHash, same.sourceReceiptHash);
  assert.equal(first.catalogGenerationHash, same.catalogGenerationHash);
  assert.deepEqual(first.records.map((record) => record.targetBindingHash), same.records.map((record) => record.targetBindingHash));
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.sourceReceipt), true);
  assert.equal(Object.isFrozen(first.sourceReceipt.roots), true);
  assert.equal(Object.isFrozen(first.records), true);
  assert.equal(Object.isFrozen(first.records[0]), true);
  assert.equal(Object.isFrozen(first.records[0].parsedFrontmatter), true);

  const reorderedProjection = buildHostGlobalSkillCatalog({
    ...input,
    globalSkills: [...input.globalSkills].reverse(),
    projectSkills: [...input.projectSkills].reverse(),
    globalConfig: { skills: { urls: input.globalConfig.skills.urls, paths: input.globalConfig.skills.paths } },
  });
  assert.equal(reorderedProjection.sourceReceiptHash, first.sourceReceiptHash);
  assert.equal(reorderedProjection.catalogGenerationHash, first.catalogGenerationHash);

  const changedOrigin = buildHostGlobalSkillCatalog({ ...input, origin: "http://127.0.0.1:41984/" });
  assert.notEqual(changedOrigin.sourceReceiptHash, first.sourceReceiptHash);
  assert.notEqual(changedOrigin.catalogGenerationHash, first.catalogGenerationHash);

  const changedPrecedence = buildHostGlobalSkillCatalog({
    ...input,
    globalConfig: { skills: { ...input.globalConfig.skills, paths: [...input.globalConfig.skills.paths].reverse() } },
  });
  assert.notEqual(changedPrecedence.sourceReceiptHash, first.sourceReceiptHash);
  assert.notEqual(changedPrecedence.catalogGenerationHash, first.catalogGenerationHash);

  const replacementRoot = path.join(f.root, "replacement-absolute-global-skills");
  const replacement = skill(replacementRoot, "absolute-skill", "# Relocated root\n");
  const rootChanged = buildHostGlobalSkillCatalog({
    ...input,
    globalConfig: { skills: { ...input.globalConfig.skills, paths: ["relative-skills", replacementRoot] } },
    globalSkills: input.globalSkills.map((item) => item.name === replacement.name ? replacement : item),
    projectSkills: input.projectSkills.map((item) => item.name === replacement.name ? replacement : item),
  });
  assert.notEqual(rootChanged.sourceReceiptHash, first.sourceReceiptHash);
  assert.notEqual(rootChanged.catalogGenerationHash, first.catalogGenerationHash);

  const target = input.globalSkills.find((item) => item.name === "standard-skill");
  target.content = target.content.replace("# Guidance", "# Revised guidance");
  writeFileSync(target.location, readFileSync(target.location, "utf8").replace("# Guidance", "# Revised guidance"), "utf8");
  const changedContent = buildHostGlobalSkillCatalog(input);
  assert.notEqual(changedContent.catalogGenerationHash, first.catalogGenerationHash);
  assert.notEqual(
    changedContent.records.find((record) => record.logicalName === "standard-skill").targetBindingHash,
    first.records.find((record) => record.logicalName === "standard-skill").targetBindingHash,
  );
});

test("project shadowing and duplicate global names fail closed without authorizing either source", (t) => {
  const f = fixture(t);
  const base = projection(f);
  const standard = base.input.globalSkills.find((item) => item.name === "standard-skill");
  const shadow = skill(base.roots.project, "standard-skill", "# Project shadow\n");
  const shadowed = buildHostGlobalSkillCatalog({
    ...base.input,
    projectSkills: base.input.projectSkills.map((item) => item.name === "standard-skill" ? shadow : item),
  });
  assert.equal(shadowed.records.some((record) => record.logicalName === standard.name), false);
  assert.equal(shadowed.diagnostics.includes("project-shadowed-global-skill"), true);

  const duplicateRoot = path.join(f.root, "duplicate-root");
  mkdirSync(duplicateRoot, { recursive: true });
  chmodSync(duplicateRoot, 0o755);
  const duplicate = skill(duplicateRoot, "standard-skill", "# Duplicate\n");
  const duplicated = buildHostGlobalSkillCatalog({
    ...base.input,
    globalConfig: { skills: { paths: [...base.input.globalConfig.skills.paths, duplicateRoot], urls: [] } },
    globalSkills: [...base.input.globalSkills, duplicate],
    projectSkills: [...base.input.projectSkills, duplicate],
  });
  assert.equal(duplicated.records.some((record) => record.logicalName === "standard-skill"), false);
  assert.equal(duplicated.diagnostics.includes("ambiguous-global-skill"), true);
});

test("missing, symlinked, malformed, relocated, and content-drifted skills are excluded with bounded diagnostics", (t) => {
  const f = fixture(t);
  const base = projection(f);
  const standard = base.input.globalSkills.find((item) => item.name === "standard-skill");
  rmSync(standard.location);
  const agents = base.input.globalSkills.find((item) => item.name === "agents-skill");
  writeFileSync(agents.location, `${readFileSync(agents.location, "utf8")}external drift\n`, "utf8");
  const malformed = base.input.globalSkills.find((item) => item.name === "claude-skill");
  malformed.content = "# no frontmatter\n";
  writeFileSync(malformed.location, malformed.content, "utf8");
  const relative = base.input.globalSkills.find((item) => item.name === "relative-skill");
  const real = `${relative.location}.real`;
  writeFileSync(real, readFileSync(relative.location, "utf8"), "utf8");
  rmSync(relative.location);
  symlinkSync(real, relative.location);
  const relocatedRoot = `${base.roots.absolute}.real`;
  renameSync(base.roots.absolute, relocatedRoot);
  symlinkSync(relocatedRoot, base.roots.absolute);
  const result = buildHostGlobalSkillCatalog({
    ...base.input,
    globalConfig: { skills: { ...base.input.globalConfig.skills, paths: [...base.input.globalConfig.skills.paths, path.join(f.root, "missing-root")] } },
  });
  assert.equal(result.records.some((record) => ["standard-skill", "agents-skill", "claude-skill", "relative-skill", "absolute-skill"].includes(record.logicalName)), false);
  for (const code of ["missing-global-root", "missing-global-skill", "host-content-drift", "malformed-global-skill-frontmatter", "unsafe-global-root", "unsafe-global-source", "unsafe-global-skill"]) {
    assert.equal(result.diagnostics.includes(code), true, code);
  }
  assert.equal(JSON.stringify(result.diagnostics).includes(f.root), false);
});

test("nested collections and exact resource ceilings fail closed", (t) => {
  const f = fixture(t);
  const base = projection(f);
  const nested = path.join(base.roots.standard, "collection", "deep", "nested");
  mkdirSync(nested, { recursive: true });
  writeFileSync(path.join(nested, "SKILL.md"), "---\nname: nested\ndescription: nested\n---\n", "utf8");
  const nestedResult = buildHostGlobalSkillCatalog(base.input);
  assert.equal(nestedResult.records.some((record) => record.logicalName === "standard-skill"), true);
  assert.equal(nestedResult.records.some((record) => record.logicalName === "nested"), false);
  assert.equal(nestedResult.diagnostics.includes("nested-skill-collection-not-approved"), true);

  rmSync(path.join(base.roots.standard, "collection"), { recursive: true, force: true });
  const limited = buildHostGlobalSkillCatalog({
    ...base.input,
    catalogLimits: { maxCatalogEntries: 1, maxCatalogPerFileBytes: 262144, maxCatalogAggregateBytes: 16777216, maxCatalogScanDepth: 8 },
  });
  assert.deepEqual(limited.diagnostics, ["catalog-entries-exceeded"]);
  assert.deepEqual(limited.records, []);

  const perFileLimited = buildHostGlobalSkillCatalog({
    ...base.input,
    catalogLimits: { maxCatalogEntries: 1024, maxCatalogPerFileBytes: 1, maxCatalogAggregateBytes: 16777216, maxCatalogScanDepth: 8 },
  });
  assert.deepEqual(perFileLimited.diagnostics, ["catalog-per-file-bytes-exceeded"]);
  assert.deepEqual(perFileLimited.records, []);

  const aggregateLimited = buildHostGlobalSkillCatalog({
    ...base.input,
    catalogLimits: { maxCatalogEntries: 1024, maxCatalogPerFileBytes: 262144, maxCatalogAggregateBytes: 1, maxCatalogScanDepth: 8 },
  });
  assert.deepEqual(aggregateLimited.diagnostics, ["catalog-aggregate-bytes-exceeded"]);
  assert.deepEqual(aggregateLimited.records, []);
});

test("unsafe ownership modes fail closed without exposing a path", (t) => {
  const f = fixture(t);
  const base = projection(f);
  chmodSync(base.roots.agents, 0o777);
  const result = buildHostGlobalSkillCatalog(base.input);
  assert.equal(result.records.some((record) => record.logicalName === "agents-skill"), false);
  assert.equal(result.diagnostics.includes("unsafe-global-root"), true);
  assert.equal(result.diagnostics.includes("unsafe-global-source"), true);
  assert.equal(JSON.stringify(result.diagnostics).includes(f.root), false);
});

test("a symlinked sibling is excluded without discarding canonical direct children", (t) => {
  const f = fixture(t);
  const base = projection(f);
  symlinkSync(path.join(f.root, "outside"), path.join(base.roots.agents, "unsafe-sibling"));
  const result = buildHostGlobalSkillCatalog(base.input);
  assert.equal(result.records.some((record) => record.logicalName === "agents-skill"), true);
  assert.equal(result.diagnostics.includes("symlinked-global-entry"), true);
});

test("exact-origin fetch adapter reads global and project projections and rejects redirects", async (t) => {
  const f = fixture(t);
  const base = projection(f);
  const fetchImpl = async (url, options) => {
    const pathname = new URL(url).pathname;
    const directory = decodeURIComponent(options.headers["x-opencode-directory"]);
    if (pathname === "/path") return new Response(JSON.stringify(base.input.paths), { status: 200 });
    if (pathname === "/config") return new Response(JSON.stringify(directory === f.config ? base.input.globalConfig : base.input.projectConfig), { status: 200 });
    if (pathname === "/skill") return new Response(JSON.stringify(directory === f.config ? base.input.globalSkills : base.input.projectSkills), { status: 200 });
    return new Response("{}", { status: 404 });
  };
  const result = await discoverHostGlobalSkills({
    origin: base.input.origin,
    directory: f.project,
    hostVersion: "1.18.18",
    fetchImpl,
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.records.length, 5);

  const redirected = await discoverHostGlobalSkills({
    origin: base.input.origin,
    directory: f.project,
    hostVersion: "1.18.18",
    fetchImpl: async () => new Response("", { status: 302, headers: { location: "http://127.0.0.1:1/" } }),
  });
  assert.equal(redirected.ok, false);
  assert.deepEqual(redirected.diagnostics, ["host-path-status-302"]);

  const unsupported = await discoverHostGlobalSkills({
    origin: base.input.origin,
    directory: f.project,
    hostVersion: "1.17.9",
    fetchImpl,
  });
  assert.equal(unsupported.ok, false);
  assert.deepEqual(unsupported.diagnostics, ["unsupported-host-version"]);

  const unexpectedShape = await discoverHostGlobalSkills({
    origin: base.input.origin,
    directory: f.project,
    hostVersion: "1.18.18",
    fetchImpl: async (url, options) => {
      if (new URL(url).pathname === "/path") {
        return new Response(JSON.stringify({ ...base.input.paths, extra: "refused" }), { status: 200 });
      }
      return fetchImpl(url, options);
    },
  });
  assert.equal(unexpectedShape.ok, false);
  assert.deepEqual(unexpectedShape.diagnostics, ["unexpected-path-projection-field"]);

  const oversized = await discoverHostGlobalSkills({
    origin: base.input.origin,
    directory: f.project,
    hostVersion: "1.18.18",
    fetchImpl: async () => new Response("x".repeat(1024 * 1024 + 1), { status: 200 }),
  });
  assert.equal(oversized.ok, false);
  assert.deepEqual(oversized.diagnostics, ["host-path-response-too-large"]);

  const invalidUtf8 = await discoverHostGlobalSkills({
    origin: base.input.origin,
    directory: f.project,
    hostVersion: "1.18.18",
    fetchImpl: async () => new Response(Uint8Array.from([0xff]), { status: 200 }),
  });
  assert.equal(invalidUtf8.ok, false);
  assert.deepEqual(invalidUtf8.diagnostics, ["invalid-host-path-utf8"]);
});

test("catalog inspection performs no mutation even when automatic recommendations are Off", (t) => {
  const f = fixture(t);
  const base = projection(f);
  const before = new Map(base.input.globalSkills.filter((item) => item.location.startsWith("/")).map((item) => [item.location, readFileSync(item.location, "utf8")]));
  const result = buildHostGlobalSkillCatalog({ ...base.input, automaticRecommendationsEnabled: false });
  assert.equal(result.ok, true);
  assert.equal("automaticRecommendationsEnabled" in result, false);
  for (const [filePath, content] of before) assert.equal(readFileSync(filePath, "utf8"), content);
});
