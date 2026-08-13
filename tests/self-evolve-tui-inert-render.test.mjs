import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = new URL("../scripts/tui-inert-smoke.mjs", import.meta.url);
const compiler = new URL("../scripts/compile-tui-artifact.mjs", import.meta.url);
const source = new URL("../self-evolve-tui.tsx", import.meta.url);
const root = new URL("..", import.meta.url).pathname;

test("native control center mounts a zero-authority inert recovery shell on startup trust failure", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-inert-render-"));
  const compiled = path.join(temporary, "self-evolve-tui.compiled.mjs");
  const smoke = path.join(temporary, "tui-inert-smoke.mjs");
  try {
    for (const dependency of ["self-evolve-tui.js", "self-evolve-tui-store.js"]) {
      symlinkSync(path.join(root, dependency), path.join(temporary, dependency));
    }
    symlinkSync(path.join(root, "node_modules"), path.join(temporary, "node_modules"));
    writeFileSync(smoke, readFileSync(script, "utf8"));
    const compilation = spawnSync("bun", [compiler.pathname, source.pathname, compiled], {
      cwd: root,
      encoding: "utf8",
      env: process.env,
    });
    assert.equal(compilation.status, 0, `${compilation.stdout}\n${compilation.stderr}`);

    const result = spawnSync("bun", ["--conditions=browser", smoke, compiled], {
      cwd: root,
      encoding: "utf8",
      env: process.env,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const receipt = JSON.parse(result.stdout);
    assert.deepEqual(receipt, {
      ok: true,
      registered: { route: true, sidebar: true, paletteLayer: true, modeEscape: true },
      rendered: { recoveryDiagnostic: true, retry: true, failureCard: true },
      escapeRestoration: true,
      retrySuccess: true,
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
