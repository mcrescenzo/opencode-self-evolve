import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { withStateMutationLock } from "../self-evolve-lock.js";

test("reentrant mutation locks reject asynchronous actions", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => withStateMutationLock(root, () => withStateMutationLock(root, () => Promise.resolve("unsafe"))),
    /mutation-lock-action-must-be-synchronous/u,
  );
});
