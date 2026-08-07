import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const REQUIRED_OPENCODE_VERSION = "1.18.3";
export const LIVE_SPIKE_ENV = "SELF_EVOLVE_TUI_HOST_SPIKE";
export const OPENCODE_BIN_ENV = "SELF_EVOLVE_TUI_OPENCODE_BIN";
export const TIMEOUT_ENV = "SELF_EVOLVE_TUI_HOST_SPIKE_TIMEOUT_MS";
export const CANDIDATE_VERSION = "0.2.0-tui-host-spike.0";
export const RECEIPT_SCHEMA_VERSION = 1;
export const PRODUCT_PLUGIN_ID = "mcrescenzo.self-evolve-host-spike";
export const PRODUCT_COMMAND_ID = "self-evolve.control-center";
export const PRODUCT_ROUTE_ID = "self-evolve.control-center.route";

const root = path.resolve(import.meta.dirname, "..");
const fixtureRoot = path.join(root, "tests", "fixtures", "self-evolve-tui-host-spike");
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const POLICY_FILES = Object.freeze(["package.json", "bun.lock", "AGENTS.md"]);
const EXACT_TUI_PACKAGES = Object.freeze({
  "@opencode-ai/plugin": "1.18.3",
  "@opentui/core": "0.4.5",
  "@opentui/keymap": "0.4.5",
  "@opentui/solid": "0.4.5",
  "solid-js": "1.9.12",
});
const CANDIDATE_OPTIONAL_PEERS = Object.freeze({
  "@opencode-ai/plugin": "~1.18.3",
  "@opentui/core": ">=0.4.5 <0.6.0",
  "@opentui/keymap": ">=0.4.5 <0.6.0",
  "@opentui/solid": ">=0.4.5 <0.6.0",
  "solid-js": "1.9.12",
});
const REQUIRED_STAGE_ONE_PROOFS = Object.freeze([
  "packedTargetActive",
  "cardAbsentThenPresent",
  "rendererClickOpenedDialog",
  "rendererEnterOpenedDialog",
  "paletteVisible",
  "paletteMetadataOnly",
  "paletteOpenedRoute",
  "routeModeLifecycle",
  "delayedReplacementLease",
  "workspaceWarped",
  "livePathUpdated",
  "pluginNotReinstantiated",
  "pathRebound",
  "pluginDeactivated",
  "pluginReactivated",
  "registrationsExact",
]);
const REQUIRED_STAGE_TWO_PROOFS = Object.freeze([
  "freshProcess",
  "packedTargetActive",
  "singleRegistration",
  "restartHandoffValid",
  "narrowCardReachable",
  "narrowDialogReachable",
  "narrowRouteReachable",
  "sessionsDeleted",
  "fixturesDeleted",
  "privateHandoffDeleted",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function exactTrueRecord(value, keys, label) {
  if (!isRecord(value)
    || Object.keys(value).length !== keys.length
    || keys.some((key) => value[key] !== true)) {
    throw new Error(`${label} is incomplete`);
  }
  return value;
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
  if (env[LIVE_SPIKE_ENV] !== "1") {
    throw new Error(`set ${LIVE_SPIKE_ENV}=1 to run the live exact-host spike`);
  }
  const opencodeBin = env[OPENCODE_BIN_ENV];
  if (typeof opencodeBin !== "string" || !path.isAbsolute(opencodeBin)) {
    throw new Error(`${OPENCODE_BIN_ENV} must be an absolute path`);
  }
  return { opencodeBin: path.resolve(opencodeBin), timeoutMs: parseTimeout(env[TIMEOUT_ENV]) };
}

export function assertOpenCodeVersion(value) {
  const actual = String(value ?? "").trim();
  if (actual !== REQUIRED_OPENCODE_VERSION) {
    throw new Error(`OpenCode ${REQUIRED_OPENCODE_VERSION} is required; observed ${actual || "no version"}`);
  }
  return actual;
}

export function mutateCandidatePackage(source) {
  if (!isRecord(source) || source.name !== "@mcrescenzo/opencode-self-evolve") {
    throw new Error("unexpected source package identity");
  }
  if (!isRecord(source.exports) || typeof source.exports["."] !== "string") {
    throw new Error("source package root export is missing");
  }
  if (!Array.isArray(source.files) || source.files.some((entry) => typeof entry !== "string")) {
    throw new Error("source package files inventory is invalid");
  }
  for (const name of ["preinstall", "install", "postinstall"]) {
    if (typeof source.scripts?.[name] === "string") throw new Error(`source package has forbidden ${name} script`);
  }

  const candidate = clone(source);
  candidate.version = CANDIDATE_VERSION;
  candidate.engines = {
    ...(isRecord(candidate.engines) ? candidate.engines : {}),
    opencode: REQUIRED_OPENCODE_VERSION,
  };
  candidate.exports["./tui"] = "./tui.generated.js";
  candidate.files = [...new Set([...candidate.files, "tui.generated.js"])];
  candidate.peerDependencies = {
    ...(isRecord(candidate.peerDependencies) ? candidate.peerDependencies : {}),
    ...CANDIDATE_OPTIONAL_PEERS,
  };
  candidate.peerDependenciesMeta = {
    ...(isRecord(candidate.peerDependenciesMeta) ? candidate.peerDependenciesMeta : {}),
    ...Object.fromEntries(Object.keys(CANDIDATE_OPTIONAL_PEERS).map((name) => [name, { optional: true }])),
  };
  return validateCandidatePackage(candidate);
}

export function validateCandidatePackage(candidate) {
  if (!isRecord(candidate) || candidate.version !== CANDIDATE_VERSION
    || candidate.engines?.opencode !== REQUIRED_OPENCODE_VERSION
    || candidate.exports?.["."] !== "./self-evolve.js"
    || candidate.exports?.["./tui"] !== "./tui.generated.js"
    || !Array.isArray(candidate.files)
    || candidate.files.filter((entry) => entry === "tui.generated.js").length !== 1) {
    throw new Error("candidate package target mutation is incomplete");
  }
  for (const [name, version] of Object.entries(CANDIDATE_OPTIONAL_PEERS)) {
    if (candidate.peerDependencies?.[name] !== version
      || candidate.peerDependenciesMeta?.[name]?.optional !== true) {
      throw new Error(`candidate optional peer contract is invalid for ${name}`);
    }
  }
  for (const name of ["preinstall", "install", "postinstall"]) {
    if (typeof candidate.scripts?.[name] === "string") throw new Error(`candidate has forbidden ${name} script`);
  }
  return candidate;
}

export function spikeConfigs({ witnessUrl, candidateUrl, workspacePluginUrl }) {
  for (const [name, value] of Object.entries({ witnessUrl, candidateUrl, workspacePluginUrl })) {
    if (typeof value !== "string" || !value.startsWith("file://")) throw new Error(`${name} must be a file URL`);
  }
  return {
    server: {
      $schema: "https://opencode.ai/config.json",
      autoupdate: false,
      plugin: [workspacePluginUrl],
    },
    tui: {
      $schema: "https://opencode.ai/tui.json",
      plugin: [witnessUrl, candidateUrl],
    },
  };
}

export function isolatedEnvironment(env, directories) {
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
    OPENCODE_EXPERIMENTAL_WORKSPACES: "true",
    NO_COLOR: "1",
  };
}

export function validateStageReceipt(receipt, stage) {
  const keys = stage === 1 ? REQUIRED_STAGE_ONE_PROOFS : stage === 2 ? REQUIRED_STAGE_TWO_PROOFS : null;
  if (!keys || !isRecord(receipt) || receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION
    || receipt.stage !== stage || receipt.status !== "passed" || receipt.providerPromptHookCalls !== 0
    || receipt.productVersion !== CANDIDATE_VERSION || receipt.openCodeVersion !== REQUIRED_OPENCODE_VERSION) {
    throw new Error(`stage ${stage} receipt is missing or invalid`);
  }
  exactTrueRecord(receipt.proofs, keys, `stage ${stage} proofs`);
  if (!Number.isInteger(receipt.productActivations) || receipt.productActivations < 1) {
    throw new Error(`stage ${stage} product activation count is invalid`);
  }
  if (stage === 1 && (!Number.isInteger(receipt.cleanupElapsedMs)
    || receipt.cleanupElapsedMs < 0 || receipt.cleanupElapsedMs > 5000)) {
    throw new Error("stage 1 cleanup exceeded the exact host deadline");
  }
  assertPublicSafe(receipt);
  return receipt;
}

function hasSensitiveKey(key) {
  return /(?:session.?id|api.?key|token|secret|password|authorization)/i.test(key);
}

export function assertPublicSafe(value, key = "receipt") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPublicSafe(entry, `${key}[${index}]`));
    return value;
  }
  if (isRecord(value)) {
    for (const [name, entry] of Object.entries(value)) {
      if (hasSensitiveKey(name)) throw new Error(`public receipt contains sensitive key ${name}`);
      assertPublicSafe(entry, name);
    }
    return value;
  }
  if (typeof value === "string") {
    if (/\bses_[A-Za-z0-9_-]+\b/.test(value) || /\bfile:\/\//i.test(value)
      || /(^|[\s"'])\/(?:home|Users|ssd|tmp|var|private|opt|root)(?:\/|\b)/.test(value)) {
      throw new Error(`public receipt contains private data in ${key}`);
    }
  }
  return value;
}

export function buildPublicReceipt(input) {
  const stage1 = validateStageReceipt(input.stage1, 1);
  const stage2 = validateStageReceipt(input.stage2, 2);
  const lifecycleScripts = Array.isArray(input.lifecycleScripts) ? [...input.lifecycleScripts] : null;
  if (lifecycleScripts === null || lifecycleScripts.length !== 0) throw new Error("candidate lifecycle scripts are present");
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    status: "passed",
    exactVersions: {
      opencode: REQUIRED_OPENCODE_VERSION,
      candidate: CANDIDATE_VERSION,
      ...EXACT_TUI_PACKAGES,
    },
    candidate: {
      artifactPurpose: "host-package-feasibility",
      productionTuiEntryExercised: false,
      tarballSha256: input.tarballSha256,
      inventorySha256: input.inventorySha256,
      inventoryCount: input.inventoryCount,
      rootServerExportPeerless: input.rootServerExportPeerless === true,
      peerlessOptionalPackagesAbsent: input.peerlessOptionalPackagesAbsent === true,
      lifecycleScripts,
    },
    peerContract: {
      testedExactFloorOnly: true,
      rangeCompatibilityProven: false,
      proposedOptionalRanges: {
        ...CANDIDATE_OPTIONAL_PEERS,
      },
      taggedHostSolidCatalogVersion: "1.9.10",
      externalTuiSolidVersion: EXACT_TUI_PACKAGES["solid-js"],
      reproducesTaggedHostBuildGraph: false,
    },
    proofs: {
      stage1: stage1.proofs,
      stage2: stage2.proofs,
      pidsDiffered: stage2.proofs.freshProcess,
      cleanupElapsedMs: stage1.cleanupElapsedMs,
      cleanupWithinHostDeadline: stage1.cleanupElapsedMs <= 5000,
    },
    pathLifecycle: {
      observed: {
        livePathUpdatedWithoutReinstantiation: true,
        freshProcessRestartSucceeded: true,
      },
      recommendation: {
        rebindOnPathChange: true,
        restartIfRebindFails: true,
      },
    },
    policy: {
      packageJsonUnchanged: input.policy?.packageJsonUnchanged === true,
      bunLockUnchanged: input.policy?.bunLockUnchanged === true,
      agentsMdUnchanged: input.policy?.agentsMdUnchanged === true,
      repositoryLockfileUnchanged: input.policy?.bunLockUnchanged === true,
    },
    cleanup: {
      trackedTuiProcessGroupsStopped: input.cleanup?.trackedTuiProcessGroupsStopped === true,
      sessionsDeleted: stage2.proofs.sessionsDeleted,
      fixturesDeleted: stage2.proofs.fixturesDeleted,
      privateHandoffDeleted: stage2.proofs.privateHandoffDeleted,
      scratchRemoved: input.cleanup?.scratchRemoved === true,
    },
    providerPromptHookCalls: 0,
  };
  if (!/^[a-f0-9]{64}$/.test(receipt.candidate.tarballSha256)
    || !/^[a-f0-9]{64}$/.test(receipt.candidate.inventorySha256)
    || !Number.isInteger(receipt.candidate.inventoryCount) || receipt.candidate.inventoryCount < 1
    || !receipt.candidate.rootServerExportPeerless || !receipt.candidate.peerlessOptionalPackagesAbsent
    || [receipt.policy.packageJsonUnchanged, receipt.policy.bunLockUnchanged,
      receipt.policy.agentsMdUnchanged, receipt.policy.repositoryLockfileUnchanged].some((value) => value !== true)
    || Object.values(receipt.cleanup).some((value) => value !== true)) {
    throw new Error("combined public receipt is incomplete");
  }
  return assertPublicSafe(receipt);
}

async function exists(filePath) {
  return fs.access(filePath).then(() => true, () => false);
}

async function sha256File(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function readBoundedJson(filePath, maximum = MAX_RECEIPT_BYTES) {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > maximum) throw new Error("receipt has invalid size");
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

function shellQuote(value) {
  const text = String(value);
  if (/[\0\r\n]/.test(text)) throw new Error("unsafe PTY command value");
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

function parseSinglePack(stdout) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error("npm pack did not return JSON");
  }
  if (!Array.isArray(result) || result.length !== 1 || typeof result[0]?.filename !== "string"
    || !Array.isArray(result[0]?.files)) {
    throw new Error("npm pack returned an ambiguous result");
  }
  return result[0];
}

async function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
      const bounded = next.slice(-MAX_OUTPUT_BYTES);
      if (name === "stdout") stdout = bounded;
      else stderr = bounded;
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (overflow) return reject(new Error(`${command} output exceeded its byte bound`));
      if (code !== 0) {
        const detail = stderr.trim();
        const diagnostic = detail.length <= 4_000
          ? detail
          : `${detail.slice(0, 2_000)}\n...[bounded]...\n${detail.slice(-2_000)}`;
        return reject(new Error(`${command} failed (${code ?? signal}): ${diagnostic}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

async function policyHashes() {
  return Object.fromEntries(await Promise.all(POLICY_FILES.map(async (name) => [name, await sha256File(path.join(root, name))])));
}

function policyReceipt(before, after) {
  return {
    packageJsonUnchanged: before["package.json"] === after["package.json"],
    bunLockUnchanged: before["bun.lock"] === after["bun.lock"],
    agentsMdUnchanged: before["AGENTS.md"] === after["AGENTS.md"],
    baselineSha256: {
      packageJson: before["package.json"],
      bunLock: before["bun.lock"],
      agentsMd: before["AGENTS.md"],
    },
  };
}

async function npmInstall(cwd, specs, env, timeoutMs, omit = []) {
  const args = ["install", ...specs, "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund", ...omit.map((name) => `--omit=${name}`)];
  await run("npm", args, { cwd, env, timeoutMs });
}

async function preparePackage(scratch, env, timeoutMs) {
  const packDir = path.join(scratch, "packs");
  const candidateDir = path.join(scratch, "candidate");
  await fs.mkdir(packDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(candidateDir, { recursive: true, mode: 0o700 });
  const first = await run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], {
    cwd: root,
    env,
    timeoutMs,
  });
  const packed = parseSinglePack(first.stdout);
  const originalTarball = path.join(packDir, packed.filename);
  await run("tar", ["-xzf", originalTarball, "-C", candidateDir], { env, timeoutMs });
  const packageDir = path.join(candidateDir, "package");
  const sourceManifest = JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8"));
  const candidateManifest = mutateCandidatePackage(sourceManifest);
  await run("bun", [
    "build",
    "--no-bundle",
    "--target=bun",
    "--format=esm",
    "--sourcemap=none",
    `--outfile=${path.join(packageDir, "tui.generated.js")}`,
    path.join(fixtureRoot, "tui.tsx"),
  ], { cwd: root, env, timeoutMs });
  await writeJson(path.join(packageDir, "package.json"), candidateManifest);
  const second = await run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], {
    cwd: packageDir,
    env,
    timeoutMs,
  });
  const candidatePack = parseSinglePack(second.stdout);
  const tarball = path.join(packDir, candidatePack.filename);
  const inventory = candidatePack.files
    .map(({ path: file, size, mode }) => ({ path: file, size, mode }))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (!inventory.some((entry) => entry.path === "tui.generated.js")) {
    throw new Error("candidate tarball omitted tui.generated.js");
  }
  return {
    tarball,
    manifest: candidateManifest,
    tarballSha256: await sha256File(tarball),
    inventorySha256: createHash("sha256").update(JSON.stringify(inventory)).digest("hex"),
    inventoryCount: inventory.length,
  };
}

async function verifyPeerless(scratch, candidate, env, timeoutMs) {
  const consumer = path.join(scratch, "peerless-consumer");
  await fs.mkdir(consumer, { recursive: true, mode: 0o700 });
  await writeJson(path.join(consumer, "package.json"), { private: true, type: "module" });
  await npmInstall(consumer, [candidate.tarball], env, timeoutMs, ["optional", "peer"]);
  const probe = [
    'import { createRequire } from "node:module";',
    `const mod = await import(${JSON.stringify("@mcrescenzo/opencode-self-evolve")});`,
    'if (Object.keys(mod).join(",") !== "default" || typeof mod.default !== "function") process.exit(11);',
    "const require = createRequire(import.meta.url);",
    'for (const id of ["@opencode-ai/plugin", "@opentui/core", "@opentui/keymap", "@opentui/solid", "solid-js"]) {',
    "  try { require.resolve(id); process.exit(12); } catch (error) { if (error?.code !== \"MODULE_NOT_FOUND\") throw error; }",
    "}",
  ].join("\n");
  await run(process.execPath, ["--input-type=module", "--eval", probe], { cwd: consumer, env, timeoutMs });
  return { rootServerExportPeerless: true, peerlessOptionalPackagesAbsent: true };
}

async function resolvedVersion(consumer, name) {
  const manifest = JSON.parse(await fs.readFile(path.join(consumer, "node_modules", ...name.split("/"), "package.json"), "utf8"));
  return manifest.version;
}

async function prepareTuiConsumer(scratch, candidate, env, timeoutMs) {
  const consumer = path.join(scratch, "tui-consumer");
  await fs.mkdir(consumer, { recursive: true, mode: 0o700 });
  await writeJson(path.join(consumer, "package.json"), { private: true, type: "module" });
  await npmInstall(consumer, Object.entries(EXACT_TUI_PACKAGES).map(([name, version]) => `${name}@${version}`), env, timeoutMs);
  await npmInstall(consumer, [candidate.tarball], env, timeoutMs);
  for (const [name, version] of Object.entries(EXACT_TUI_PACKAGES)) {
    const actual = await resolvedVersion(consumer, name);
    if (actual !== version) throw new Error(`${name} resolved to ${actual}, expected ${version}`);
  }
  const witnessDir = path.join(consumer, "node_modules", ".self-evolve-host-spike");
  await fs.mkdir(witnessDir, { recursive: true, mode: 0o700 });
  const witness = path.join(witnessDir, "witness.mjs");
  await fs.copyFile(path.join(fixtureRoot, "witness.mjs"), witness);
  return {
    consumer,
    witness,
    candidateRoot: path.join(consumer, "node_modules", "@mcrescenzo", "opencode-self-evolve"),
  };
}

async function prepareProject(scratch, consumer) {
  const project = path.join(scratch, "project");
  const configDir = path.join(project, ".opencode");
  const workspaceDir = path.join(scratch, "warped-workspace");
  const workspacePlugin = path.join(project, "workspace-plugin.mjs");
  const fixtureState = path.join(project, ".self-evolve-spike-state.json");
  const eventsPath = path.join(project, ".self-evolve-spike-events.jsonl");
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(workspaceDir, { recursive: true, mode: 0o700 });
  await fs.copyFile(path.join(fixtureRoot, "workspace-plugin.mjs"), workspacePlugin);
  await writeJson(fixtureState, { cardVisible: false });
  await fs.writeFile(eventsPath, "", { mode: 0o600 });
  const config = spikeConfigs({
    witnessUrl: pathToFileURL(consumer.witness).href,
    candidateUrl: pathToFileURL(consumer.candidateRoot).href,
    workspacePluginUrl: pathToFileURL(workspacePlugin).href,
  });
  await writeJson(path.join(project, "opencode.json"), config.server);
  await writeJson(path.join(configDir, "tui.json"), config.tui);
  return { project, workspaceDir, fixtureState, eventsPath, workspacePlugin };
}

function processDirectories(scratch, project) {
  return {
    project,
    home: path.join(scratch, "home"),
    xdgConfig: path.join(scratch, "xdg-config"),
    xdgData: path.join(scratch, "xdg-data"),
    xdgState: path.join(scratch, "xdg-state"),
    xdgCache: path.join(scratch, "xdg-cache"),
    npmCache: path.join(scratch, "npm-cache"),
  };
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
  try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
  if (await waitForProcessGroupExit(child.pid, 3000)) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
  if (!await waitForProcessGroupExit(child.pid, 3000)) {
    throw new Error("PTY process group survived SIGKILL");
  }
}

async function runTuiStage({ stage, columns, rows, opencodeBin, timeoutMs, directories, paths, baseEnv, children }) {
  const receiptPath = path.join(paths.scratch, `.stage-${stage}-receipt.json`);
  const command = `stty cols ${columns} rows ${rows} && exec ${[opencodeBin, ".", "--print-logs", "--log-level", "WARN"].map(shellQuote).join(" ")}`;
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    cwd: directories.project,
    detached: true,
    stdio: ["pipe", "ignore", "pipe"],
    env: {
      ...isolatedEnvironment(baseEnv, directories),
      COLUMNS: String(columns),
      LINES: String(rows),
      SELF_EVOLVE_TUI_SPIKE_STAGE: String(stage),
      SELF_EVOLVE_TUI_SPIKE_RECEIPT: receiptPath,
      SELF_EVOLVE_TUI_SPIKE_HANDOFF: paths.handoff,
      SELF_EVOLVE_TUI_SPIKE_FIXTURE_STATE: paths.fixtureState,
      SELF_EVOLVE_TUI_SPIKE_EVENTS: paths.eventsPath,
      SELF_EVOLVE_TUI_SPIKE_WORKSPACE: paths.workspaceDir,
      SELF_EVOLVE_TUI_SPIKE_PRODUCT_VERSION: CANDIDATE_VERSION,
    },
  });
  children.add(child);
  let spawnError;
  child.on("error", (error) => { spawnError = error; });
  let stderr = "";
  let overflow = false;
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    if (Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) overflow = true;
    stderr = stderr.slice(-MAX_OUTPUT_BYTES);
  });
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (spawnError) throw new Error(`stage ${stage} PTY failed to start: ${spawnError.message}`);
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`stage ${stage} exited before receipt: ${stderr.trim().slice(-1000)}`);
      }
      if (await exists(receiptPath)) {
        const value = await readBoundedJson(receiptPath);
        if (value?.status === "failed") {
          throw new Error(`stage ${stage} witness failed (${value.errorCode ?? "spike-failed"}): ${String(value.error ?? "private diagnostic unavailable").slice(0, 500)}`);
        }
        const receipt = validateStageReceipt(value, stage);
        child.stdin.write("\u0003\u0003");
        await stopProcessGroup(child);
        if (overflow) throw new Error(`stage ${stage} diagnostics exceeded their byte bound`);
        return receipt;
      }
      await delay(50);
    }
    throw new Error(`stage ${stage} timed out`);
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
    .replace(/\bses_[A-Za-z0-9_-]+\b/g, "<session>")
    .replace(/\b(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1<redacted>@")
    .replace(/\bfile:\/\/[^\s]+/giu, "file://<redacted>")
    .replace(/(^|[\s("'=])\/[A-Za-z0-9._~!$&()*+,;=:@%/+-]+/gu, "$1<path>")
    .replace(/\b[A-Za-z]:\\[^\s"'<>|]+/gu, "<path>")
    .slice(0, 1200);
}

export async function main(options = {}) {
  const env = options.env ?? process.env;
  const streams = options.streams ?? process;
  const children = new Set();
  let scratch;
  let result = 1;
  let publicReceipt;
  let failure;
  let baseline;
  try {
    const { opencodeBin, timeoutMs } = liveOptions(env);
    const version = spawnSync(opencodeBin, ["--version"], { encoding: "utf8", env, shell: false, timeout: 10_000 });
    if (version.status !== 0 || version.error) throw new Error(version.stderr?.trim() || version.error?.message || "opencode --version failed");
    assertOpenCodeVersion(version.stdout);
    const scriptVersion = spawnSync("script", ["--version"], { encoding: "utf8", env, shell: false, timeout: 10_000 });
    if (scriptVersion.status !== 0) throw new Error("util-linux script is required");
    baseline = await policyHashes();
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "self-evolve-tui-host-spike-"));
    await fs.chmod(scratch, 0o700);
    const directories = processDirectories(scratch, path.join(scratch, "project"));
    for (const directory of Object.values(directories)) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const isolated = isolatedEnvironment(env, directories);
    const candidate = await preparePackage(scratch, isolated, timeoutMs);
    const peerless = await verifyPeerless(scratch, candidate, isolated, timeoutMs);
    const consumer = await prepareTuiConsumer(scratch, candidate, isolated, timeoutMs);
    const project = await prepareProject(scratch, consumer);
    directories.project = project.project;
    const paths = {
      scratch,
      handoff: path.join(scratch, ".private-handoff.json"),
      fixtureState: project.fixtureState,
      eventsPath: project.eventsPath,
      workspaceDir: project.workspaceDir,
    };
    const stage1 = await runTuiStage({
      stage: 1,
      columns: 160,
      rows: 50,
      opencodeBin,
      timeoutMs,
      directories,
      paths,
      baseEnv: env,
      children,
    });
    const stage2 = await runTuiStage({
      stage: 2,
      columns: 72,
      rows: 24,
      opencodeBin,
      timeoutMs,
      directories,
      paths,
      baseEnv: env,
      children,
    });
    const policy = policyReceipt(baseline, await policyHashes());
    publicReceipt = buildPublicReceipt({
      stage1,
      stage2,
      ...peerless,
      tarballSha256: candidate.tarballSha256,
      inventorySha256: candidate.inventorySha256,
      inventoryCount: candidate.inventoryCount,
      lifecycleScripts: ["preinstall", "install", "postinstall"].filter((name) => typeof candidate.manifest.scripts?.[name] === "string"),
      policy,
      cleanup: { trackedTuiProcessGroupsStopped: children.size === 0, scratchRemoved: true },
    });
    result = 0;
  } catch (error) {
    failure = error;
  } finally {
    await Promise.all([...children].map((child) => stopProcessGroup(child).catch(() => {})));
    children.clear();
    if (scratch) await fs.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
    if (baseline) {
      const finalPolicy = policyReceipt(baseline, await policyHashes().catch(() => ({})));
      if ([finalPolicy.packageJsonUnchanged, finalPolicy.bunLockUnchanged,
        finalPolicy.agentsMdUnchanged].some((value) => value !== true)) {
        failure = new Error("repository policy files changed during the spike");
        result = 1;
      }
    }
  }
  if (result === 0 && publicReceipt && (!scratch || !await exists(scratch))) {
    streams.stdout.write(`[self-evolve-tui-host-spike] verified receipt ${JSON.stringify(publicReceipt)}\n`);
    return 0;
  }
  streams.stderr.write(`[self-evolve-tui-host-spike] REQUIRED GATE FAILED: ${safeFailure(failure ?? new Error("scratch cleanup failed"), scratch)}\n`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exit(await main());
}
