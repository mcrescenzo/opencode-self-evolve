import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const LIVE_EVIDENCE_ENV = "SELF_EVOLVE_RELEASE_B_OPERATOR_EVIDENCE";
export const OPENCODE_BIN_ENV = "SELF_EVOLVE_RELEASE_B_OPENCODE_BIN";
export const OUTPUT_ENV = "SELF_EVOLVE_RELEASE_B_OUTPUT";
export const TIMEOUT_ENV = "SELF_EVOLVE_RELEASE_B_TIMEOUT_MS";
export const RECEIPT_SCHEMA_VERSION = 1;
export const RELEASE_A_TUI_COMMIT = "6a1014a608800b038e8efdf21445b03c161f1a9f";

const root = path.resolve(import.meta.dirname, "..");
const witnessSource = path.join(
  root,
  "tests",
  "fixtures",
  "release-b-operator-evidence",
  "witness.mjs",
);
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_RECEIPT_BYTES = 512 * 1024;
const POLICY_FILES = Object.freeze(["package.json", "bun.lock", "AGENTS.md"]);
const OPENTUI_PACKAGES = Object.freeze([
  "@opentui/core",
  "@opentui/keymap",
  "@opentui/solid",
]);
const STAGES = Object.freeze([
  Object.freeze({
    stage: 1,
    columns: 140,
    rows: 40,
    frameNames: Object.freeze([
      "startup-sidebar",
      "wide-home-pointer",
      "wide-recommendations",
      "wide-activity",
      "wide-settings",
      "wide-ready-sidebar",
      "wide-recommendation-enter",
      "wide-recommendation-safety",
      "wide-recommendation-token",
      "wide-recommendation-scrolled",
      "wide-applied-palette",
    ]),
    proofNames: Object.freeze([
      "noAmbientUiBeforeActivation",
      "productionTuiEntryActive",
      "productionTuiPackedArtifactPath",
      "pointerOpenedSidebarDeepLink",
      "fourSectionsRendered",
      "longApprovedRootRenderedOnlyInSettings",
      "escapeRestoredExactPriorRoute",
      "readyStateRendered",
      "enterOpenedRecommendationDeepLink",
      "recommendationDetailScrolledWithPointer",
      "paletteOpenedHome",
    ]),
  }),
  Object.freeze({
    stage: 2,
    columns: 80,
    rows: 24,
    frameNames: Object.freeze([
      "startup-sidebar",
      "medium-setup-space",
      "medium-setup-consent",
      "medium-waiting",
      "medium-failure",
      "medium-new-tui-old-server",
    ]),
    proofNames: Object.freeze([
      "noAmbientUiBeforeActivation",
      "productionTuiEntryActive",
      "productionTuiPackedArtifactPath",
      "spaceOpenedSettingsDeepLink",
      "waitingStateRendered",
      "failureStateRendered",
      "newTuiOldServerLimitedWithoutAuthority",
    ]),
  }),
  Object.freeze({
    stage: 3,
    columns: 64,
    rows: 20,
    frameNames: Object.freeze(["startup-sidebar", "narrow-home", "narrow-settings"]),
    proofNames: Object.freeze([
      "noAmbientUiBeforeActivation",
      "productionTuiEntryActive",
      "productionTuiPackedArtifactPath",
      "narrowLayoutRenderedWithoutHorizontalOverflow",
      "restartFreshProcess",
      "restartUsedDistinctProject",
    ]),
  }),
  Object.freeze({
    stage: 4,
    columns: 140,
    rows: 40,
    frameNames: Object.freeze([
      "legacy-startup-sidebar",
      "legacy-new-server-sidebar",
      "legacy-new-server-control-center",
    ]),
    proofNames: Object.freeze([
      "noAmbientUiBeforeActivation",
      "legacyTuiEntryActive",
      "legacyTuiPinnedArtifactPath",
      "legacyTuiIgnoredAdditiveDashboard",
      "legacyControlCenterOpened",
      "legacyEscapeRestoredExactPriorRoute",
    ]),
  }),
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function exists(filePath) {
  return fs.access(filePath).then(() => true, () => false);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function readBoundedJson(filePath, maximum = MAX_RECEIPT_BYTES) {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > maximum) {
      throw new Error("evidence receipt has invalid size");
    }
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

async function readHostLogDiagnostics(directories) {
  const candidates = [
    path.join(directories.xdgData, "opencode", "log"),
    path.join(directories.xdgState, "opencode", "log"),
    path.join(directories.xdgCache, "opencode", "log"),
    path.join(directories.home, ".local", "share", "opencode", "log"),
  ];
  const files = [];
  const queue = candidates.map((directory) => ({ directory, depth: 0 }));
  while (queue.length && files.length < 64) {
    const current = queue.shift();
    const entries = await fs.readdir(current.directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const filePath = path.join(current.directory, entry.name);
      if (entry.isDirectory() && current.depth < 3) {
        queue.push({ directory: filePath, depth: current.depth + 1 });
      } else if (entry.isFile() && /(?:log|diagnostic)/iu.test(entry.name)) {
        files.push(filePath);
      }
    }
  }
  files.sort();
  const output = [];
  for (const filePath of files.slice(-3)) {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile() || stat.size > 5 * 1024 * 1024) continue;
    const source = await fs.readFile(filePath, "utf8").catch(() => "");
    output.push(source.slice(-64 * 1024));
  }
  return output.join("\n").slice(-MAX_OUTPUT_BYTES);
}

export function parseTimeout(value) {
  if (value === undefined || value === "") return DEFAULT_TIMEOUT_MS;
  if (!/^[0-9]+$/.test(String(value))) {
    throw new Error(`${TIMEOUT_ENV} must be a base-10 integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) {
    throw new Error(`${TIMEOUT_ENV} must be from ${MIN_TIMEOUT_MS} through ${MAX_TIMEOUT_MS}`);
  }
  return parsed;
}

export function liveOptions(env = process.env) {
  if (env[LIVE_EVIDENCE_ENV] !== "1") {
    throw new Error(`set ${LIVE_EVIDENCE_ENV}=1 to run production TUI evidence`);
  }
  const opencodeBin = env[OPENCODE_BIN_ENV];
  if (typeof opencodeBin !== "string" || !path.isAbsolute(opencodeBin)) {
    throw new Error(`${OPENCODE_BIN_ENV} must be an absolute path`);
  }
  const outputPath = env[OUTPUT_ENV];
  if (outputPath !== undefined && (!outputPath || !path.isAbsolute(outputPath))) {
    throw new Error(`${OUTPUT_ENV} must be an absolute path when set`);
  }
  return {
    opencodeBin: path.resolve(opencodeBin),
    outputPath: outputPath ? path.resolve(outputPath) : null,
    timeoutMs: parseTimeout(env[TIMEOUT_ENV]),
  };
}

export function assertSupportedOpenCodeVersion(value) {
  const actual = String(value ?? "").trim();
  const match = /^1\.18\.([0-9]+)$/.exec(actual);
  if (!match || Number(match[1]) < 3) {
    throw new Error(`OpenCode >=1.18.3 <1.19.0 is required; observed ${actual || "no version"}`);
  }
  return actual;
}

export function alignedTuiPackages(pluginManifest) {
  if (!isRecord(pluginManifest) || pluginManifest.name !== "@opencode-ai/plugin") {
    throw new Error("installed OpenCode plugin manifest is invalid");
  }
  const patches = OPENTUI_PACKAGES.map((name) => {
    const range = pluginManifest.peerDependencies?.[name];
    const match = /^>=0\.4\.([0-9]+)$/u.exec(String(range ?? ""));
    if (!match) throw new Error(`unsupported OpenCode peer range for ${name}: ${range ?? "missing"}`);
    return Number(match[1]);
  });
  const patch = Math.max(...patches);
  if (!Number.isSafeInteger(patch) || patch < 3) {
    throw new Error("OpenCode requires an unsupported OpenTUI floor");
  }
  const version = `0.4.${patch}`;
  return Object.freeze({
    "@opentui/core": version,
    "@opentui/keymap": version,
    "@opentui/solid": version,
    "solid-js": "1.9.12",
  });
}

export function validateInstalledCandidateManifest(candidate, candidateVersion) {
  if (candidate.name !== "@mcrescenzo/opencode-self-evolve"
    || candidate.version !== candidateVersion
    || candidate.exports?.["./tui"] !== "./self-evolve-tui.generated.js") {
    throw new Error("installed production TUI candidate identity is invalid");
  }
  return candidate;
}

export function validateInstalledPackageGraph(manifests, candidateVersion) {
  if (!isRecord(manifests)
    || !isRecord(manifests["@mcrescenzo/opencode-self-evolve"])
    || !isRecord(manifests["@opencode-ai/plugin"])) {
    throw new Error("installed production TUI package graph is incomplete");
  }
  validateInstalledCandidateManifest(
    manifests["@mcrescenzo/opencode-self-evolve"],
    candidateVersion,
  );
  const plugin = manifests["@opencode-ai/plugin"];
  if (plugin.name !== "@opencode-ai/plugin") {
    throw new Error("installed OpenCode plugin identity is invalid");
  }
  assertSupportedOpenCodeVersion(plugin.version);
  const floors = alignedTuiPackages(plugin);
  const exactTuiPackages = {};
  for (const name of OPENTUI_PACKAGES) {
    const manifest = manifests[name];
    const actualMatch = /^0\.4\.([0-9]+)$/u.exec(String(manifest?.version ?? ""));
    const floorMatch = /^0\.4\.([0-9]+)$/u.exec(floors[name]);
    if (manifest?.name !== name
      || !actualMatch
      || !floorMatch
      || Number(actualMatch[1]) < Number(floorMatch[1])) {
      throw new Error(`installed ${name} is incompatible with the OpenCode plugin`);
    }
    exactTuiPackages[name] = manifest.version;
  }
  const solid = manifests["solid-js"];
  if (solid?.name !== "solid-js" || solid.version !== "1.9.12") {
    throw new Error("installed solid-js must be exactly 1.9.12");
  }
  exactTuiPackages["solid-js"] = solid.version;
  return Object.freeze(exactTuiPackages);
}

function exactTrueRecord(value, keys, label) {
  if (!isRecord(value)
    || Object.keys(value).length !== keys.length
    || keys.some((key) => value[key] !== true)) {
    throw new Error(`${label} is incomplete`);
  }
}

function hasSensitiveKey(key) {
  return /(?:session.?id|api.?key|token|secret|password|authorization|pid)/i.test(key);
}

export function assertPublicSafe(value, key = "evidence") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPublicSafe(entry, `${key}[${index}]`));
    return value;
  }
  if (isRecord(value)) {
    for (const [name, entry] of Object.entries(value)) {
      if (hasSensitiveKey(name)) throw new Error(`public evidence contains sensitive key ${name}`);
      assertPublicSafe(entry, `${key}.${name}`);
    }
    return value;
  }
  if (typeof value === "string" && /\bses_[A-Za-z0-9_-]+\b/u.test(value)) {
    throw new Error(`public evidence contains private data (session) in ${key}`);
  }
  if (typeof value === "string" && /\bfile:\/\//iu.test(value)) {
    throw new Error(`public evidence contains private data (file URL) in ${key}`);
  }
  if (typeof value === "string") {
    const privatePath = /(?:^|[\s"'])\/(home|Users|ssd|tmp|var|private|opt|root)(?:\/|\b)/u.exec(value);
    if (privatePath) {
      throw new Error(`public evidence contains private data (${privatePath[1]} path) in ${key}`);
    }
  }
  return value;
}

export function validateStageReceipt(receipt, expected) {
  if (!isRecord(receipt)
    || receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION
    || receipt.status !== "passed"
    || receipt.stage !== expected.stage
    || receipt.columns !== expected.columns
    || receipt.rows !== expected.rows
    || typeof receipt.openCodeVersion !== "string"
    || !Array.isArray(receipt.frames)) {
    throw new Error(`stage ${expected.stage} receipt is missing or invalid`);
  }
  assertSupportedOpenCodeVersion(receipt.openCodeVersion);
  exactTrueRecord(receipt.proofs, expected.proofNames, `stage ${expected.stage} proofs`);
  if (receipt.frames.length !== expected.frameNames.length
    || receipt.frames.some((frame, index) => {
      if (!isRecord(frame)
        || frame.name !== expected.frameNames[index]
        || frame.columns !== expected.columns
        || frame.rows !== expected.rows
        || typeof frame.frame !== "string"
        || frame.frame.length < 1
        || !/^[a-f0-9]{64}$/u.test(frame.sha256)
        || sha256(frame.frame) !== frame.sha256
        || !Number.isInteger(frame.maximumLineColumns)
        || frame.maximumLineColumns > expected.columns) return true;
      return false;
    })) {
    throw new Error(`stage ${expected.stage} render evidence is incomplete`);
  }
  const publicReceipt = {
    schemaVersion: receipt.schemaVersion,
    status: receipt.status,
    stage: receipt.stage,
    openCodeVersion: receipt.openCodeVersion,
    columns: receipt.columns,
    rows: receipt.rows,
    proofs: receipt.proofs,
    frames: receipt.frames,
  };
  return assertPublicSafe(publicReceipt);
}

function parseSinglePack(stdout) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error("npm pack did not return JSON");
  }
  if (!Array.isArray(result)
    || result.length !== 1
    || typeof result[0]?.filename !== "string"
    || !Array.isArray(result[0]?.files)) {
    throw new Error("npm pack returned an ambiguous result");
  }
  return result[0];
}

async function run(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    const collect = (name) => (chunk) => {
      const next = (name === "stdout" ? stdout : stderr) + chunk.toString("utf8");
      if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) overflow = true;
      if (name === "stdout") stdout = next.slice(-MAX_OUTPUT_BYTES);
      else stderr = next.slice(-MAX_OUTPUT_BYTES);
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (overflow) return reject(new Error(`${command} output exceeded its byte bound`));
      if (code !== 0) {
        const detail = stderr.trim().slice(-4_000);
        return reject(new Error(`${command} failed (${code ?? signal}): ${detail}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

function shellQuote(value) {
  const text = String(value);
  if (/[\0\r\n]/u.test(text)) throw new Error("unsafe PTY command value");
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

function isolatedEnvironment(env, directories) {
  const inherited = Object.fromEntries([
    "PATH",
    "TERM",
    "LANG",
    "LC_ALL",
    "TZ",
    "CI",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
  ].flatMap((name) => typeof env[name] === "string" ? [[name, env[name]]] : []));
  return {
    ...inherited,
    HOME: directories.home,
    PWD: directories.project,
    XDG_CONFIG_HOME: directories.xdgConfig,
    XDG_DATA_HOME: directories.xdgData,
    XDG_STATE_HOME: directories.xdgState,
    XDG_CACHE_HOME: directories.xdgCache,
    npm_config_cache: directories.npmCache,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    NO_COLOR: "1",
  };
}

async function policyHashes() {
  return Object.fromEntries(await Promise.all(
    POLICY_FILES.map(async (name) => [name, await sha256File(path.join(root, name))]),
  ));
}

async function prepareCandidate(scratch, env, timeoutMs) {
  const packDir = path.join(scratch, "packs");
  await fs.mkdir(packDir, { recursive: true, mode: 0o700 });
  const packedResult = await run(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir],
    { cwd: root, env, timeoutMs },
  );
  const packed = parseSinglePack(packedResult.stdout);
  const tarball = path.join(packDir, packed.filename);
  const inventory = packed.files
    .map(({ path: file, size, mode }) => ({ path: file, size, mode }))
    .sort((a, b) => a.path.localeCompare(b.path));
  for (const required of [
    "self-evolve-tui.js",
    "self-evolve-tui.tsx",
    "self-evolve-tui.generated.js",
    "package.json",
  ]) {
    if (!inventory.some((entry) => entry.path === required)) {
      throw new Error(`candidate tarball omitted ${required}`);
    }
  }
  return {
    manifest: JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")),
    tarball,
    tarballSha256: await sha256File(tarball),
    inventorySha256: sha256(JSON.stringify(inventory)),
    inventoryCount: inventory.length,
  };
}

async function prepareConsumer(scratch, candidate, openCodeVersion, env, timeoutMs) {
  const consumer = path.join(scratch, "consumer");
  await fs.mkdir(consumer, { recursive: true, mode: 0o700 });
  await writeJson(path.join(consumer, "package.json"), { private: true, type: "module" });
  const baseSpecs = [
    candidate.tarball,
    `@opencode-ai/plugin@${openCodeVersion}`,
  ];
  await run("npm", [
    "install",
    ...baseSpecs,
    "--save-exact",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
    "--legacy-peer-deps",
  ], { cwd: consumer, env, timeoutMs });
  const pluginManifest = JSON.parse(await fs.readFile(
    path.join(consumer, "node_modules", "@opencode-ai", "plugin", "package.json"),
    "utf8",
  ));
  const exactTuiPackages = alignedTuiPackages(pluginManifest);
  const graphManifests = {
    "@opencode-ai/plugin": pluginManifest,
  };
  await run("npm", [
    "install",
    ...Object.entries(exactTuiPackages).map(([name, version]) => `${name}@${version}`),
    "--save-exact",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
    "--legacy-peer-deps",
  ], { cwd: consumer, env, timeoutMs });
  for (const [name, version] of Object.entries(exactTuiPackages)) {
    const manifest = JSON.parse(await fs.readFile(
      path.join(consumer, "node_modules", ...name.split("/"), "package.json"),
      "utf8",
    ));
    if (manifest.version !== version) {
      throw new Error(`${name} resolved to ${manifest.version}, expected ${version}`);
    }
    graphManifests[name] = manifest;
  }
  const witnessDir = path.join(consumer, "node_modules", ".self-evolve-release-b");
  await fs.mkdir(witnessDir, { recursive: true, mode: 0o700 });
  const witness = path.join(witnessDir, "witness.mjs");
  await fs.copyFile(witnessSource, witness);
  const installedCandidateRoot = path.join(
    consumer,
    "node_modules",
    "@mcrescenzo",
    "opencode-self-evolve",
  );
  const manifest = JSON.parse(await fs.readFile(path.join(installedCandidateRoot, "package.json"), "utf8"));
  if (manifest.exports?.["./tui"] !== "./self-evolve-tui.generated.js") {
    throw new Error("packed candidate does not expose the production TUI target");
  }
  const candidateRoot = path.join(scratch, "packed-production-tui");
  await fs.cp(installedCandidateRoot, candidateRoot, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  const candidateTui = path.resolve(candidateRoot, manifest.exports["./tui"]);
  if (!candidateTui.startsWith(`${candidateRoot}${path.sep}`) || !await exists(candidateTui)) {
    throw new Error("packed production TUI target is missing or unsafe");
  }
  graphManifests["@mcrescenzo/opencode-self-evolve"] = manifest;
  const validatedTuiPackages = validateInstalledPackageGraph(
    graphManifests,
    manifest.version,
  );
  return {
    candidateRoot,
    candidateTui,
    exactTuiPackages: validatedTuiPackages,
    witness,
  };
}

async function prepareReleaseATui(scratch, env, timeoutMs) {
  if (!/^[a-f0-9]{40}$/u.test(RELEASE_A_TUI_COMMIT)) {
    throw new Error("pinned Release A TUI commit is invalid");
  }
  await run("git", ["cat-file", "-e", `${RELEASE_A_TUI_COMMIT}^{commit}`], {
    cwd: root,
    env,
    timeoutMs,
  });
  const manifestResult = await run(
    "git",
    ["show", `${RELEASE_A_TUI_COMMIT}:package.json`],
    { cwd: root, env, timeoutMs },
  );
  const manifest = JSON.parse(manifestResult.stdout);
  if (manifest.version !== "0.2.0"
    || manifest.exports?.["./tui"] !== "./self-evolve-tui.tsx"
    || !Array.isArray(manifest.files)) {
    throw new Error("pinned Release A package contract is invalid");
  }
  const archive = path.join(scratch, "release-a-tui.tar");
  const packageRoot = path.join(scratch, "release-a-tui");
  await fs.mkdir(packageRoot, { recursive: true, mode: 0o700 });
  await run("git", [
    "archive",
    "--format=tar",
    `--output=${archive}`,
    RELEASE_A_TUI_COMMIT,
    "--",
    "package.json",
    ...manifest.files,
  ], { cwd: root, env, timeoutMs });
  await run("tar", ["-xf", archive, "-C", packageRoot], {
    cwd: root,
    env,
    timeoutMs,
  });
  const candidateTui = path.resolve(packageRoot, manifest.exports["./tui"]);
  const stat = await fs.lstat(candidateTui);
  if (!stat.isFile()
    || stat.isSymbolicLink()
    || !candidateTui.startsWith(`${packageRoot}${path.sep}`)
    || await fs.realpath(candidateTui) !== candidateTui) {
    throw new Error("pinned Release A TUI target is missing or unsafe");
  }
  return Object.freeze({
    sourceCommit: RELEASE_A_TUI_COMMIT,
    packageRoot,
    candidateTui,
    tuiSha256: await sha256File(candidateTui),
  });
}

async function prepareProject(
  scratch,
  consumer,
  projectName = "project",
  candidateTui = consumer.candidateTui,
) {
  const project = path.join(scratch, projectName);
  const configDir = path.join(project, ".opencode");
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeJson(path.join(project, "opencode.json"), {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    plugin: [],
  });
  await writeJson(path.join(configDir, "tui.json"), {
    $schema: "https://opencode.ai/tui.json",
    plugin: [
      pathToFileURL(consumer.witness).href,
      pathToFileURL(candidateTui).href,
    ],
  });
  return project;
}

function processGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupAlive(pid)) return true;
    await delay(25);
  }
  return !processGroupAlive(pid);
}

async function stopProcessGroup(child) {
  if (!child?.pid || !processGroupAlive(child.pid)) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  if (await waitForProcessGroupExit(child.pid, 3_000)) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  if (!await waitForProcessGroupExit(child.pid, 3_000)) {
    throw new Error("operator evidence PTY survived SIGKILL");
  }
}

async function stageDirectories(scratch, stage, project) {
  const stageRoot = path.join(scratch, `stage-${stage}`);
  const directories = {
    project,
    home: path.join(stageRoot, "home"),
    xdgConfig: path.join(scratch, "shared-xdg-config"),
    xdgData: path.join(stageRoot, "xdg-data"),
    xdgState: path.join(stageRoot, "xdg-state"),
    xdgCache: path.join(scratch, "shared-xdg-cache"),
    npmCache: path.join(scratch, "shared-npm-cache"),
  };
  for (const directory of Object.values(directories)) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }
  return {
    directories,
    receiptPath: path.join(stageRoot, "receipt.json"),
    stateRoot: path.join(directories.xdgState, "opencode"),
    stageRoot,
  };
}

async function runStage({
  expected,
  opencodeBin,
  timeoutMs,
  scratch,
  project,
  consumer,
  activePackageRoot = consumer.candidateRoot,
  legacyTui = false,
  baseEnv,
  children,
}) {
  const paths = await stageDirectories(scratch, expected.stage, project);
  await fs.mkdir(paths.stateRoot, { recursive: true, mode: 0o700 });
  const command = `stty cols ${expected.columns} rows ${expected.rows} && exec ${
    [opencodeBin, ".", "--print-logs", "--log-level", "WARN"].map(shellQuote).join(" ")
  }`;
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    cwd: project,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...isolatedEnvironment(baseEnv, paths.directories),
      COLUMNS: String(expected.columns),
      LINES: String(expected.rows),
      SELF_EVOLVE_RELEASE_B_STAGE: String(expected.stage),
      SELF_EVOLVE_RELEASE_B_RECEIPT: paths.receiptPath,
      SELF_EVOLVE_RELEASE_B_SCRATCH: paths.stageRoot,
      SELF_EVOLVE_RELEASE_B_STATE_ROOT: paths.stateRoot,
      SELF_EVOLVE_RELEASE_B_PACKAGE_ROOT: consumer.candidateRoot,
      SELF_EVOLVE_RELEASE_B_ACTIVE_PACKAGE_ROOT: activePackageRoot,
      ...(legacyTui ? { SELF_EVOLVE_RELEASE_B_LEGACY_TUI: "1" } : {}),
    },
  });
  children.add(child);
  let spawnError;
  let diagnostics = "";
  let diagnosticsHead = "";
  child.on("error", (error) => { spawnError = error; });
  const collectDiagnostics = (chunk) => {
    const text = chunk.toString("utf8");
    if (diagnosticsHead.length < MAX_OUTPUT_BYTES) {
      diagnosticsHead = `${diagnosticsHead}${text}`.slice(0, MAX_OUTPUT_BYTES);
    }
    diagnostics = `${diagnostics}${text}`.slice(-MAX_OUTPUT_BYTES);
  };
  child.stdout.on("data", collectDiagnostics);
  child.stderr.on("data", collectDiagnostics);
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (spawnError) throw new Error(`stage ${expected.stage} PTY failed: ${spawnError.message}`);
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`stage ${expected.stage} exited before evidence: ${diagnostics.trim().slice(-1_000)}`);
      }
      if (await exists(paths.receiptPath)) {
        const receipt = await readBoundedJson(paths.receiptPath);
        if (receipt?.status === "failed") {
          const hostLog = await readHostLogDiagnostics(paths.directories);
          const plainDiagnostics = `${diagnosticsHead}\n${diagnostics}`
            .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "");
          const relevant = [...plainDiagnostics.matchAll(
            /.{0,120}(?:tui\.plugin|self-evolve|failed|error).{0,500}/giu,
          )].map(([match]) => match.trim()).filter(Boolean).slice(-12).join("\n");
          throw new Error(
            `stage ${expected.stage} witness failed: ${String(receipt.error).slice(0, 1_000)}`
            + `${hostLog.trim() ? `\nOpenCode log:\n${hostLog.trim().slice(-4_000)}` : ""}`
            + `${relevant ? `\nRelevant host diagnostics:\n${relevant.slice(-2_000)}` : ""}`
            + `${diagnostics.trim() ? `\nHost diagnostics:\n${diagnostics.trim().slice(-4_000)}` : ""}`,
          );
        }
        const validated = validateStageReceipt(receipt, expected);
        child.stdin.write("\u0003\u0003");
        await stopProcessGroup(child);
        return validated;
      }
      await delay(50);
    }
    throw new Error(`stage ${expected.stage} timed out`);
  } finally {
    await stopProcessGroup(child);
    children.delete(child);
  }
}

function safeFailure(error, scratch) {
  let message = error instanceof Error ? error.message : String(error);
  if (scratch) message = message.replaceAll(scratch, "<scratch>");
  if (os.homedir()) message = message.replaceAll(os.homedir(), "<home>");
  message = message.replaceAll(root, "<repo>");
  return message
    .replace(/\bses_[A-Za-z0-9_-]+\b/gu, "<session>")
    .replace(/\bfile:\/\/[^\s]+/giu, "file://<redacted>")
    .replace(/(^|[\s("'=])\/[A-Za-z0-9._~!$&()*+,;=:@%/+-]+/gu, "$1<path>")
    .slice(0, 4_000);
}

export function buildPublicReport(input) {
  const report = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    status: "passed",
    productionTuiEntryExercised: true,
    openCodeVersion: assertSupportedOpenCodeVersion(input.openCodeVersion),
    exactTuiPackages: { ...input.exactTuiPackages },
    candidate: {
      version: input.candidateVersion,
      tarballSha256: input.candidate.tarballSha256,
      inventorySha256: input.candidate.inventorySha256,
      inventoryCount: input.candidate.inventoryCount,
    },
    releaseATui: {
      sourceCommit: input.releaseATui.sourceCommit,
      tuiSha256: input.releaseATui.tuiSha256,
      ignoredAdditiveDashboard: input.stages
        .find(({ stage }) => stage === 4)
        ?.proofs?.legacyTuiIgnoredAdditiveDashboard === true,
    },
    matrix: input.stages,
    policy: input.policy,
    cleanup: {
      trackedTuiProcessGroupsStopped: input.trackedTuiProcessGroupsStopped === true,
      scratchRemoved: input.scratchRemoved === true,
    },
    limitations: {
      automatedLocalOperatorWitness: true,
      packedArtifactLoadedAsExternalTuiTarget: true,
      independentHumanReview: false,
      publicationOrRelease: false,
    },
  };
  if (typeof report.candidate.version !== "string"
    || !/^[a-f0-9]{64}$/u.test(report.candidate.tarballSha256)
    || !/^[a-f0-9]{64}$/u.test(report.candidate.inventorySha256)
    || !Number.isInteger(report.candidate.inventoryCount)
    || report.candidate.inventoryCount < 1
    || !/^[a-f0-9]{40}$/u.test(report.releaseATui.sourceCommit)
    || !/^[a-f0-9]{64}$/u.test(report.releaseATui.tuiSha256)
    || report.releaseATui.ignoredAdditiveDashboard !== true
    || Object.keys(report.exactTuiPackages).length !== 4
    || Object.values(report.exactTuiPackages).some((value) => (
      typeof value !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(value)
    ))
    || report.matrix.length !== STAGES.length
    || Object.values(report.policy).some((value) => value !== true)
    || Object.values(report.cleanup).some((value) => value !== true)) {
    throw new Error("public operator evidence report is incomplete");
  }
  return assertPublicSafe(report);
}

export async function main(options = {}) {
  const env = options.env ?? process.env;
  const streams = options.streams ?? process;
  const children = new Set();
  let scratch;
  let baseline;
  let assembled;
  let failure;
  try {
    const { opencodeBin, outputPath, timeoutMs } = liveOptions(env);
    const versionResult = spawnSync(opencodeBin, ["--version"], {
      encoding: "utf8",
      env,
      shell: false,
      timeout: 10_000,
    });
    if (versionResult.status !== 0 || versionResult.error) {
      throw new Error(versionResult.stderr?.trim() || versionResult.error?.message || "opencode --version failed");
    }
    const openCodeVersion = assertSupportedOpenCodeVersion(versionResult.stdout);
    const scriptVersion = spawnSync("script", ["--version"], {
      encoding: "utf8",
      env,
      shell: false,
      timeout: 10_000,
    });
    if (scriptVersion.status !== 0 || scriptVersion.error) {
      throw new Error("util-linux script is required");
    }
    baseline = await policyHashes();
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "self-evolve-release-b-evidence-"));
    await fs.chmod(scratch, 0o700);
    const bootstrapDirectories = {
      project: path.join(scratch, "project"),
      home: path.join(scratch, "bootstrap-home"),
      xdgConfig: path.join(scratch, "bootstrap-config"),
      xdgData: path.join(scratch, "bootstrap-data"),
      xdgState: path.join(scratch, "bootstrap-state"),
      xdgCache: path.join(scratch, "bootstrap-cache"),
      npmCache: path.join(scratch, "npm-cache"),
    };
    for (const directory of Object.values(bootstrapDirectories)) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    }
    const isolated = isolatedEnvironment(env, bootstrapDirectories);
    const candidate = await prepareCandidate(scratch, isolated, timeoutMs);
    const consumer = await prepareConsumer(scratch, candidate, openCodeVersion, isolated, timeoutMs);
    const releaseATui = await prepareReleaseATui(scratch, isolated, timeoutMs);
    const project = await prepareProject(scratch, consumer);
    const restartProject = await prepareProject(scratch, consumer, "restart-project");
    const legacyProject = await prepareProject(
      scratch,
      consumer,
      "release-a-project",
      releaseATui.candidateTui,
    );
    const stages = [];
    for (const expected of STAGES) {
      stages.push(await runStage({
        expected,
        opencodeBin,
        timeoutMs,
        scratch,
        project: expected.stage === 3
          ? restartProject
          : expected.stage === 4 ? legacyProject : project,
        consumer,
        ...(expected.stage === 4 ? {
          activePackageRoot: releaseATui.packageRoot,
          legacyTui: true,
        } : {}),
        baseEnv: env,
        children,
      }));
    }
    const manifest = JSON.parse(await fs.readFile(path.join(consumer.candidateRoot, "package.json"), "utf8"));
    assembled = {
      outputPath,
      openCodeVersion,
      candidateVersion: manifest.version,
      candidate,
      releaseATui,
      exactTuiPackages: consumer.exactTuiPackages,
      stages,
    };
  } catch (error) {
    failure = error;
  } finally {
    await Promise.all([...children].map((child) => stopProcessGroup(child).catch(() => {})));
    children.clear();
    if (scratch) {
      await fs.rm(scratch, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      }).catch(() => {});
    }
  }
  if (!failure && assembled && scratch && !await exists(scratch)) {
    const finalHashes = await policyHashes().catch(() => ({}));
    const report = buildPublicReport({
      ...assembled,
      policy: {
        packageJsonUnchanged: baseline?.["package.json"] === finalHashes["package.json"],
        bunLockUnchanged: baseline?.["bun.lock"] === finalHashes["bun.lock"],
        agentsMdUnchanged: baseline?.["AGENTS.md"] === finalHashes["AGENTS.md"],
      },
      trackedTuiProcessGroupsStopped: children.size === 0,
      scratchRemoved: true,
    });
    if (assembled.outputPath) await writeJson(assembled.outputPath, report);
    const summary = {
      schemaVersion: report.schemaVersion,
      status: report.status,
      productionTuiEntryExercised: report.productionTuiEntryExercised,
      openCodeVersion: report.openCodeVersion,
      candidate: report.candidate,
      releaseATui: report.releaseATui,
      matrix: report.matrix.map((stage) => ({
        stage: stage.stage,
        columns: stage.columns,
        rows: stage.rows,
        proofs: stage.proofs,
        frames: stage.frames.map(({ name, sha256: frameSha, maximumLineColumns }) => ({
          name,
          sha256: frameSha,
          maximumLineColumns,
        })),
      })),
      limitations: report.limitations,
    };
    streams.stdout.write(`[self-evolve-release-b-evidence] verified ${JSON.stringify(summary)}\n`);
    return 0;
  }
  streams.stderr.write(
    `[self-evolve-release-b-evidence] REQUIRED GATE FAILED: ${
      safeFailure(failure ?? new Error("scratch cleanup failed"), scratch)
    }\n`,
  );
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exit(await main());
}
