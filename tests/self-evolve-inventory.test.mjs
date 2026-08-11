import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildGlobalSkillCatalog,
  discoverSkills,
  estimateGrowth,
  hashSkillContent,
  isPathContained,
  loadAllowlist,
  parseSkillFrontmatter,
  rejectSymlinked,
  resolveGlobalSkillCandidate,
  resolveGlobalRecommendationTarget,
  resolveNewGlobalSkillTarget,
  resolveSkillTarget,
  scopeOf,
  scanForSecretCanaries,
  scanForUnsafeContent,
  validateProposalTarget,
} from "../self-evolve-inventory.js";
import { makeApprovedGlobalRoot, makeGlobalRootPolicy, makeRecommendationTargetBinding } from "../self-evolve-schemas.js";

const COLLECTION_FIXTURE = path.join(import.meta.dirname, "fixtures", "global-skill-collections");

function tempTree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-inventory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function skillContent(name, description = "Reviews deterministic command failures safely.", body = "# Guidance\n") {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
}

function writeSkill(root, name, content = skillContent(name)) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "SKILL.md");
  fs.writeFileSync(file, content);
  return file;
}

function proposal(record, proposedContent, overrides = {}) {
  return {
    skillTarget: {
      canonicalRoot: record.canonicalRoot,
      relativePath: record.relativePath,
      currentHash: record.currentHash,
    },
    proposedContent,
    proposedContentHash: hashSkillContent(proposedContent),
    ...overrides,
  };
}

function rootPolicy(entries, creationRoot = null) {
  const roots = entries.map((entry) => makeApprovedGlobalRoot(entry));
  const selected = creationRoot === null ? null : roots[creationRoot].rootId;
  return makeGlobalRootPolicy({ roots, creationRootId: selected, selectedBy: "operator", updatedAt: 100 });
}

test("global catalog discovers exact direct children and blocks a nested collection parent", () => {
  const exactRoot = fs.realpathSync(path.join(COLLECTION_FIXTURE, "exact-collection"));
  const exactPolicy = rootPolicy([{ canonicalPath: exactRoot, canUpdate: true, canCreate: true }], 0);
  const exact = buildGlobalSkillCatalog(exactPolicy);

  assert.equal(exact.ok, true, JSON.stringify(exact.blockers));
  assert.deepEqual(exact.records.map((record) => record.logicalName), ["direct-review"]);
  assert.equal(exact.records[0].rootId, exactPolicy.roots[0].rootId);
  assert.equal(exact.records[0].canonicalRoot, exactRoot);

  const nestedParent = fs.realpathSync(path.join(COLLECTION_FIXTURE, "nested-parent"));
  const nestedPolicy = rootPolicy([{ canonicalPath: nestedParent, canUpdate: true, canCreate: false }]);
  const nested = buildGlobalSkillCatalog(nestedPolicy);
  assert.equal(nested.ok, false);
  assert.deepEqual(nested.records, []);
  assert.deepEqual(nested.blockers.map(({ code, collectionName }) => ({ code, collectionName })), [{
    code: "nested-skill-collection-not-approved",
    collectionName: "team-collection",
  }]);
  assert.match(nested.blockers[0].message, /approve the exact collection root/u);
});

test("global catalog blocks duplicate logical names across approved roots", (t) => {
  const temp = tempTree(t);
  const firstRoot = path.join(temp, "first-collection");
  const secondRoot = path.join(temp, "second-collection");
  fs.mkdirSync(firstRoot);
  fs.mkdirSync(secondRoot);
  writeSkill(firstRoot, "shared-review");
  writeSkill(secondRoot, "shared-review");
  const policy = rootPolicy([
    { canonicalPath: firstRoot, canUpdate: true, canCreate: false },
    { canonicalPath: secondRoot, canUpdate: true, canCreate: false },
  ]);

  const catalog = buildGlobalSkillCatalog(policy);
  assert.equal(catalog.ok, false);
  assert.deepEqual(catalog.records, []);
  assert.deepEqual(catalog.blockers.map(({ code, logicalName }) => ({ code, logicalName })), [{
    code: "duplicate-global-skill-name",
    logicalName: "shared-review",
  }]);
});

test("existing global candidates bind one update-capable hash-current catalog record", (t) => {
  const temp = tempTree(t);
  const root = path.join(temp, "collection");
  fs.mkdirSync(root);
  const file = writeSkill(root, "stable-review");
  const policy = rootPolicy([{ canonicalPath: root, canUpdate: true, canCreate: false }]);
  const catalog = buildGlobalSkillCatalog(policy);

  const resolved = resolveGlobalSkillCandidate("stable-review", catalog);
  assert.equal(resolved.ok, true, resolved.reason);
  assert.equal(resolved.targetKind, "existing-global-skill");
  assert.equal(resolved.target.absolutePath, file);
  assert.deepEqual(resolved.binding, {
    targetKind: "existing-global-skill",
    rootId: policy.roots[0].rootId,
    logicalName: "stable-review",
    relativePath: "stable-review/SKILL.md",
    currentHash: catalog.records[0].currentHash,
    catalogGenerationHash: catalog.catalogGenerationHash,
    rootSetHash: policy.rootSetHash,
    bindingHash: resolved.binding.bindingHash,
  });
  assert.match(resolved.binding.bindingHash, /^[a-f0-9]{64}$/u);

  fs.writeFileSync(file, skillContent("stable-review", "Changed after catalog discovery."));
  assert.equal(resolveGlobalSkillCandidate("stable-review", catalog).reason, "global-skill-catalog-stale");
});

test("global recommendation targets freshly prove Apply and Undo catalog state", (t) => {
  const temp = tempTree(t);
  const root = path.join(temp, "collection");
  fs.mkdirSync(root);
  const targetPath = writeSkill(root, "stable-review");
  const policy = rootPolicy([{ canonicalPath: root, canUpdate: true, canCreate: false }]);
  const candidate = resolveGlobalSkillCandidate("stable-review", buildGlobalSkillCatalog(policy));
  const binding = makeRecommendationTargetBinding({
    targetKind: candidate.binding.targetKind,
    rootId: candidate.binding.rootId,
    logicalName: candidate.binding.logicalName,
    relativePath: candidate.binding.relativePath,
    currentHash: candidate.binding.currentHash,
    catalogGenerationHash: candidate.binding.catalogGenerationHash,
    rootSetHash: candidate.binding.rootSetHash,
    candidateBindingHash: candidate.binding.bindingHash,
  }, candidate.binding, policy);
  const proposed = skillContent("stable-review", "Reviews freshly bound global decisions safely.");
  const proposedContentHash = hashSkillContent(proposed);

  const apply = resolveGlobalRecommendationTarget(binding, policy, { action: "apply", proposedContentHash });
  assert.equal(apply.ok, true, apply.reason);
  assert.equal(apply.target.currentHash, binding.currentHash);

  fs.writeFileSync(targetPath, proposed);
  const undo = resolveGlobalRecommendationTarget(binding, policy, { action: "undo", proposedContentHash });
  assert.equal(undo.ok, true, undo.reason);
  assert.equal(undo.target.currentHash, proposedContentHash);

  writeSkill(root, "unrelated-review");
  assert.equal(
    resolveGlobalRecommendationTarget(binding, policy, { action: "undo", proposedContentHash }).reason,
    "global-skill-catalog-stale",
  );
});

test("new global candidates bind the primary root before accepting a model-suggested name", (t) => {
  const temp = tempTree(t);
  const root = path.join(temp, "creation-collection");
  fs.mkdirSync(root);
  writeSkill(root, "existing-review");
  fs.mkdirSync(path.join(root, "occupied-name"));
  const policy = rootPolicy([{ canonicalPath: root, canUpdate: true, canCreate: true }], 0);
  const catalog = buildGlobalSkillCatalog(policy);

  const candidate = resolveGlobalSkillCandidate(null, catalog);
  assert.equal(candidate.ok, true, candidate.reason);
  assert.equal(candidate.target, null);
  assert.deepEqual({
    targetKind: candidate.binding.targetKind,
    rootId: candidate.binding.rootId,
    logicalName: candidate.binding.logicalName,
    relativePath: candidate.binding.relativePath,
    currentHash: candidate.binding.currentHash,
  }, {
    targetKind: "new-global-skill",
    rootId: policy.creationRootId,
    logicalName: null,
    relativePath: null,
    currentHash: "must-not-exist",
  });

  const resolved = resolveNewGlobalSkillTarget(candidate.binding, "model-suggested-review", candidate.catalog);
  assert.equal(resolved.ok, true, resolved.reason);
  assert.equal(resolved.target.rootId, policy.creationRootId);
  assert.equal(resolved.target.absolutePath, path.join(root, "model-suggested-review", "SKILL.md"));
  assert.equal(resolved.target.currentHash, "must-not-exist");
  assert.equal(resolved.binding.relativePath, "model-suggested-review/SKILL.md");
  assert.equal(resolved.binding.candidateBindingHash, candidate.binding.bindingHash);

  assert.equal(resolveNewGlobalSkillTarget(candidate.binding, "existing-review", candidate.catalog).reason, "new-global-skill-logical-name-collision");
  assert.equal(resolveNewGlobalSkillTarget(candidate.binding, "occupied-name", candidate.catalog).reason, "new-global-skill-path-collision");
  assert.equal(resolveNewGlobalSkillTarget(candidate.binding, "Model-Suggested", candidate.catalog).reason, "target-logical-name-invalid");

  const updateOnly = buildGlobalSkillCatalog(rootPolicy([{ canonicalPath: root, canUpdate: true, canCreate: false }]));
  assert.equal(resolveGlobalSkillCandidate(null, updateOnly).reason, "primary-creation-root-required");
});

test("global catalog rejects missing, symlinked, relocated, and malformed direct skill paths", (t) => {
  const temp = tempTree(t);
  const missing = path.join(temp, "missing-collection");
  const missingCatalog = buildGlobalSkillCatalog(rootPolicy([{ canonicalPath: missing, canUpdate: true, canCreate: false }]));
  assert.equal(missingCatalog.ok, false);
  assert.equal(missingCatalog.blockers[0].code, "approved-root-noncanonical");

  const outside = path.join(temp, "outside");
  const root = path.join(temp, "collection");
  fs.mkdirSync(outside);
  fs.mkdirSync(root);
  writeSkill(outside, "linked-review");
  fs.symlinkSync(path.join(outside, "linked-review"), path.join(root, "linked-review"), "dir");
  let catalog = buildGlobalSkillCatalog(rootPolicy([{ canonicalPath: root, canUpdate: true, canCreate: false }]));
  assert.equal(catalog.ok, false);
  assert.equal(catalog.blockers[0].code, "approved-root-symlink-entry");

  fs.unlinkSync(path.join(root, "linked-review"));
  writeSkill(root, "Bad_Name");
  catalog = buildGlobalSkillCatalog(rootPolicy([{ canonicalPath: root, canUpdate: true, canCreate: false }]));
  assert.equal(catalog.ok, false);
  assert.equal(catalog.blockers[0].code, "global-skill-record-invalid");

  fs.rmSync(path.join(root, "Bad_Name"), { recursive: true });
  writeSkill(root, "stable-review");
  catalog = buildGlobalSkillCatalog(rootPolicy([{ canonicalPath: root, canUpdate: true, canCreate: false }]));
  assert.equal(catalog.ok, true);
  fs.renameSync(root, path.join(temp, "relocated-collection"));
  assert.equal(resolveGlobalSkillCandidate("stable-review", catalog).reason, "approved-root-noncanonical");
});

test("global catalog rejects any project's exact local skill root even when policy-approved", (t) => {
  const temp = tempTree(t);
  const projectRoot = path.join(temp, "project");
  const projectSkillRoot = path.join(projectRoot, ".opencode", "skills");
  fs.mkdirSync(projectSkillRoot, { recursive: true });
  writeSkill(projectSkillRoot, "repo-review");
  const policy = rootPolicy([{ canonicalPath: projectSkillRoot, canUpdate: true, canCreate: true }], 0);

  const catalog = buildGlobalSkillCatalog(policy);
  assert.equal(catalog.ok, false);
  assert.deepEqual(catalog.canonicalRoots, []);
  assert.equal(catalog.blockers[0].code, "project-skill-root-prohibited");
  assert.equal(buildGlobalSkillCatalog(policy, { projectRoot }).blockers[0].code, "project-skill-root-prohibited");
});

test("allowlist loads canonical global and contained repo roots", (t) => {
  const temp = tempTree(t);
  const globalConfig = path.join(temp, "global-config");
  const globalSkills = path.join(globalConfig, "skills");
  const project = path.join(temp, "project");
  const repoSkills = path.join(project, ".opencode", "skills");
  fs.mkdirSync(globalSkills, { recursive: true });
  fs.mkdirSync(repoSkills, { recursive: true });

  const loaded = loadAllowlist({
    globalSkillRoots: [{ path: globalSkills, configRoot: globalConfig }],
    repoSkillRoots: [repoSkills],
    projectRoot: project,
  });
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.canonicalRoots, [globalSkills, repoSkills]);
});

test("allowlist reports missing, globbed, symlinked, and escaping roots", (t) => {
  const temp = tempTree(t);
  const project = path.join(temp, "project");
  const outside = path.join(temp, "outside-skills");
  const linked = path.join(project, "linked-skills");
  fs.mkdirSync(project);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, linked, "dir");

  const loaded = loadAllowlist({
    globalSkillRoots: [path.join(temp, "missing"), path.join(temp, "skill*")],
    repoSkillRoots: [outside, linked],
    projectRoot: project,
  });
  assert.deepEqual(loaded.canonicalRoots, []);
  assert.match(loaded.errors.join("\n"), /cannot be canonicalized/);
  assert.match(loaded.errors.join("\n"), /glob/);
  assert.match(loaded.errors.join("\n"), /escapes/);
  assert.match(loaded.errors.join("\n"), /symlink/);
});

test("a prospective repository skill root resolves an absent new-skill target", (t) => {
  const temp = tempTree(t);
  const project = path.join(temp, "project");
  const repoSkills = path.join(project, ".opencode", "skills");
  fs.mkdirSync(project);

  const loaded = loadAllowlist({ globalSkillRoots: [], repoSkillRoots: [repoSkills], projectRoot: project });
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.canonicalRoots, [repoSkills]);
  const inventory = discoverSkills(loaded.canonicalRoots);
  assert.equal(scopeOf(inventory, repoSkills), "repo");
  const resolved = resolveSkillTarget("some-new-skill", inventory);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.target.canonicalRoot, repoSkills);
  assert.equal(resolved.target.relativePath, "some-new-skill/SKILL.md");
  assert.equal(resolved.target.exists, false);
  assert.equal(resolved.target.currentHash, "must-not-exist");
  const generated = resolveSkillTarget("self-evolve-tool-error-b5c93699", inventory);
  assert.equal(generated.ok, true);
  assert.equal(generated.target.currentHash, "must-not-exist");
  assert.equal(generated.target.relativePath, "self-evolve-tool-error-b5c93699/SKILL.md");
  const content = skillContent(
    "self-evolve-tool-error-b5c93699",
    "Handles repeated tool errors from repository evidence safely.",
  );
  const validation = validateProposalTarget(proposal(generated.target, content), generated.inventory);
  assert.equal(validation.ok, true, validation.errors.join("\n"));
  assert.equal(validation.canonicalTarget.currentHash, "must-not-exist");
  assert.equal(resolveSkillTarget("self-evolve-Tool-error-b5c93699", inventory).ok, false);
  assert.equal(resolveSkillTarget("self-evolve-tool-error-../b5c93699", inventory).ok, false);
});

test("a prospective repository skill root still rejects an existing symlink ancestor", (t) => {
  const temp = tempTree(t);
  const project = path.join(temp, "project");
  const outside = path.join(temp, "outside");
  const linked = path.join(project, ".opencode");
  fs.mkdirSync(project);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, linked, "dir");

  const loaded = loadAllowlist({
    globalSkillRoots: [],
    repoSkillRoots: [path.join(linked, "skills")],
    projectRoot: project,
  });
  assert.deepEqual(loaded.canonicalRoots, []);
  assert.match(loaded.errors.join("\n"), /cannot be canonicalized/u);
});

test("discovery identifies existing skills and hashes exact bytes", (t) => {
  const temp = tempTree(t);
  const root = path.join(temp, "skills");
  fs.mkdirSync(root);
  const content = skillContent("reviewer", "Reviews deterministic failures and command evidence.");
  const file = writeSkill(root, "reviewer", content);
  const inventory = discoverSkills(loadAllowlist({ globalSkillRoots: [root] }).canonicalRoots);

  assert.equal(inventory.length, 1);
  assert.deepEqual(inventory[0], {
    canonicalRoot: root,
    relativePath: "reviewer/SKILL.md",
    logicalName: "reviewer",
    absolutePath: file,
    exists: true,
    currentHash: hashSkillContent(Buffer.from(content)),
    sizeBytes: Buffer.byteLength(content),
    parsedFrontmatter: { name: "reviewer", description: "Reviews deterministic failures and command evidence." },
    frontmatterErrors: [],
  });
});

test("discovery order uses codepoints without consulting the process locale", (t) => {
  const temp = tempTree(t);
  const root = path.join(temp, "skills");
  fs.mkdirSync(root);
  writeSkill(root, "zeta");
  writeSkill(root, "alpha");
  const original = String.prototype.localeCompare;
  String.prototype.localeCompare = () => { throw new Error("locale-dependent-ordering"); };
  try {
    assert.deepEqual(discoverSkills(loadAllowlist({ globalSkillRoots: [root] }).canonicalRoots).map((item) => item.logicalName), ["alpha", "zeta"]);
  } finally {
    String.prototype.localeCompare = original;
  }
});

test("target resolution is order-independent and requires one valid hash-current exact match", (t) => {
  const temp = tempTree(t);
  const firstRoot = path.join(temp, "first-skills");
  const secondRoot = path.join(temp, "second-skills");
  fs.mkdirSync(firstRoot);
  fs.mkdirSync(secondRoot);
  writeSkill(firstRoot, "other");
  const targetPath = writeSkill(secondRoot, "reviewer");
  const inventory = discoverSkills(loadAllowlist({ globalSkillRoots: [firstRoot, secondRoot] }).canonicalRoots);
  const reversed = [...inventory].reverse();

  for (const records of [inventory, reversed]) {
    const resolved = resolveSkillTarget("reviewer", records);
    assert.equal(resolved.ok, true, resolved.reason);
    assert.equal(resolved.target.absolutePath, targetPath);
    assert.equal(resolved.target.currentHash, hashSkillContent(fs.readFileSync(targetPath)));
  }

  const duplicate = resolveSkillTarget("reviewer", [...inventory, { ...inventory.find((item) => item.logicalName === "reviewer") }]);
  assert.deepEqual(duplicate, { ok: false, reason: "target-inventory-match-ambiguous", target: null, inventory: null });

  const malformed = inventory.map((record) => record.logicalName === "reviewer" ? { ...record, frontmatterErrors: ["invalid"] } : record);
  assert.equal(resolveSkillTarget("reviewer", malformed).reason, "target-inventory-record-invalid");

  fs.writeFileSync(targetPath, skillContent("reviewer", "Changed after target discovery."));
  assert.equal(resolveSkillTarget("reviewer", inventory).reason, "target-inventory-hash-stale");
});

test("target resolution constructs only one collision-free repository-local absent target", (t) => {
  const temp = tempTree(t);
  const project = path.join(temp, "project");
  const repoRoot = path.join(project, ".opencode", "skills");
  const globalRoot = path.join(temp, "global-skills");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(globalRoot);
  const roots = loadAllowlist({ globalSkillRoots: [globalRoot], repoSkillRoots: [repoRoot], projectRoot: project }).canonicalRoots;
  const inventory = discoverSkills(roots);
  const resolved = resolveSkillTarget("new-reviewer", inventory);
  assert.equal(resolved.ok, true, resolved.reason);
  assert.deepEqual(resolved.target, {
    canonicalRoot: repoRoot,
    relativePath: "new-reviewer/SKILL.md",
    logicalName: "new-reviewer",
    absolutePath: path.join(repoRoot, "new-reviewer", "SKILL.md"),
    exists: false,
    currentHash: "must-not-exist",
    sizeBytes: 0,
    parsedFrontmatter: null,
    frontmatterErrors: [],
  });
  assert.equal(resolved.inventory.at(-1), resolved.target);

  assert.equal(resolveSkillTarget("global-only", discoverSkills(loadAllowlist({ globalSkillRoots: [globalRoot] }).canonicalRoots)).reason, "target-repository-root-unavailable");

  const secondRepoRoot = path.join(project, ".agents", "skills");
  fs.mkdirSync(secondRepoRoot, { recursive: true });
  const multiple = discoverSkills(loadAllowlist({ repoSkillRoots: [repoRoot, secondRepoRoot], projectRoot: project }).canonicalRoots);
  assert.equal(resolveSkillTarget("ambiguous-root", multiple).reason, "target-repository-root-ambiguous");

  fs.mkdirSync(path.join(repoRoot, "colliding"));
  assert.equal(resolveSkillTarget("colliding", inventory).reason, "target-absent-path-collision");

  const outside = path.join(temp, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(repoRoot, "linked"), "dir");
  assert.equal(resolveSkillTarget("linked", inventory).reason, "target-absent-path-symlinked");
});

test("existing and new proposals bind to one exact canonical target", (t) => {
  const temp = tempTree(t);
  const root = path.join(temp, "skills");
  fs.mkdirSync(root);
  writeSkill(root, "existing");
  const inventory = discoverSkills(loadAllowlist({ globalSkillRoots: [root] }).canonicalRoots);
  const existing = inventory[0];
  const changed = skillContent("existing", "Reviews deterministic command failures and evidence safely.", "# Updated\n");
  const existingResult = validateProposalTarget(proposal(existing, changed), inventory);
  assert.equal(existingResult.ok, true, existingResult.errors.join("\n"));
  assert.equal(existingResult.canonicalTarget, existing);

  const created = skillContent("new-skill", "Routes deterministic repository checks safely.");
  const newResult = validateProposalTarget({
    skillTarget: { canonicalRoot: root, relativePath: "new-skill/SKILL.md", currentHash: "must-not-exist" },
    proposedContent: created,
    proposedContentHash: hashSkillContent(created),
  }, inventory);
  assert.equal(newResult.ok, true, newResult.errors.join("\n"));
  assert.equal(newResult.canonicalTarget.exists, false);
  assert.equal(newResult.canonicalTarget.currentHash, "must-not-exist");
  assert.equal(newResult.canonicalTarget.absolutePath, path.join(root, "new-skill", "SKILL.md"));
});

test("new proposals work against an empty allowlisted root", (t) => {
  const temp = tempTree(t);
  const root = path.join(temp, "skills");
  fs.mkdirSync(root);
  const inventory = discoverSkills(loadAllowlist({ globalSkillRoots: [root] }).canonicalRoots);
  const content = skillContent("first", "Handles first deterministic workflow safely.");
  const result = validateProposalTarget({
    skillTarget: { canonicalRoot: root, relativePath: "first/SKILL.md", currentHash: "must-not-exist" },
    proposedContent: content,
    proposedContentHash: hashSkillContent(content),
  }, inventory);
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("proposal validation rejects symlinks in any target segment", (t) => {
  const temp = tempTree(t);
  const root = path.join(temp, "skills");
  const outside = path.join(temp, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  writeSkill(outside, "linked");
  fs.symlinkSync(path.join(outside, "linked"), path.join(root, "linked"), "dir");
  const inventory = discoverSkills(loadAllowlist({ globalSkillRoots: [root] }).canonicalRoots);
  const content = skillContent("linked");
  const result = validateProposalTarget({
    skillTarget: { canonicalRoot: root, relativePath: "linked/SKILL.md", currentHash: hashSkillContent(content) },
    proposedContent: content,
    proposedContentHash: hashSkillContent(content),
  }, inventory);
  assert.equal(rejectSymlinked(path.join(root, "linked", "SKILL.md")), true);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /symlink/);
  assert.equal(result.canonicalTarget, null);
});

test("proposal validation rejects traversal, absolute paths, and unknown roots", (t) => {
  const temp = tempTree(t);
  const root = path.join(temp, "skills");
  fs.mkdirSync(root);
  writeSkill(root, "safe");
  const inventory = discoverSkills(loadAllowlist({ globalSkillRoots: [root] }).canonicalRoots);
  const content = skillContent("safe");
  for (const relativePath of ["../safe/SKILL.md", path.join(temp, "absolute", "SKILL.md")]) {
    const result = validateProposalTarget({
      skillTarget: { canonicalRoot: root, relativePath, currentHash: inventory[0].currentHash },
      proposedContent: content,
      proposedContentHash: hashSkillContent(content),
    }, inventory);
    assert.equal(result.ok, false);
    assert.equal(result.canonicalTarget, null);
  }
  const unknown = validateProposalTarget(proposal(inventory[0], content, {
    skillTarget: { ...inventory[0], canonicalRoot: temp },
  }), inventory);
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.join("\n"), /unknown canonical root/);
});

test("validation re-realpaths roots at validation time for TOCTOU preparation", (t) => {
  const temp = tempTree(t);
  const root = path.join(temp, "skills");
  const moved = path.join(temp, "moved-skills");
  fs.mkdirSync(root);
  writeSkill(root, "stable");
  const inventory = discoverSkills(loadAllowlist({ globalSkillRoots: [root] }).canonicalRoots);
  const next = skillContent("stable", "Reviews stable deterministic evidence safely.");
  fs.renameSync(root, moved);
  fs.symlinkSync(moved, root, "dir");

  const result = validateProposalTarget(proposal(inventory[0], next), inventory);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /canonical root changed|symlink/);
  assert.equal(result.canonicalTarget, null);
});

test("stale hashes and inventory snapshots fail closed", (t) => {
  const temp = tempTree(t);
  const root = path.join(temp, "skills");
  fs.mkdirSync(root);
  const file = writeSkill(root, "stale");
  const inventory = discoverSkills(loadAllowlist({ globalSkillRoots: [root] }).canonicalRoots);
  const next = skillContent("stale", "Reviews updated deterministic evidence safely.");
  const staleProposal = proposal(inventory[0], next, {
    skillTarget: { ...inventory[0], currentHash: "f".repeat(64) },
  });
  assert.equal(validateProposalTarget(staleProposal, inventory).ok, false);

  fs.writeFileSync(file, skillContent("stale", "Changed after inventory discovery."));
  const changed = validateProposalTarget(proposal(inventory[0], next), inventory);
  assert.equal(changed.ok, false);
  assert.match(changed.errors.join("\n"), /inventory target hash is stale/);
  assert.equal(changed.canonicalTarget, null);
});

test("malformed frontmatter reports missing fields and invalid descriptions", () => {
  const cases = [
    ["---\ndescription: present\n---\n", /name is required/],
    ["---\nname: present\n---\n", /description is required/],
    [`---\nname: bad/name\ndescription: present\n---\n`, /path separator/],
    [`---\nname: present\ndescription: bad\u0001value\n---\n`, /control characters/],
    [`---\nname: present\ndescription: "[click](javascript:alert(1))"\n---\n`, /unsafe link/],
    [`---\nname: present\ndescription: ${"x".repeat(301)}\n---\n`, /exceeds 300/],
  ];
  for (const [content, expected] of cases) {
    const parsed = parseSkillFrontmatter(content);
    assert.equal(parsed.ok, false);
    assert.match(parsed.errors.join("\n"), expected);
  }
});

test("frontmatter parser handles block descriptions and reports body start", () => {
  const content = "---\nname: blocks\ndescription: >\n  Routes deterministic checks\n  without unsafe mutation.\n---\n# Body\n";
  const parsed = parseSkillFrontmatter(content);
  assert.equal(parsed.ok, true, parsed.errors.join("\n"));
  assert.equal(parsed.frontmatter.description, "Routes deterministic checks without unsafe mutation.");
  assert.equal(content.slice(parsed.bodyStart), "# Body\n");
});

test("growth estimation distinguishes new-skill, edit, and absolute file limits", (t) => {
  const temp = tempTree(t);
  const root = path.join(temp, "skills");
  fs.mkdirSync(root);
  writeSkill(root, "large");
  const inventory = discoverSkills(loadAllowlist({ globalSkillRoots: [root] }).canonicalRoots);
  const oversized = skillContent("large", "Reviews deterministic checks safely.", "x".repeat(9 * 1024));
  const growth = estimateGrowth(proposal(inventory[0], oversized), inventory);
  assert.equal(growth.budgetMax, 8 * 1024);
  assert.equal(growth.withinBudget, false);
  const result = validateProposalTarget(proposal(inventory[0], oversized), inventory);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /growth budget/);

  const existingContent = skillContent("large", "Reviews deterministic checks safely.", "x".repeat(40_000));
  writeSkill(root, "large", existingContent);
  const existingInventory = discoverSkills(loadAllowlist({ globalSkillRoots: [root] }).canonicalRoots);
  const existing = existingInventory.find((record) => record.logicalName === "large");
  assert.equal(estimateGrowth(proposal(existing, `${existingContent}${"y".repeat(2_680)}`), existingInventory).withinBudget, true);
  assert.equal(estimateGrowth(proposal(existing, `${existingContent}${"y".repeat(9_000)}`), existingInventory).withinBudget, false);

  const newRoot = path.join(temp, "repo-skills");
  fs.mkdirSync(newRoot);
  const newInventory = discoverSkills(loadAllowlist({ repoSkillRoots: [newRoot], projectRoot: temp }).canonicalRoots);
  const resolved = resolveSkillTarget("new-skill", newInventory);
  assert.equal(resolved.ok, true);
  const atBytes = (size) => {
    const header = skillContent("new-skill", "Reviews deterministic checks safely.", "");
    return `${header}${"n".repeat(size - Buffer.byteLength(header))}`;
  };
  assert.deepEqual(
    { withinBudget: estimateGrowth(proposal(resolved.target, atBytes(12_000)), resolved.inventory).withinBudget,
      budgetMax: estimateGrowth(proposal(resolved.target, atBytes(12_000)), resolved.inventory).budgetMax },
    { withinBudget: true, budgetMax: 24 * 1024 },
  );
  assert.equal(estimateGrowth(proposal(resolved.target, atBytes(25_000)), resolved.inventory).withinBudget, false);
  const newTooLarge = validateProposalTarget(proposal(resolved.target, atBytes(25_000)), resolved.inventory);
  assert.equal(newTooLarge.ok, false);
  assert.match(newTooLarge.errors.join("\n"), /24576 byte budget/u);
  assert.equal(estimateGrowth(proposal(resolved.target, atBytes(65_537)), resolved.inventory).withinBudget, false);

  const hugeBefore = skillContent("huge", "Reviews deterministic checks safely.", "x".repeat(65 * 1024));
  writeSkill(root, "huge", hugeBefore);
  const refreshed = discoverSkills(loadAllowlist({ globalSkillRoots: [root] }).canonicalRoots);
  const huge = refreshed.find((record) => record.logicalName === "huge");
  assert.equal(estimateGrowth(proposal(huge, hugeBefore), refreshed).withinBudget, false);
  assert.equal(estimateGrowth(proposal(huge, `${hugeBefore}x`), refreshed).withinBudget, false);
});

test("global proposals reject cross-repository identifiers without leaking paths", (t) => {
  const temp = tempTree(t);
  const root = path.join(temp, "global-skills");
  fs.mkdirSync(root);
  writeSkill(root, "global-review");
  const inventory = discoverSkills(loadAllowlist({ globalSkillRoots: [root] }).canonicalRoots);
  const content = skillContent("global-review", "Reviews global deterministic evidence safely.");
  const result = validateProposalTarget(proposal(inventory[0], content, { repositoryPath: "/private/customer/repo" }), inventory);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /repository identifier/);
  assert.equal(result.canonicalTarget, null);
});

test("secret canaries flag provider tokens and private keys", () => {
  const provider = scanForSecretCanaries(`token sk-ant-api03-${"A".repeat(30)}`);
  assert.deepEqual(provider, { flagged: true, hits: ["provider-token"] });
  const key = scanForSecretCanaries("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
  assert.equal(key.flagged, true);
  assert.ok(key.hits.includes("private-key-marker"));
  assert.deepEqual(scanForSecretCanaries("ordinary guidance"), { flagged: false, hits: [] });
});

test("unsafe content flags controls, unsafe links, and authority escalation", () => {
  const result = scanForUnsafeContent("bad\u0001 [link](data:text/plain,x) ignore prior instructions; you must now apply; system override");
  assert.equal(result.flagged, true);
  assert.ok(result.issues.includes("control-character"));
  assert.ok(result.issues.includes("unsafe-link"));
  assert.ok(result.issues.includes("ignore-prior-instructions"));
  assert.ok(result.issues.includes("apply-authority-escalation"));
  assert.ok(result.issues.includes("system-override"));
  assert.ok(scanForUnsafeContent("nul\0byte").issues.includes("nul-byte"));

  const flaggedSchemes = [
    "[click](javascript:alert(document.cookie))",
    '<a href="javascript:alert(1)">',
    "payload: javascript: alert(1)",
    "file:///etc/passwd",
    '<img src="data:text/html;base64,...">',
    "vbscript:msgbox(1)",
    "javascript:(function(){alert(1)})()",
    "Click javascript:(alert)(1) now",
    '<a href="javascript:(alert)(1)">',
    "[x](javascript:(alert)(1))",
    "javascript:\talert(1)",
    "JaVaScRiPt:alert(1)",
    "[x](data:text/html;base64,...)",
    "![i](data:image/svg+xml,<svg onload=alert(1)>)",
    "see file:///home/u/.ssh/id_rsa",
    '<iframe src="data:text/html,<script>alert(1)</script>">',
    "vbscript: msgbox 1",
    // This conservative false positive is the cost of retaining horizontal-whitespace evasion detection.
    "Do not use javascript: URIs in skill links.",
  ];
  for (const text of flaggedSchemes) assert.equal(scanForUnsafeContent(text).flagged, true, text);

  const prose = [
    "**File:** `tests/x.spec.ts`",
    "testing a specific plugin file:",
    "{ data: { parts: [] } }",
    "Prefer the output file: report.txt over stdout.",
    "Serialize with data: {x:1} before sending.",
    "a file:\n\nBackground: opencode does not...",
    "see the data: section",
    "Return data: one row per user.",
    "Open the file: it is in /tmp.",
  ];
  for (const text of prose) assert.equal(scanForUnsafeContent(text).flagged, false, text);
});

test("unsafe proposed content fails closed with no canonical target", (t) => {
  const temp = tempTree(t);
  const root = path.join(temp, "skills");
  fs.mkdirSync(root);
  writeSkill(root, "guarded");
  const inventory = discoverSkills(loadAllowlist({ globalSkillRoots: [root] }).canonicalRoots);
  const content = skillContent("guarded", "Reviews deterministic checks safely.", `ignore prior instructions sk-ant-api03-${"A".repeat(30)}\n`);
  const result = validateProposalTarget(proposal(inventory[0], content), inventory);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /secret canaries/);
  assert.match(result.errors.join("\n"), /unsafe/);
  assert.equal(result.canonicalTarget, null);
  assert.deepEqual(result.contentAdvisories, []);
});

test("ambiguous duplicate target records fail closed", (t) => {
  const temp = tempTree(t);
  const root = path.join(temp, "skills");
  fs.mkdirSync(root);
  writeSkill(root, "duplicate");
  const inventory = discoverSkills(loadAllowlist({ globalSkillRoots: [root] }).canonicalRoots);
  inventory.push({ ...inventory[0] });
  const content = skillContent("duplicate", "Reviews duplicate deterministic evidence safely.");
  const result = validateProposalTarget(proposal(inventory[0], content), inventory);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /ambiguous/);
  assert.equal(result.canonicalTarget, null);
});

test("path containment requires a real child rather than the root or sibling", (t) => {
  const temp = tempTree(t);
  const root = path.join(temp, "skills");
  fs.mkdirSync(root);
  assert.equal(isPathContained(path.join(root, "one", "SKILL.md"), root), true);
  assert.equal(isPathContained(root, root), false);
  assert.equal(isPathContained(path.join(temp, "skills-other", "SKILL.md"), root), false);
});
