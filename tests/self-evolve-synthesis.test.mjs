import assert from "node:assert/strict";
import { test } from "node:test";
import * as synthesis from "../self-evolve-synthesis.js";
import { DEFAULT_BUDGETS } from "../self-evolve-schemas.js";
import {
  SELF_EVOLVE_CRITIC_AGENT,
  SELF_EVOLVE_SYNTHESIZER_AGENT,
} from "../self-evolve-core.js";

const H = "a".repeat(64);

test("synthesis module exposes only the current global provider path and cleanup helpers", () => {
  assert.equal(synthesis.SYNTHESIS_AGENT_NAME, SELF_EVOLVE_SYNTHESIZER_AGENT);
  assert.equal(synthesis.CRITIC_AGENT_NAME, SELF_EVOLVE_CRITIC_AGENT);
  for (const retired of [
    "SYNTHESIS_OUTPUT_SCHEMA",
    "buildSynthesizerPrompt",
    "buildCriticPrompt",
    "parseSynthesizerOutput",
    "proposalRationale",
    "runSynthesis",
    "runCritic",
    "resetSynthesisProcessStateForTests",
  ]) {
    assert.equal(Object.hasOwn(synthesis, retired), false, `${retired} must remain deleted`);
  }
  assert.equal(typeof synthesis.runGlobalSynthesis, "function");
  assert.equal(Object.isFrozen(synthesis.GLOBAL_SYNTHESIS_OUTPUT_SCHEMA), true);
  assert.equal(Object.isFrozen(synthesis.CRITIC_OUTPUT_SCHEMA), true);
});

test("structured provider output bounds remain deterministic", () => {
  assert.equal(synthesis.effectiveTokensPerSynthesis(0), synthesis.MIN_TOKENS_PER_SYNTHESIS);
  assert.equal(
    synthesis.outputByteLimit(synthesis.SYNTHESIS_TOKEN_BUDGET),
    Math.max(synthesis.SYNTHESIS_TOKEN_BUDGET * 4, 96 * 1024),
  );
  assert.throws(() => synthesis.outputByteLimit(-1), /invalid-tokensPerSynthesis/u);

  const accepted = synthesis.parseCriticOutput({
    score: 0.9,
    evidenceLinked: true,
    nonDuplicative: true,
    reasons: ["bounded evidence supports the recommendation"],
    recommendedAction: "accept",
  });
  assert.equal(accepted.ok, true);
  assert.equal(synthesis.parseCriticOutput("```json\n{}\n```").ok, false);
});

test("fresh token budget reads the current durable settings", () => {
  let tokensPerSynthesis = DEFAULT_BUDGETS.tokensPerSynthesis;
  const store = {
    getSettings: () => ({
      global: { budgets: { tokensPerSynthesis } },
      repo: { budgets: {} },
    }),
  };
  assert.equal(synthesis.freshTokensPerSynthesis({ store }), synthesis.effectiveTokensPerSynthesis(tokensPerSynthesis));
  tokensPerSynthesis += 1024;
  assert.equal(synthesis.freshTokensPerSynthesis({ store }), synthesis.effectiveTokensPerSynthesis(tokensPerSynthesis));
});

test("historical attempt leases remain cleanup-only and strictly bound", () => {
  const attempt = { projectFingerprint: H, clusterId: H, targetHash: H };
  const key = synthesis.synthesisLeaseKey(attempt);
  assert.match(key, /^synthesis_[a-f0-9]{64}$/u);
  assert.throws(
    () => synthesis.synthesisLeaseKey({ ...attempt, clusterId: "invalid" }),
    /invalid-synthesis-lease-binding/u,
  );

  const releases = [];
  const store = { releaseLease: (...args) => { releases.push(args); return { ok: true }; } };
  assert.deepEqual(synthesis.releaseSynthesisLease(store, { key, nonce: "nonce" }), { ok: true });
  assert.deepEqual(releases, [[key, "nonce"]]);
  assert.equal(synthesis.releaseSynthesisLease({}, { key, nonce: "nonce" }).ok, false);
});
