import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), "..");
const PRIVATE_PATH_RE = /(?:^|\/)(?:\.opencode|\.beads|\.git|node_modules|\.remember|\.claude)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|(?:^|\/)[^/]*\.logs?$|(?:^|\/)logs?(?:\/|$)/iu;
const FORBIDDEN_MODULES = ["child_process", "node:child_process", "fetch", "http", "node:http", "https", "node:https", "net", "node:net"];
const MODULE_SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/gu;

function fail(message, detail = "") {
  throw new Error(detail ? `${message}\n${detail}` : message);
}

function commandText(command, args) {
  return [command, ...args].join(" ");
}

export function assertSpawnSucceeded(result, command, args) {
  const label = commandText(command, args);
  if (result?.error) {
    const code = String(result.error.code ?? "spawn-error");
    fail(`${label} could not be executed (${code})`, String(result.error.message ?? result.error));
  }
  if (result?.signal) fail(`${label} was terminated by signal ${result.signal}`);
  if (result?.status !== 0) {
    const status = result?.status === null || result?.status === undefined ? "unknown" : result.status;
    fail(`${label} exited with status ${status}`, [result?.stdout, result?.stderr].filter(Boolean).join("\n"));
  }
  return result;
}

function run(command, args, { cwd, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: env ?? process.env,
  });
  return assertSpawnSucceeded(result, command, args);
}

function normalizePackagePath(value) {
  return String(value).replace(/^\.\//u, "").replaceAll("\\", "/").replace(/\/$/u, "");
}

export function assertPublicFilesManifest(packageJSON) {
  if (!Array.isArray(packageJSON.files) || packageJSON.files.length === 0) fail("package.json files must be a non-empty array");
  const files = packageJSON.files.map(normalizePackagePath);
  const unsafe = files.filter((file) => !file || file === "." || file.includes("..") || PRIVATE_PATH_RE.test(file));
  if (unsafe.length) fail(`package.json files contains forbidden private runtime state: ${unsafe.join(", ")}`);
  if (new Set(files).size !== files.length) fail("package.json files contains duplicate entries");
  return files;
}

export function expectedArtifactFiles(packageJSON) {
  return new Set(["package.json", "README.md", "LICENSE", ...assertPublicFilesManifest(packageJSON)]);
}

export function assertExactArtifactFiles(actualPaths, packageJSON) {
  const expected = expectedArtifactFiles(packageJSON);
  const actual = new Set(actualPaths.map(normalizePackagePath));
  const privateFiles = [...actual].filter((file) => PRIVATE_PATH_RE.test(file));
  if (privateFiles.length) fail(`Package artifact includes private runtime state: ${privateFiles.join(", ")}`);
  const missing = [...expected].filter((file) => !actual.has(file));
  const extra = [...actual].filter((file) => !expected.has(file));
  if (missing.length || extra.length) {
    fail("Package artifact file set does not exactly match package.json files plus npm-required metadata", [
      missing.length ? `Missing: ${missing.join(", ")}` : "",
      extra.length ? `Unexpected: ${extra.join(", ")}` : "",
    ].filter(Boolean).join("\n"));
  }
  return actual;
}

export function assertNoForbiddenImports(file, source) {
  const forbidden = [];
  for (const match of source.matchAll(MODULE_SPECIFIER_RE)) {
    if (FORBIDDEN_MODULES.includes(match[1])) forbidden.push(match[1]);
  }
  if (forbidden.length) fail(`${file} imports prohibited runtime modules: ${[...new Set(forbidden)].join(", ")}`);
}

export function assertServerEntryContract(source) {
  const defaultExports = source.match(/\bexport\s+default\b/gu) ?? [];
  const namedExports = source.match(/\bexport\s+(?:const|let|var|function|class|\{)/gu) ?? [];
  if (defaultExports.length !== 1 || namedExports.length !== 0) fail("Server entry must expose exactly one default export and no named exports");
  if (/(?:@opencode-ai\/plugin\/tui|@opentui\/|["']\.\/(?:self-evolve-)?tui(?:\.js)?["'])/u.test(source)) {
    fail("Server entry imports a prohibited TUI/OpenTUI target");
  }
}

function parsePackResult(stdout) {
  if (typeof stdout !== "string" || !stdout.trim()) fail("npm pack returned empty output");
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    fail("npm pack did not return valid JSON", stdout);
  }
  const pack = Array.isArray(result) ? result[0] : result;
  if (!pack?.filename || !Array.isArray(pack.files)) fail("npm pack JSON omitted filename or file inventory", stdout);
  return pack;
}

export async function main({ repoRoot = process.env.SELF_EVOLVE_PACK_ROOT ?? defaultRepoRoot } = {}) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "self-evolve-pack-"));
  try {
    const packageJSON = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    assertPublicFilesManifest(packageJSON);
    const npmEnv = { ...process.env, npm_config_cache: path.join(tempRoot, "npm-cache") };
    const packed = parsePackResult(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", tempRoot], { cwd: repoRoot, env: npmEnv }).stdout);
    const files = assertExactArtifactFiles(packed.files.map((file) => file.path), packageJSON);
    const tarball = path.join(tempRoot, packed.filename);
    if (!existsSync(tarball)) fail(`Expected npm pack output was not created: ${tarball}`);

    const extractDir = path.join(tempRoot, "extract");
    mkdirSync(extractDir);
    run("tar", ["-xzf", tarball, "-C", extractDir], { cwd: tempRoot });
    for (const file of files) {
      if (!file.endsWith(".js")) continue;
      assertNoForbiddenImports(file, readFileSync(path.join(extractDir, "package", file), "utf8"));
    }
    assertServerEntryContract(readFileSync(path.join(extractDir, "package", "self-evolve.js"), "utf8"));

    const consumerDir = path.join(tempRoot, "consumer");
    mkdirSync(consumerDir);
    writeFileSync(path.join(consumerDir, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--omit=optional", "--omit=peer", tarball], { cwd: consumerDir, env: npmEnv });
    if (existsSync(path.join(consumerDir, "node_modules", "@opencode-ai", "plugin"))) {
      fail("Fresh consumer unexpectedly installed the optional @opencode-ai/plugin peer");
    }
    const opentuiScope = path.join(consumerDir, "node_modules", "@opentui");
    if (existsSync(opentuiScope)) fail("Headless consumer unexpectedly installed @opentui peers");

    const smoke = [
      `const server = await import(${JSON.stringify(packageJSON.name)});`,
      `if (typeof server.default !== "function") throw new Error("server default export is not a Plugin factory");`,
      `if (Object.keys(server).join(",") !== "default") throw new Error("server target exposes named exports");`,
      `const tui = await import(${JSON.stringify(`${packageJSON.name}/tui`)});`,
      `if (!tui.default || tui.default.id !== "mcrescenzo.self-evolve" || typeof tui.default.tui !== "function") throw new Error("TUI default export does not have TuiPluginModule shape");`,
    ].join("\n");
    run(process.execPath, ["--input-type=module", "--eval", smoke], { cwd: consumerDir });

    console.log(`Pack artifact check passed: ${files.size} exact files; server and TUI targets imported from a fresh consumer.`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(`Pack artifact check failed: ${error.message}`);
    process.exitCode = 1;
  });
}
