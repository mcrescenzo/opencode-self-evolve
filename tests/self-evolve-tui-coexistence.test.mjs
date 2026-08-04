import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveCoexistenceInvocation } from "../scripts/tui-coexistence-smoke.mjs";

const repository = path.resolve(import.meta.dirname, "..");
const sibling = path.resolve(repository, "..", "opencode-workflows");

test("coexistence wrapper delegates both product candidates to the Workflows harness", () => {
  const invocation = resolveCoexistenceInvocation(["--attempts", "10", "--witness"]);
  assert.equal(invocation.runner, path.join(sibling, "scripts", "tui-coexistence-smoke.mjs"));
  assert.deepEqual(invocation.args, [
    invocation.runner,
    "--self-evolve",
    repository,
    "--workflows",
    sibling,
    "--attempts",
    "10",
    "--witness",
  ]);
});

test("packed Workflows candidates use an explicit runner checkout", () => {
  const invocation = resolveCoexistenceInvocation([
    "--workflows",
    "/tmp/workflows.tgz",
    "--runner",
    "/opt/workflows-runner",
    "--symlinked-config",
  ]);
  assert.equal(invocation.runner, "/opt/workflows-runner/scripts/tui-coexistence-smoke.mjs");
  assert.deepEqual(invocation.args.slice(1), [
    "--self-evolve",
    repository,
    "--workflows",
    "/tmp/workflows.tgz",
    "--symlinked-config",
  ]);
});

test("both packed candidates are forwarded without changing the runner", () => {
  const invocation = resolveCoexistenceInvocation([
    "--self-evolve",
    "/tmp/self-evolve.tgz",
    "--workflows",
    "/tmp/workflows.tgz",
    "--runner",
    "/opt/workflows-runner",
    "--witness",
  ]);
  assert.deepEqual(invocation.args.slice(1), [
    "--self-evolve",
    "/tmp/self-evolve.tgz",
    "--workflows",
    "/tmp/workflows.tgz",
    "--witness",
  ]);
});

test("duplicate wrapper-only options fail closed", () => {
  assert.throws(
    () => resolveCoexistenceInvocation(["--runner", "/one", "--runner", "/two"]),
    /only once/u,
  );
});
