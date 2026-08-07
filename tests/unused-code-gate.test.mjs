import assert from "node:assert/strict";
import test from "node:test";

import { checkScopedFiles, findUnusedBindings } from "../scripts/check-unused-code.mjs";

test("unused-code gate detects dead declarations and parameters", () => {
  const source = `
    const deadValue = 1;
    function callback(used, ignored) { return used; }
    callback(1, 2);
  `;
  assert.deepEqual(findUnusedBindings(source), [
    "fixture.js: unused declaration deadValue",
    "fixture.js: unused parameter callback(ignored)",
  ]);
});

test("unused-code gate permits only exact callback-signature allowances", () => {
  const source = "function callback(required) { return true; } callback(1);";
  assert.deepEqual(findUnusedBindings(source, "fixture.js", new Set(["fixture.js:callback:required"])), []);
  assert.deepEqual(findUnusedBindings(source, "fixture.js", new Set(["fixture.js:other:required"])), [
    "fixture.js: unused parameter callback(required)",
  ]);
});

test("scoped production files contain no unused simple bindings", () => {
  assert.deepEqual(checkScopedFiles(), []);
});
