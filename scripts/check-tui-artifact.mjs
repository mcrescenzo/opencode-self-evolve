import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const entry = path.join(repoRoot, "self-evolve-tui.tsx");
const expectedExport = "./self-evolve-tui.tsx";

function fail(message, detail = "") {
  throw new Error(detail ? `${message}\n${detail}` : message);
}

function runBunBuild(output) {
  const result = spawnSync("bun", [
    "build",
    "--no-bundle",
    "--target=bun",
    "--format=esm",
    `--outfile=${output}`,
    entry,
  ], { cwd: repoRoot, encoding: "utf8" });
  if (result.error) fail(`bun build could not run (${result.error.code ?? "spawn-error"})`, result.error.message);
  if (result.signal) fail(`bun build terminated by ${result.signal}`);
  if (result.status !== 0) fail(`bun build exited with ${result.status}`, `${result.stdout}\n${result.stderr}`.trim());
}

export function assertApprovedTuiPackageContract(packageJSON, source) {
  if (packageJSON.exports?.["./tui"] !== expectedExport) fail(`package ./tui export must resolve to ${expectedExport}`);
  if (!packageJSON.files?.includes("self-evolve-tui.tsx")) fail("raw TUI artifact is missing from package files");
  if (!packageJSON.files?.includes("self-evolve-tui-store.js")) fail("target-exclusive TUI store is missing from package files");
  if (packageJSON.dependencies && Object.keys(packageJSON.dependencies).length) fail("ordinary runtime dependencies are prohibited");
  const expectedPeers = {
    "@opencode-ai/plugin": "~1.18.3",
    "@opentui/core": ">=0.4.3 <0.5.0",
    "@opentui/keymap": ">=0.4.3 <0.5.0",
    "@opentui/solid": ">=0.4.3 <0.5.0",
    "solid-js": "1.9.12",
  };
  if (JSON.stringify(packageJSON.peerDependencies) !== JSON.stringify(expectedPeers)) fail("optional peer contract does not match maintainer approval");
  for (const peer of Object.keys(expectedPeers)) {
    if (packageJSON.peerDependenciesMeta?.[peer]?.optional !== true) fail(`${peer} must remain an optional peer`);
  }
  for (const lifecycle of ["preinstall", "install", "postinstall"]) {
    if (packageJSON.scripts?.[lifecycle]) fail(`${lifecycle} lifecycle scripts are prohibited`);
  }
  if (!source.startsWith("/** @jsxImportSource @opentui/solid */")) fail("raw TUI artifact must declare the approved OpenTUI JSX source");
  if (!/import type \{[^}]*\bTuiPluginModule\b[^}]*\} from "@opencode-ai\/plugin\/tui"/u.test(source)) {
    fail("raw TUI artifact must bind the public TuiPluginModule contract");
  }
  if (!/export default SelfEvolveTuiModule/u.test(source)) fail("raw TUI artifact must have one default module export");
  for (const required of [
    'api.slots.register',
    'sidebar_content()',
    'api.ui.dialog.replace',
    'api.ui.dialog.setSize("xlarge")',
    'api.route.register',
    'api.mode.push("self-evolve-control-center")',
    'name: CONTROL_CENTER_COMMAND',
    'namespace: "palette"',
  ]) {
    if (!source.includes(required)) fail(`raw TUI artifact is missing native surface contract: ${required}`);
  }
  if (/\b(?:slashName|slashAliases)\b|api\.command\b|api\.renderer\b|api\.ui\.toast\b|api\.attention\.notify\b/u.test(source)) {
    fail("raw TUI artifact contains prohibited slash, deprecated, renderer, toast, or attention behavior");
  }
  return true;
}

export function main() {
  const packageJSON = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const source = readFileSync(entry, "utf8");
  assertApprovedTuiPackageContract(packageJSON, source);
  const temporary = mkdtempSync(path.join(tmpdir(), "self-evolve-tui-build-"));
  try {
    const output = path.join(temporary, "self-evolve-tui.mjs");
    runBunBuild(output);
    const built = readFileSync(output, "utf8");
    if (!built.includes("./self-evolve-tui.js") || !built.includes("export")) fail("transpiled TUI artifact omitted its target-exclusive module contract");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  console.log("Raw TUI artifact contract and disposable Bun transpilation passed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try { main(); } catch (error) {
    console.error(`TUI artifact check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
