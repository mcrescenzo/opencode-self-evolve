import assert from "node:assert/strict";
import test from "node:test";
import {
  ANALYZER_SYSTEM_PROMPT,
  ANALYZER_TOOLS,
  SELF_EVOLVE_ANALYZER_AGENT,
  buildAnalyzerPrompt,
} from "../analyzer-prompt.js";

test("the hidden analyzer denies every tool and the denylist is frozen", () => {
  assert.equal(Object.isFrozen(ANALYZER_TOOLS), true);
  assert.equal(Object.values(ANALYZER_TOOLS).every((value) => value === false), true);
  // The denylist must cover the tool surfaces a model could otherwise use to escape the sandbox.
  for (const tool of ["read", "glob", "grep", "list", "lsp", "edit", "bash", "task", "webfetch", "websearch", "skill", "question", "todowrite"]) {
    assert.equal(ANALYZER_TOOLS[tool], false, `${tool} must be denied`);
  }
  // No accidental "true" tool can sneak in without failing the every() check above; also assert exact key set.
  assert.deepEqual([...Object.keys(ANALYZER_TOOLS)].sort(), [
    "bash", "edit", "glob", "grep", "list", "lsp", "question", "read", "skill", "task", "todowrite", "webfetch", "websearch",
  ]);
});

test("the analyzer system prompt enforces strict JSON, untrusted input, and no mutation", () => {
  assert.match(ANALYZER_SYSTEM_PROMPT, /strict JSON only/i);
  assert.match(ANALYZER_SYSTEM_PROMPT, /untrusted/i);
  assert.match(ANALYZER_SYSTEM_PROMPT, /must not ask to auto-edit|cannot use tools and must not/i);
  assert.match(ANALYZER_SYSTEM_PROMPT, /mutate external systems/i);
});

test("buildAnalyzerPrompt embeds the JSON contract, directory, trigger, and transcript", () => {
  const prompt = buildAnalyzerPrompt({ transcript: { text: "user ran /check twice" }, trigger: { kind: "manual" }, directory: "/repo" });
  assert.match(prompt, /Return exactly one JSON object/u);
  assert.match(prompt, /"additionalProperties":false/u);
  assert.match(prompt, /Directory: \/repo/u);
  assert.match(prompt, /Trigger: manual/u);
  assert.match(prompt, /user ran \/check twice/u);
  assert.match(prompt, /untrusted|prompt injection/u);
  // The advertised confidence bound must remain [0, 1].
  assert.match(prompt, /"confidence":\{"type":"number","minimum":0,"maximum":1\}/u);
});

test("buildAnalyzerPrompt tolerates a missing transcript and unknown directory", () => {
  const prompt = buildAnalyzerPrompt({});
  assert.match(prompt, /Directory: unknown/u);
  assert.match(prompt, /\[empty transcript\]/u);
});

test("SELF_EVOLVE_ANALYZER_AGENT is re-exported and stable", () => {
  assert.equal(typeof SELF_EVOLVE_ANALYZER_AGENT, "string");
  assert.ok(SELF_EVOLVE_ANALYZER_AGENT.length > 0);
});
