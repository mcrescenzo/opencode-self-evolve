import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("../scripts/tui-render-smoke.mjs", import.meta.url);

test("compiled native control center renders nullable states and updates reactively", () => {
  const result = spawnSync("bun", ["--conditions=browser", script.pathname], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const receipt = JSON.parse(result.stdout);
  assert.deepEqual(receipt, {
    ok: true,
    renderedSections: ["home", "recommendations", "activity", "settings"],
    reactiveLastCycle: true,
  });
});
