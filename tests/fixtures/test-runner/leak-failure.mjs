import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("leaked failing fixture", () => {
  mkdirSync(path.join(tmpdir(), "leaked-failure"));
  assert.fail("injected child failure");
});
