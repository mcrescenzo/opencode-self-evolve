import assert from "node:assert/strict";
import test from "node:test";

import {
  HISTORICAL_SELF_EVOLVE_AGENTS,
  HISTORICAL_SELF_EVOLVE_ANALYZER_AGENT,
  SELF_EVOLVE_CRITIC_AGENT,
  SELF_EVOLVE_MODULE_ID,
  SELF_EVOLVE_SOURCE,
  SELF_EVOLVE_SYNTHESIZER_AGENT,
  durableEventBody,
  isDurableLifecycleEvent,
  parseCommand,
} from "../self-evolve-core.js";

test("runtime and cleanup-only identities are exact and immutable", () => {
  assert.equal(SELF_EVOLVE_MODULE_ID, "mcrescenzo.self-evolve");
  assert.equal(SELF_EVOLVE_SOURCE, SELF_EVOLVE_MODULE_ID);
  assert.equal(SELF_EVOLVE_SYNTHESIZER_AGENT, `${SELF_EVOLVE_MODULE_ID}.synthesizer`);
  assert.equal(SELF_EVOLVE_CRITIC_AGENT, `${SELF_EVOLVE_MODULE_ID}.critic`);
  assert.equal(HISTORICAL_SELF_EVOLVE_ANALYZER_AGENT, `${SELF_EVOLVE_MODULE_ID}.analyzer`);
  assert.deepEqual(HISTORICAL_SELF_EVOLVE_AGENTS, {
    analyzer: "self-evolve-analyzer",
    synthesizer: "self-evolve-synthesizer",
    critic: "self-evolve-critic",
  });
  assert.equal(Object.isFrozen(HISTORICAL_SELF_EVOLVE_AGENTS), true);
});

test("durable lifecycle classification accepts only the stable event surface", () => {
  for (const type of ["session.compacted", "session.idle", "session.status"]) {
    assert.equal(isDurableLifecycleEvent({ type }), true);
    assert.equal(isDurableLifecycleEvent({ event: { type } }), true);
  }
  for (const value of [null, {}, { type: "message.updated" }, { event: null }, { event: { type: "session.created" } }]) {
    assert.equal(isDurableLifecycleEvent(value), false);
  }
  const nested = { type: "session.idle" };
  assert.equal(durableEventBody({ event: nested }), nested);
});

test("command parser is pure and grants no hidden-agent authority", () => {
  assert.deepEqual(parseCommand(""), { verb: "default" });
  assert.deepEqual(parseCommand("status"), { verb: "status" });
  assert.deepEqual(parseCommand("dismiss proposal-1"), { verb: "dismiss", proposalID: "proposal-1" });
  assert.deepEqual(parseCommand("unknown"), { verb: "error", message: "Unknown /self-evolve command: unknown" });
});
