import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("leaked successful fixture", () => {
  mkdirSync(path.join(tmpdir(), "leaked-success"));
});
