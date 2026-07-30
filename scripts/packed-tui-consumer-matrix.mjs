import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const FLOOR = "1.18.3";
const ADJACENT = "1.18.4";
const OPENTUI_VERSION = "0.4.3";
const SOLID_VERSION = "1.9.12";

function fail(message, detail = "") {
  throw new Error(detail ? `${message}\n${detail}` : message);
}

function run(command, args, { cwd, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: env ?? process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const label = [command, ...args].join(" ");
  if (result.error) fail(`${label} could not run (${result.error.code ?? "spawn-error"})`, result.error.message);
  if (result.signal) fail(`${label} terminated by ${result.signal}`);
  if (result.status !== 0) fail(`${label} exited with ${result.status}`, `${result.stdout}\n${result.stderr}`.trim());
  return result.stdout.trim();
}

export function parseExact118Version(value) {
  const match = /^1\.18\.(0|[1-9]\d*)$/u.exec(String(value));
  return match ? { version: match[0], patch: Number(match[1]) } : null;
}

export function resolveLatestCommon18(openCodeVersions, pluginVersions) {
  const pluginSet = new Set((pluginVersions ?? []).map(String));
  const common = (openCodeVersions ?? [])
    .map(parseExact118Version)
    .filter((value) => value && value.patch >= 3 && pluginSet.has(value.version))
    .sort((left, right) => right.patch - left.patch);
  if (!common.length) throw new Error("no-common-stable-1.18.x-version");
  return common[0].version;
}

function npmVersions(name, env) {
  const source = run("npm", ["view", name, "versions", "--json"], { cwd: repoRoot, env });
  const value = JSON.parse(source);
  return Array.isArray(value) ? value : [value];
}

function packArtifact(root, env) {
  const source = run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], {
    cwd: repoRoot,
    env,
  });
  const value = JSON.parse(source);
  const packed = Array.isArray(value) ? value[0] : value;
  if (!packed?.filename || !Array.isArray(packed.files)) fail("npm pack omitted artifact inventory");
  const tarball = path.join(root, packed.filename);
  const bytes = readFileSync(tarball);
  const inventory = packed.files.map((file) => ({
    path: file.path,
    size: file.size,
    mode: file.mode,
  })).sort((left, right) => left.path.localeCompare(right.path));
  return {
    tarball,
    artifactSha256: createHash("sha256").update(bytes).digest("hex"),
    inventorySha256: createHash("sha256").update(JSON.stringify(inventory)).digest("hex"),
    fileCount: inventory.length,
  };
}

function runLane({ label, version, packageName, artifact, root, env }) {
  const consumer = path.join(root, `consumer-${label}`);
  mkdirSync(consumer);
  writeFileSync(path.join(consumer, "package.json"), `${JSON.stringify({
    private: true,
    type: "module",
  }, null, 2)}\n`);
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
    "--legacy-peer-deps",
    artifact.tarball,
    `opencode-ai@${version}`,
    `@opencode-ai/plugin@${version}`,
    `@opentui/core@${OPENTUI_VERSION}`,
    `@opentui/keymap@${OPENTUI_VERSION}`,
    `@opentui/solid@${OPENTUI_VERSION}`,
    `solid-js@${SOLID_VERSION}`,
  ], { cwd: consumer, env });
  const smoke = `
    import { readFileSync } from "node:fs";
    import path from "node:path";
    const packageJSON = (name) => JSON.parse(readFileSync(path.join(process.cwd(), "node_modules", ...name.split("/"), "package.json"), "utf8"));
    const tui = await import(${JSON.stringify(`${packageName}/tui`)});
    if (Object.keys(tui).join(",") !== "default") throw new Error("TUI target exposed unexpected named exports");
    if (tui.default?.id !== "mcrescenzo.self-evolve" || typeof tui.default?.tui !== "function") {
      throw new Error("TUI target did not load as TuiPluginModule");
    }
    const observed = {
      opencode: packageJSON("opencode-ai").version,
      plugin: packageJSON("@opencode-ai/plugin").version,
      core: packageJSON("@opentui/core").version,
      keymap: packageJSON("@opentui/keymap").version,
      opentuiSolid: packageJSON("@opentui/solid").version,
      solid: packageJSON("solid-js").version,
    };
    if (observed.opencode !== ${JSON.stringify(version)} || observed.plugin !== ${JSON.stringify(version)}) {
      throw new Error("aligned OpenCode/plugin version mismatch: " + JSON.stringify(observed));
    }
    process.stdout.write(JSON.stringify(observed));
  `;
  const observed = JSON.parse(run("bun", ["--eval", smoke], { cwd: consumer, env }));
  return { label, requestedVersion: version, observed, ok: true };
}

export function main() {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-tui-matrix-"));
  const env = {
    ...process.env,
    npm_config_cache: path.join(root, "npm-cache"),
  };
  try {
    const packageJSON = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const openCodeVersions = npmVersions("opencode-ai", env);
    const pluginVersions = npmVersions("@opencode-ai/plugin", env);
    const latest = resolveLatestCommon18(openCodeVersions, pluginVersions);
    const artifact = packArtifact(root, env);
    const lanes = [
      { label: "floor", version: FLOOR },
      { label: "adjacent", version: ADJACENT },
      { label: "latest-supported", version: latest },
    ];
    const results = lanes.map((lane) => runLane({
      ...lane,
      packageName: packageJSON.name,
      artifact,
      root,
      env,
    }));
    const report = {
      ok: true,
      package: {
        name: packageJSON.name,
        version: packageJSON.version,
        artifactSha256: artifact.artifactSha256,
        inventorySha256: artifact.inventorySha256,
        fileCount: artifact.fileCount,
      },
      resolution: {
        range: "OpenCode >=1.18.3 <1.19.0 and @opencode-ai/plugin ~1.18.3",
        latestCommonStable: latest,
        resolvedAt: new Date().toISOString(),
      },
      fixedPeers: {
        "@opentui/core": OPENTUI_VERSION,
        "@opentui/keymap": OPENTUI_VERSION,
        "@opentui/solid": OPENTUI_VERSION,
        "solid-js": SOLID_VERSION,
      },
      lanes: results,
    };
    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try { main(); } catch (error) {
    console.error(`Packed TUI consumer matrix failed: ${error.message}`);
    process.exitCode = 1;
  }
}
