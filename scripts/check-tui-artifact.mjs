import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
export const TUI_SOURCE_FILE = "self-evolve-tui.tsx";
export const GENERATED_TUI_FILE = "self-evolve-tui.generated.js";
const EXPECTED_EXPORT = `./${GENERATED_TUI_FILE}`;
const EXTERNAL_IMPORTS = new Set([
  "@opentui/solid",
  "solid-js",
  "timers/promises",
  "./self-evolve-tui.js",
  "./self-evolve-tui-store.js",
]);
const TUI_COMPILER_FILE = path.join(repoRoot, "scripts", "compile-tui-artifact.mjs");
const MODULE_SPECIFIER_RE = /\bfrom\s*["']([^"']+)["']/gu;

function fail(message, detail = "") {
  throw new Error(detail ? `${message}\n${detail}` : message);
}

export function compileTuiArtifact(output, { root = repoRoot } = {}) {
  const entry = path.join(root, TUI_SOURCE_FILE);
  const result = spawnSync("bun", [TUI_COMPILER_FILE, entry, output], { cwd: root, encoding: "utf8" });
  if (result.error) fail(`OpenTUI Solid compiler could not run (${result.error.code ?? "spawn-error"})`, result.error.message);
  if (result.signal) fail(`OpenTUI Solid compiler terminated by ${result.signal}`);
  if (result.status !== 0) fail(`OpenTUI Solid compiler exited with ${result.status}`, `${result.stdout}\n${result.stderr}`.trim());
  if (!existsSync(output)) fail(`OpenTUI Solid compiler omitted its output: ${output}`);
  return readFileSync(output, "utf8");
}

export function assertApprovedTuiPackageContract(packageJSON, source) {
  if (packageJSON.exports?.["./tui"] !== EXPECTED_EXPORT) fail(`package ./tui export must resolve to ${EXPECTED_EXPORT}`);
  if (!packageJSON.files?.includes(TUI_SOURCE_FILE)) fail("TUI source is missing from package files");
  if (!packageJSON.files?.includes(GENERATED_TUI_FILE)) fail("generated TUI artifact is missing from package files");
  if (!packageJSON.files?.includes("self-evolve-tui-store.js")) fail("target-exclusive TUI store is missing from package files");
  if (packageJSON.dependencies && Object.keys(packageJSON.dependencies).length) fail("ordinary runtime dependencies are prohibited");
  const expectedPeers = {
    "@opencode-ai/plugin": "~1.18.3",
    "@opentui/core": ">=0.4.5 <0.6.0",
    "@opentui/keymap": ">=0.4.5 <0.6.0",
    "@opentui/solid": ">=0.4.5 <0.6.0",
    "solid-js": "1.9.12",
  };
  if (JSON.stringify(packageJSON.peerDependencies) !== JSON.stringify(expectedPeers)) fail("optional peer contract does not match maintainer approval");
  for (const peer of Object.keys(expectedPeers)) {
    if (packageJSON.peerDependenciesMeta?.[peer]?.optional !== true) fail(`${peer} must remain an optional peer`);
    if (packageJSON.devDependencies?.[peer] === undefined) fail(`${peer} must remain available for development verification`);
  }
  for (const lifecycle of ["preinstall", "install", "postinstall"]) {
    if (packageJSON.scripts?.[lifecycle]) fail(`${lifecycle} lifecycle scripts are prohibited`);
  }
  if (!source.startsWith("/** @jsxImportSource @opentui/solid */")) fail("TUI source must declare the approved OpenTUI JSX source");
  if (!/import type \{[^}]*\bTuiPluginModule\b[^}]*\} from "@opencode-ai\/plugin\/tui"/u.test(source)) {
    fail("TUI source must bind the public TuiPluginModule contract");
  }
  if (!/export default SelfEvolveTuiModule/u.test(source)) fail("TUI source must have one default module export");
  for (const required of [
    "api.slots.register",
    "sidebar_content()",
    "api.route.register",
    "api.mode.push(CONTROL_CENTER_MODE)",
    "CONTROL_CENTER_SECTIONS",
    "parseControlCenterDestination",
    "controlCenterRouteParams",
    "openControlCenter(card.destination)",
    "name: CONTROL_CENTER_COMMAND",
    'namespace: "palette"',
    "mode: CONTROL_CENTER_MODE",
    'key: "escape"',
    "cmd: closeControlCenter",
  ]) {
    if (!source.includes(required)) fail(`TUI source is missing native surface contract: ${required}`);
  }
  if (/\b(?:slashName|slashAliases)\b|api\.command\b|api\.renderer\b|api\.ui\.toast\b|api\.attention\.notify\b/u.test(source)) {
    fail("TUI source contains prohibited slash, deprecated, renderer, toast, or attention behavior");
  }
  if (/ReviewDialog|openReview|REVIEW_DIALOG_ID/u.test(source)) {
    fail("TUI source contains the retired normal-path review dialog");
  }
  return true;
}

export function assertGeneratedTuiArtifact(source) {
  if (source.includes("sourceMappingURL") || source.includes("@jsxImportSource") || /\bimport\s+type\b/u.test(source)) {
    fail("generated TUI artifact retains source-map or TypeScript-only syntax");
  }
  if (/\bjsxDEV\b|@opentui\/solid\/jsx-(?:dev-)?runtime/u.test(source)) {
    fail("generated TUI artifact bypassed the supported OpenTUI Solid transform");
  }
  const imports = [...source.matchAll(MODULE_SPECIFIER_RE)].map((match) => match[1]);
  const unexpected = imports.filter((specifier) => !EXTERNAL_IMPORTS.has(specifier));
  const missing = [...EXTERNAL_IMPORTS].filter((specifier) => !imports.includes(specifier));
  if (unexpected.length || missing.length) {
    fail("generated TUI artifact import inventory changed", [
      unexpected.length ? `Unexpected: ${[...new Set(unexpected)].join(", ")}` : "",
      missing.length ? `Missing: ${missing.join(", ")}` : "",
    ].filter(Boolean).join("\n"));
  }
  for (const prohibited of [
    "@opencode-ai/plugin/tui",
    "function createIntegration",
    "function createPipeline",
    "function createScheduler",
    "function createApplier",
    "function createSynthesizer",
  ]) {
    if (source.includes(prohibited)) fail(`generated TUI artifact bundled prohibited runtime content: ${prohibited}`);
  }
  const exportStatements = source.match(/\bexport\s+(?:default\b|\{)/gu)?.length ?? 0;
  const exactDefaultExport = /\bexport\s+default\s+[A-Za-z_$][\w$]*\s*;?\s*$/u.test(source)
    || /\bexport\s*\{\s*[A-Za-z_$][\w$]*\s+as\s+default\s*\}\s*;?\s*$/u.test(source);
  if (!source.includes('id: "mcrescenzo.self-evolve"')
      || exportStatements !== 1
      || !exactDefaultExport
      || /\bexport\s+(?:const|let|var|function|class)\b/u.test(source)) {
    fail("generated TUI artifact omitted its stable default module contract");
  }
  return true;
}

export function assertCurrentTuiArtifact(expected, actual) {
  if (actual !== expected) fail("generated TUI artifact is stale; run npm run build:tui");
  return true;
}

export function main({ root = repoRoot, check = process.argv.includes("--check") } = {}) {
  const packageJSON = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const source = readFileSync(path.join(root, TUI_SOURCE_FILE), "utf8");
  assertApprovedTuiPackageContract(packageJSON, source);
  const temporary = mkdtempSync(path.join(tmpdir(), "self-evolve-tui-build-"));
  const output = path.join(root, GENERATED_TUI_FILE);
  let publishTemp = null;
  try {
    const first = compileTuiArtifact(path.join(temporary, "first.js"), { root });
    const second = compileTuiArtifact(path.join(temporary, "second.js"), { root });
    assertCurrentTuiArtifact(first, second);
    assertGeneratedTuiArtifact(first);
    if (check) {
      if (!existsSync(output)) fail(`generated TUI artifact is missing: ${GENERATED_TUI_FILE}`);
      assertCurrentTuiArtifact(first, readFileSync(output, "utf8"));
    } else {
      publishTemp = path.join(root, `.${GENERATED_TUI_FILE}.${process.pid}.tmp`);
      writeFileSync(publishTemp, first, { mode: 0o644 });
      renameSync(publishTemp, output);
      publishTemp = null;
    }
    const sha256 = createHash("sha256").update(first).digest("hex");
    console.log(`${check ? "Verified" : "Generated"} deterministic TUI artifact ${GENERATED_TUI_FILE} (${sha256}).`);
    return { sha256, bytes: Buffer.byteLength(first), output };
  } finally {
    if (publishTemp && existsSync(publishTemp)) rmSync(publishTemp, { force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try { main(); } catch (error) {
    console.error(`TUI artifact check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
