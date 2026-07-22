import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createApplier } from "../self-evolve-applier.js";
import { createCommandPolicy } from "../self-evolve-commands.js";
import { createIntegration } from "../self-evolve-integration.js";
import * as inventory from "../self-evolve-inventory.js";
import * as observation from "../self-evolve-observation.js";
import { createPipeline } from "../self-evolve-pipeline.js";
import { createPrivacyGuard } from "../self-evolve-privacy.js";
import { createScheduler } from "../self-evolve-scheduler.js";
import * as schemas from "../self-evolve-schemas.js";
import { openStore } from "../self-evolve-store.js";
import * as synthesis from "../self-evolve-synthesis.js";

const CHILD = fileURLToPath(new URL("./fixtures/apply-live-owner.mjs", import.meta.url));
const SYNTHESIS_CHILD = fileURLToPath(new URL("./fixtures/synthesis-live-owner.mjs", import.meta.url));
const PROJECT = inventory.hashSkillContent("live-owner-project");
const CURRENT = "---\nname: live-owner\ndescription: Handles process lease recovery safely.\n---\n# Live Owner\nKeep the current instruction.\n";
const PROPOSED = `${CURRENT}Verify ownership before recovery.\n`;

function waitFor(predicate, label) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const poll = () => predicate() ? resolve() : Date.now() >= deadline ? reject(new Error(`timeout:${label}`)) : setTimeout(poll, 5);
    poll();
  });
}

function seed(root) {
  const stateRoot = path.join(root, "state");
  const skillRoot = path.join(root, "skills");
  const skillDir = path.join(skillRoot, "live-owner");
  fs.mkdirSync(skillDir, { recursive: true });
  const target = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(target, CURRENT);
  const records = inventory.discoverSkills(inventory.loadAllowlist({ globalSkillRoots: [skillRoot] }).canonicalRoots);
  const store = openStore(stateRoot, { projectFingerprint: PROJECT, now: () => Date.now(), staleLockMs: 20 });
  const settings = store.getSettings();
  store.setGlobalSettings(schemas.makeGlobalSettings({ ...settings.global, mode: "auto", allowedSkillRoots: [skillRoot], updatedAt: Date.now() }));
  const proposal = schemas.makeProposal({
    id: "live-owner-proposal", projectFingerprint: PROJECT, clusterId: inventory.hashSkillContent("cluster"),
    skillTarget: { canonicalRoot: skillRoot, relativePath: "live-owner/SKILL.md", currentHash: records[0].currentHash },
    proposedContentHash: inventory.hashSkillContent(PROPOSED), rationaleText: "Process ownership must be recovered conservatively.",
    synthesizedAt: Date.now(), synthesizerModelId: "mock", criticScore: 0.95, criticPassed: true,
    validDeterministic: true, state: "pending", injectionFlagged: false,
  });
  store.appendRecord(schemas.wrapRecord("proposal", proposal, Date.now()));
  const approved = schemas.makeDecision({ proposalId: proposal.id, targetHash: proposal.skillTarget.currentHash, proposedContentHash: proposal.proposedContentHash, decisionVersion: 1, actor: "reviewer", timestamp: Date.now(), nonce: "live-owner-approval", priorState: "pending", newState: "approved" });
  assert.equal(store.commitDecision(approved).ok, true);
  const content = Buffer.from(PROPOSED).toString("base64");
  store.appendRecord(schemas.wrapRecord("proposal-content", schemas.makeProposalContent({ proposalId: proposal.id, contentHash: proposal.proposedContentHash, contentEncoding: "base64", chunkIndex: 0, chunkCount: 1, content }), Date.now()));
  const proposedPath = path.join(root, "proposed.txt");
  fs.writeFileSync(proposedPath, PROPOSED);
  store.close();
  return { stateRoot, skillRoot, target, proposedPath, proposal };
}

function runtime(f) {
  const store = openStore(f.stateRoot, { projectFingerprint: PROJECT, now: () => Date.now(), staleLockMs: 20 });
  const roots = inventory.loadAllowlist({ globalSkillRoots: [f.skillRoot] }).canonicalRoots;
  const records = inventory.discoverSkills(roots);
  const privacy = createPrivacyGuard({ consent: {}, projectFingerprint: PROJECT, store, now: () => Date.now() });
  const applier = createApplier({ store, inventory: { records, canonicalRoots: roots }, privacy, now: () => Date.now() });
  const commands = createCommandPolicy({ store, privacy, now: () => Date.now() });
  return { store, integration: createIntegration({ store, inventory, privacy, schemas, observation, synthesisModule: synthesis, applier, commands, pipeline: { createPipeline }, scheduler: { createScheduler }, options: {}, now: () => Date.now() }) };
}

for (const point of ["apply-before-pending-audit", "apply-after-pending-audit", "apply-after-readback-audit"]) {
  test(`live apply owner defers second boot at ${point} and completes exactly once`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-live-apply-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const f = seed(root);
    const barrier = path.join(root, "barrier");
    const release = path.join(root, "release");
    const child = spawn(process.execPath, [CHILD, f.stateRoot, f.skillRoot, PROJECT, f.proposal.id, f.proposedPath, point, barrier, release], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    await waitFor(() => fs.existsSync(barrier), point);
    const second = runtime(f);
    const boot = await second.integration.boot({ ctx: { directory: root, client: { session: {} } }, recoverHostSessions: false });
    assert.equal(boot.ok, true);
    assert.equal(boot.recovered.some((item) => item.proposalId === f.proposal.id && item.deferred), true, JSON.stringify(boot.recovered));
    assert.equal(second.store.getRecord("proposal", f.proposal.id).payload.state, "approved");
    await second.integration.shutdown();
    fs.writeFileSync(release, "release");
    const exit = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", (code, signal) => resolve({ code, signal })); });
    assert.deepEqual(exit, { code: 0, signal: null }, stderr);
    assert.equal(JSON.parse(stdout.trim()).ok, true);
    const finalStore = openStore(f.stateRoot, { projectFingerprint: PROJECT, now: () => Date.now(), staleLockMs: 20 });
    assert.equal(fs.readFileSync(f.target, "utf8"), PROPOSED);
    assert.equal(finalStore.getRecord("proposal", f.proposal.id).payload.state, "applied");
    const applies = finalStore.readRecords("audit-event").filter((record) => record.payload.kind === "apply" && record.payload.proposalId === f.proposal.id && record.payload.details?.["readback-verified"] === true);
    assert.equal(applies.length, 1);
    assert.deepEqual(createApplier({ store: finalStore, inventory: { records: inventory.discoverSkills([f.skillRoot]), canonicalRoots: [f.skillRoot] }, privacy: createPrivacyGuard({ consent: {}, projectFingerprint: PROJECT, store: finalStore }) }).recoverPending(), []);
    finalStore.close();
  });
}

test("live synthesis provider owner defers boot recovery and completes one accepted outcome", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-live-synthesis-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const barrier = path.join(root, "provider-open");
  const release = path.join(root, "release");
  const marker = path.join(root, "provider-calls.log");
  fs.writeFileSync(marker, "");
  const child = spawn(process.execPath, [SYNTHESIS_CHILD, root, PROJECT, barrier, release, marker], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  await waitFor(() => fs.existsSync(barrier), "synthesis provider barrier");

  let store = openStore(root, { projectFingerprint: PROJECT, now: () => Date.now(), staleLockMs: 20 });
  let pipeline = createPipeline({ store, inventory, privacy: {}, synthesis: {}, applier: { close() {} }, commands: {}, schemas, observation, now: () => Date.now() });
  const deferred = pipeline.recoverSynthesisAttempts();
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].deferred, true);
  assert.equal(store.readRecords("audit-event").map((record) => schemas.parseSynthesisOutcomeAuditEvent(record.payload)).filter(Boolean).length, 0);
  assert.equal(store.readRecords("proposal").some((record) => record.payload.state === "failed-closed"), false);
  pipeline.close();

  fs.writeFileSync(release, "release");
  const exit = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", (code, signal) => resolve({ code, signal })); });
  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  store = openStore(root, { projectFingerprint: PROJECT, now: () => Date.now(), staleLockMs: 20 });
  const outcomes = store.readRecords("audit-event").map((record) => schemas.parseSynthesisOutcomeAuditEvent(record.payload)).filter(Boolean);
  assert.equal(store.readRecords("synthesis-attempt").length, 1);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, "accepted");
  assert.equal(store.readRecords("proposal").at(-1).payload.state, "pending");
  const calls = fs.readFileSync(marker, "utf8").trim().split("\n");
  assert.deepEqual(calls, [synthesis.SYNTHESIS_AGENT_NAME, synthesis.CRITIC_AGENT_NAME]);
  pipeline = createPipeline({ store, inventory, privacy: {}, synthesis: {}, applier: { close() {} }, commands: {}, schemas, observation, now: () => Date.now() });
  assert.deepEqual(pipeline.recoverSynthesisAttempts(), []);
  pipeline.close();
});
