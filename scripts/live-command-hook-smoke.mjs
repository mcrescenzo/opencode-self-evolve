import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TIMEOUT_MS = 20_000;
const SENTINEL = "SELF_EVOLVE_LIVE_SMOKE ";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginPath = path.join(repoRoot, "self-evolve.js");
const tuiPluginPath = path.join(repoRoot, "self-evolve-tui.js");
const stateRootModulePath = path.join(repoRoot, "self-evolve-state-root.js");
const homeOpencode = process.env.HOME ? path.join(process.env.HOME, ".opencode/bin/opencode") : "";
const opencodeCommand = process.env.OPENCODE_BIN || (homeOpencode && existsSync(homeOpencode) ? homeOpencode : "opencode");

function withTimeout(promise, label, timeoutMs = TIMEOUT_MS) {
  let timeoutID;
  const timeout = new Promise((_, reject) => {
    timeoutID = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutID));
}

function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return withTimeout(new Promise((resolve) => child.once("exit", resolve)), "opencode shutdown", timeoutMs);
}

async function commandOutput(command, args, options = {}) {
  return await withTimeout(new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} ${args.join(" ")} failed (code=${code}, signal=${signal}): ${stderr.trim()}`));
    });
  }), `${command} ${args.join(" ")}`);
}

async function getFreePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startMockProvider() {
  const requests = [];
  const server = createHttpServer((request, response) => {
    let source = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { source += chunk; });
    request.on("end", () => {
      let body = null;
      try { body = source ? JSON.parse(source) : null; } catch {}
      requests.push({ method: request.method, url: request.url, body });
      if (request.method === "GET" && request.url?.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [{ id: "self-evolve-smoke", object: "model", owned_by: "self-evolve-smoke" }] }));
        return;
      }
      if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "unsupported mock-provider route" } }));
        return;
      }
      const model = body?.model ?? "self-evolve-smoke";
      const created = Math.floor(Date.now() / 1000);
      if (body?.stream === false) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: "chatcmpl-self-evolve-smoke",
          object: "chat.completion",
          created,
          model,
          choices: [{ index: 0, message: { role: "assistant", content: "self-evolve command hook exercised" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(`data: ${JSON.stringify({ id: "chatcmpl-self-evolve-smoke", object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: "self-evolve command hook exercised" }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: "chatcmpl-self-evolve-smoke", object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function executeSessionCommand(baseUrl, sessionId, directory) {
  const response = await fetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}/command?directory=${encodeURIComponent(directory)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "self-evolve", arguments: "health", model: "smoke/self-evolve-smoke" }),
  });
  const source = await response.text();
  if (!response.ok) throw new Error(`session command ${response.status}: ${source}`);
  return source ? JSON.parse(source) : null;
}

async function readSessionMessages(baseUrl, sessionId, directory) {
  const response = await fetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}/message?directory=${encodeURIComponent(directory)}`);
  const source = await response.text();
  if (!response.ok) throw new Error(`session messages ${response.status}: ${source}`);
  const value = source ? JSON.parse(source) : [];
  return Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : [];
}

async function fetchHealth(baseUrl) {
  const response = await fetch(`${baseUrl}/global/health`);
  if (!response.ok) throw new Error(`health request failed: ${response.status}`);
  return await response.json();
}

async function createSession(baseUrl, directory) {
  const attempts = [
    { url: `${baseUrl}/session`, body: { title: "self-evolve live command hook smoke", directory } },
    { url: `${baseUrl}/session?directory=${encodeURIComponent(directory)}`, body: { title: "self-evolve live command hook smoke" } },
    { url: `${baseUrl}/session`, body: { title: "self-evolve live command hook smoke", parentID: "", directory } },
  ];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      const response = await fetch(attempt.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(attempt.body),
      });
      if (response.ok) return await response.json();
      lastError = new Error(`session create ${response.status}: ${await response.text()}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("session create failed");
}

function assertSmokePayload(payload) {
  const checks = payload?.checks ?? {};
  const failed = Object.entries(checks).filter(([, value]) => value !== true).map(([key]) => key);
  if (payload?.ok !== true || failed.length > 0) {
    throw new Error(`live smoke reported failed checks: ${failed.join(", ") || "unknown"}`);
  }
}

async function runRestartProbe({ phase, probePlugin, projectDir, baseEnv, configPath }) {
  const port = await getFreePort();
  const configContent = JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "noop/noop",
    small_model: "noop/noop",
    plugin: [probePlugin],
    instructions: [],
    mcp: {},
    permission: { read: "deny", edit: "deny", bash: "deny", task: "deny" },
  });
  await writeFile(configPath, configContent, "utf8");
  const probeConfigHome = path.join(path.dirname(configPath), `restart-config-${phase}`);
  const probeOpencodeConfigDir = path.join(probeConfigHome, "opencode");
  await mkdir(probeOpencodeConfigDir, { recursive: true });
  await writeFile(path.join(probeOpencodeConfigDir, "opencode.json"), configContent, "utf8");
  const env = { ...baseEnv, XDG_CONFIG_HOME: probeConfigHome, OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_CONTENT: configContent, SELF_EVOLVE_RESTART_PHASE: phase };
  let child;
  let stdout = "";
  let stderr = "";
  try {
    let resolveListening;
    const listening = new Promise((resolve) => { resolveListening = resolve; });
    const result = new Promise((resolve, reject) => {
      let buffer = "";
      const processLine = (line) => {
        const listenMatch = line.match(/opencode server listening on (http:\/\/[^\s]+)/);
        if (listenMatch) resolveListening(listenMatch[1]);
        const marker = line.indexOf(SENTINEL);
        if (marker < 0) return;
        try {
          const payload = JSON.parse(line.slice(marker + SENTINEL.length));
          if (payload?.phase === phase) resolve(payload);
        } catch (error) { reject(error); }
      };
      child = spawn(opencodeCommand, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--log-level", "ERROR"], {
        cwd: projectDir,
        env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        lines.forEach(processLine);
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("exit", (code, signal) => reject(new Error(`restart probe ${phase} exited early (code=${code}, signal=${signal})`)));
    });
    result.catch(() => {});
    const baseUrl = await withTimeout(listening, `restart probe ${phase} listen`);
    await createSession(baseUrl, projectDir);
    return await withTimeout(result, `restart probe ${phase}`);
  } catch (error) {
    error.message += `\nstdout: ${stdout}\nstderr: ${stderr}`;
    throw error;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      if (process.platform === "win32") child.kill("SIGTERM");
      else process.kill(-child.pid, "SIGTERM");
      await waitForExit(child).catch(() => {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      });
    }
  }
}

async function runDirectPluginChildProbe({ pluginPath, projectDir, baseEnv, configPath }) {
  const port = await getFreePort();
  let mockProvider;
  let child;
  let stdout = "";
  let stderr = "";
  let report;
  try {
    mockProvider = await startMockProvider();
    const configContent = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "smoke/self-evolve-smoke",
      small_model: "smoke/self-evolve-smoke",
      plugin: [pluginPath],
      provider: {
        smoke: {
          npm: "@ai-sdk/openai-compatible",
          name: "Self-evolve local smoke provider",
          options: { baseURL: mockProvider.baseURL, apiKey: "self-evolve-smoke" },
          models: { "self-evolve-smoke": { name: "Self-evolve local smoke" } },
        },
      },
      instructions: [],
      mcp: {},
      permission: { read: "deny", edit: "deny", bash: "deny", task: "deny" },
    });
    await writeFile(configPath, configContent, "utf8");
    const childConfigHome = path.join(path.dirname(configPath), "direct-plugin-config");
    const childOpencodeConfigDir = path.join(childConfigHome, "opencode");
    const childStateHome = path.join(path.dirname(configPath), "direct-plugin-state");
    await mkdir(childOpencodeConfigDir, { recursive: true });
    await writeFile(path.join(childOpencodeConfigDir, "opencode.json"), configContent, "utf8");
    const env = { ...baseEnv, XDG_CONFIG_HOME: childConfigHome, XDG_STATE_HOME: childStateHome, OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_CONTENT: configContent };
    let resolveListening;
    let rejectListening;
    const listening = new Promise((resolve, reject) => {
      resolveListening = resolve;
      rejectListening = reject;
    });
    let buffer = "";
    child = spawn(opencodeCommand, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--log-level", "ERROR"], {
      cwd: projectDir,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const match = line.match(/opencode server listening on (http:\/\/[^\s]+)/);
        if (match) resolveListening(match[1]);
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectListening);
    child.once("exit", (code, signal) => rejectListening(new Error(`direct plugin child exited early (code=${code}, signal=${signal})`)));

    const baseUrl = await withTimeout(listening, "direct plugin child listen");
    const officialHealth = await fetchHealth(baseUrl);
    const session = await createSession(baseUrl, projectDir);
    const sessionId = session?.id ?? session?.data?.id;
    if (typeof sessionId !== "string" || !sessionId) throw new Error(`direct plugin child returned no session id: ${JSON.stringify(session)}`);
    const commandResponse = await fetch(`${baseUrl}/command`);
    if (!commandResponse.ok) throw new Error(`direct plugin child command registry ${commandResponse.status}: ${await commandResponse.text()}`);
    const commands = await commandResponse.json();
    const commandRegistered = Array.isArray(commands) && commands.some((item) => item?.name === "self-evolve" || item?.id === "self-evolve");
    const stateRoot = path.join(childStateHome, "opencode");
    const settingsPath = path.join(stateRoot, "self-evolve", "global", "settings.json");
    for (let attempt = 0; !existsSync(settingsPath) && attempt < 200; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const stateLayoutCreated = existsSync(settingsPath);
    if (!stateLayoutCreated) throw new Error(`direct plugin child did not boot durable state at ${settingsPath}`);
    const commandResult = await withTimeout(executeSessionCommand(baseUrl, sessionId, projectDir), "direct plugin child command");
    const messages = await readSessionMessages(baseUrl, sessionId, projectDir);
    const expectedHealth = `Self-evolve health: host ${officialHealth.version}; source global-health`;
    const commandResultTexts = (commandResult?.parts ?? [])
      .map((part) => typeof part?.text === "string" ? part.text.slice(0, 500) : "")
      .filter(Boolean);
    const sessionMessageTexts = messages
      .flatMap((message) => message?.parts ?? [])
      .map((part) => typeof part?.text === "string" ? part.text.slice(0, 500) : "")
      .filter(Boolean)
      .slice(-10);
    const commandHookExecuted = [...commandResultTexts, ...sessionMessageTexts]
      .some((text) => text.includes(expectedHealth));
    report = {
      pid: child.pid,
      sessionId,
      officialHealth,
      stateRoot,
      stateLayoutCreated,
      commandRegistered,
      commandHookExecuted,
      commandResultReturned: Boolean(commandResult?.info && Array.isArray(commandResult?.parts)),
      commandResultTexts,
      sessionMessageTexts,
      localProviderRequests: mockProvider.requests.length,
      directRegistration: true,
      processAliveBeforeStop: child.exitCode === null && child.signalCode === null,
    };
    return report;
  } catch (error) {
    error.message += `\nstdout: ${stdout}\nstderr: ${stderr}`;
    throw error;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      if (process.platform === "win32") child.kill("SIGTERM");
      else process.kill(-child.pid, "SIGTERM");
      await waitForExit(child).catch(() => {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      });
    }
    if (report) report.processAliveAfterStop = child ? child.exitCode === null && child.signalCode === null : false;
    await mockProvider?.close().catch(() => {});
  }
}

async function main() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "self-evolve-live-smoke-"));
  let child;
  let stdout = "";
  let stderr = "";
  let report = null;
  try {
    const projectDir = path.join(tempRoot, "project");
    const configHome = path.join(tempRoot, "config");
    const opencodeConfigDir = path.join(configHome, "opencode");
    const dataHome = path.join(tempRoot, "data");
    const cacheHome = path.join(tempRoot, "cache");
    const stateHome = path.join(tempRoot, "state");
    const homeDir = path.join(tempRoot, "home");
    const fixturePlugin = path.join(tempRoot, "self-evolve-live-fixture.mjs");
    const restartProbePlugin = path.join(tempRoot, "self-evolve-restart-probe.mjs");
    const restartProbeConfig = path.join(tempRoot, "opencode-restart-probe.json");
    const directProbeConfig = path.join(tempRoot, "opencode-direct-probe.json");
    const explicitConfig = path.join(tempRoot, "opencode.json");
    const port = await getFreePort();

    await Promise.all([projectDir, opencodeConfigDir, dataHome, cacheHome, stateHome, homeDir].map((dir) => mkdir(dir, { recursive: true })));

    await writeFile(fixturePlugin, `
import SelfEvolvePlugin from ${JSON.stringify(pathToFileURL(pluginPath).href)};
import CompatibilitySelfEvolvePlugin from ${JSON.stringify(`${pathToFileURL(pluginPath).href}?live-smoke-compatibility`)};
import SelfEvolveTuiModule from ${JSON.stringify(pathToFileURL(tuiPluginPath).href)};
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createIntegration } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "self-evolve-integration.js")).href)};
import { createApplier } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "self-evolve-applier.js")).href)};
import { createPrivacyGuard } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "self-evolve-privacy.js")).href)};
import { openStore, projectFingerprintFor } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "self-evolve-store.js")).href)};
import * as schemas from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "self-evolve-schemas.js")).href)};
import * as commands from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "self-evolve-commands.js")).href)};
import * as inventory from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "self-evolve-inventory.js")).href)};
import { createControlRequest, pollControlResponse, readControlState, submitControlRequest } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "self-evolve-bridge.js")).href)};

let smokeStarted = false;

function text(output) {
  return (output.parts || []).map((part) => part.text || part.content || "").filter(Boolean).join("\\n");
}

async function runCommand(hooks, output, sessionID, args) {
  const originalParts = output.parts;
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID, arguments: args }, output);
  return { args, text: text(output), samePartsArray: output.parts === originalParts };
}

async function waitForStartup(hooks, sessionID) {
  const output = { parts: [] };
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await runCommand(hooks, output, sessionID, "status");
    if (!/startup-validation-pending/.test(result.text)) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("deferred self-evolve startup did not settle");
}

export default async function SelfEvolveLiveSmokePlugin(ctx) {
  return {
    config: async (cfg) => {
      if (smokeStarted) return;
      smokeStarted = true;
      const compatibilityHooks = await CompatibilitySelfEvolvePlugin(ctx, { durableAutonomy: false, now: () => 42_000 });
      cfg.model = cfg.model || "noop/noop";
      cfg.agent = cfg.agent || {};
      await compatibilityHooks.config(cfg);
      setTimeout(() => { void (async () => {
      const runningHealthResponse = await fetch(new URL("/global/health", ctx.serverUrl), { redirect: "error" });
      const runningHealth = { data: await runningHealthResponse.json() };

      const sessionID = "live-smoke-session";
      const output = { parts: [{ type: "text", text: "original" }] };
      const originalParts = output.parts;
      const status = await runCommand(compatibilityHooks, output, sessionID, "status");
      const pause = await runCommand(compatibilityHooks, output, sessionID, "pause");
      const pausedStatus = await runCommand(compatibilityHooks, output, sessionID, "status");
      const resume = await runCommand(compatibilityHooks, output, sessionID, "resume");
      const finalStatus = await runCommand(compatibilityHooks, output, sessionID, "status");
      const analyzer = cfg.agent["mcrescenzo.self-evolve.analyzer"] ?? cfg.agent["self-evolve-analyzer"];
      const lifecycleCalls = { messages: [], create: [], prompt: [], abort: [], showToast: [], promptAsync: [] };
      const lifecycleProposal = {
        reason: "No-token smoke accepted proposal.",
        proposal: {
          title: "Add troubleshooting docs for smoke lifecycle",
          summary: "The smoke transcript mentions troubleshooting docs, so a small repo-local note would help future validation.",
          evidence: ["The no-token smoke transcript discusses troubleshooting docs and analyzer lifecycle validation."],
          target: { path: "docs/troubleshooting.md", surface: "repo-local docs", symbol: "" },
          placement: "repo-local",
          risk: "low",
          riskMitigation: "Keep the troubleshooting docs change small and advisory-only.",
          confidence: 0.91,
          suggestedAction: "Add troubleshooting docs guidance for the no-token analyzer lifecycle smoke.",
        },
      };
      const lifecycleCtx = {
        directory: ctx.directory,
        client: {
          tui: {
            showToast: async (args) => {
              lifecycleCalls.showToast.push(args);
              return { data: {} };
            },
          },
          session: {
            messages: async (args) => {
              lifecycleCalls.messages.push(args);
              return { data: [{ id: "smoke-message", role: "user", parts: [{ type: "text", text: "Please check troubleshooting docs for analyzer lifecycle validation." }] }] };
            },
            create: async (args) => {
              lifecycleCalls.create.push(args);
              return { data: { id: "smoke-analyzer-session" } };
            },
            prompt: async (args) => {
              lifecycleCalls.prompt.push(args);
              return { data: { parts: [{ type: "text", text: JSON.stringify(lifecycleProposal) }] } };
            },
            promptAsync: async (args) => {
              lifecycleCalls.promptAsync.push(args);
              return { data: {} };
            },
            abort: async (args) => {
              lifecycleCalls.abort.push(args);
              return { data: {} };
            },
          },
        },
      };
      const lifecycleHooks = await CompatibilitySelfEvolvePlugin(lifecycleCtx, { durableAutonomy: false, now: () => 43_000, deliveryTimeoutMs: 50, sdkTimeoutMs: 50, cleanupTimeoutMs: 50 });
      await lifecycleHooks.config({ model: "noop/noop", agent: {} });
      const lifecycleOutput = { parts: [{ type: "text", text: "original" }] };
      const lifecycle = await runCommand(lifecycleHooks, lifecycleOutput, "lifecycle-session", "scan");
      const analyzerLeakPattern = /Analyze this OpenCode session excerpt|Redacted transcript excerpt|JSON schema|\\{"proposal"|self-evolve-analyzer|mcrescenzo\.self-evolve\.analyzer/;

      const durableFingerprint = projectFingerprintFor("", ctx.worktree || ctx.directory);
      const hostStateRoot = ${JSON.stringify(path.join(stateHome, "opencode-live-state"))};
      const seedStore = openStore(hostStateRoot, { projectFingerprint: durableFingerprint, now: () => Date.now() });
      const oldObservation = schemas.makeObservation({
        id: "1".repeat(64), projectFingerprint: durableFingerprint, receiptIds: ["2".repeat(64)],
        structuredFields: { receiptType: "repeated-command", scopeFingerprint: durableFingerprint, occurrences: 1 },
        incidentId: "live-smoke-expired", createdAt: 1, injectionFlagged: false, redacted: true,
      });
      seedStore.appendRecord(schemas.wrapRecord("observation", oldObservation, 1));
      seedStore.close();
      const injectionCalls = { promptAsync: 0, appendPrompt: 0 };
      const durableCtx = {
        ...ctx,
        client: {
          ...ctx.client,
          path: ctx.client.path,
          session: { ...ctx.client.session, promptAsync: async () => { injectionCalls.promptAsync += 1; throw new Error("promptAsync prohibited"); } },
          tui: { ...ctx.client.tui, appendPrompt: async () => { injectionCalls.appendPrompt += 1; throw new Error("appendPrompt prohibited"); } },
        },
      };
      const durableManual = await SelfEvolvePlugin(durableCtx, { stateRoot: hostStateRoot });
      await durableManual.config({ model: "noop/noop", agent: {} });
      await waitForStartup(durableManual, "durable-manual-startup");
      const durableManualOutput = { parts: [] };
      await durableManual["command.execute.before"]({ command: "self-evolve", sessionID: "durable-manual", arguments: "status" }, durableManualOutput);
      const durableHealthOutput = { parts: [] };
      await durableManual["command.execute.before"]({ command: "self-evolve", sessionID: "durable-health", arguments: "health" }, durableHealthOutput);
      const retainedStore = openStore(hostStateRoot, { projectFingerprint: durableFingerprint });
      const startupRetentionExecuted = retainedStore.readRecords("observation").length === 0;
      retainedStore.close();
      const durableAutoOutput = { parts: [] };
      await durableManual["command.execute.before"]({ command: "self-evolve", sessionID: "durable-auto", arguments: "auto" }, durableAutoOutput);
      await durableManual.dispose();
      const durableAuto = await SelfEvolvePlugin(durableCtx, { stateRoot: hostStateRoot });
      await waitForStartup(durableAuto, "durable-auto-startup");
      const durableSkillRoot = path.join(ctx.directory, "durable-control-skills");
      mkdirSync(durableSkillRoot, { recursive: true });
      const durableYoloOutput = { parts: [] };
      await durableAuto["command.execute.before"]({ command: "self-evolve", sessionID: "durable-yolo", arguments: "yolo confirm --allowlist " + durableSkillRoot }, durableYoloOutput);
      await durableAuto.dispose();
      const durableYolo = await SelfEvolvePlugin(durableCtx, { stateRoot: hostStateRoot });
      await waitForStartup(durableYolo, "durable-yolo-startup");
      const durableManualResetOutput = { parts: [] };
      await durableYolo["command.execute.before"]({ command: "self-evolve", sessionID: "durable-manual-reset", arguments: "manual" }, durableManualResetOutput);
      await durableYolo.dispose();
      const durableManualRestart = await SelfEvolvePlugin(durableCtx, { stateRoot: hostStateRoot });
      await waitForStartup(durableManualRestart, "durable-manual-restart-startup");

      const exactStateRoot = path.join(hostStateRoot, "exact-headless-fixture");
      const exactSkillRoot = path.join(ctx.directory, "exact-headless-skills");
      const exactSkillDir = path.join(exactSkillRoot, "smoke");
      const exactSkillPath = path.join(exactSkillDir, "SKILL.md");
      const currentContent = "---\\nname: smoke\\ndescription: Verifies exact no-token approval.\\n---\\n\\n# Smoke\\n\\nCurrent.\\n";
      const proposedContent = currentContent + "\\nApproved through the exact headless tuple.\\n";
      mkdirSync(exactSkillDir, { recursive: true });
      writeFileSync(exactSkillPath, currentContent, "utf8");
      const exactStore = openStore(exactStateRoot, { projectFingerprint: durableFingerprint });
      const exactSettings = exactStore.getSettings();
      exactStore.setGlobalSettings(schemas.makeGlobalSettings({ ...exactSettings.global, mode: "auto", allowedSkillRoots: [exactSkillRoot], updatedAt: Date.now() }));
      const roots = inventory.loadAllowlist({ globalSkillRoots: [exactSkillRoot] }).canonicalRoots;
      const records = inventory.discoverSkills(roots);
      const target = records[0];
      const proposedHash = inventory.hashSkillContent(proposedContent);
      const exactProposal = schemas.makeProposal({
        id: "live-headless-proposal", projectFingerprint: durableFingerprint, clusterId: "3".repeat(64),
        skillTarget: { canonicalRoot: target.canonicalRoot, relativePath: target.relativePath, currentHash: target.currentHash },
        proposedContentHash: proposedHash, rationaleText: "No-token live fixture exact approval.", synthesizedAt: Date.now(),
        synthesizerModelId: "no-provider/fixture", criticScore: 1, criticPassed: true, validDeterministic: true,
        state: "pending", injectionFlagged: false,
      });
      exactStore.appendRecord(schemas.wrapRecord("proposal", exactProposal, Date.now()));
      const exactPrivacy = createPrivacyGuard({ consent: {}, projectFingerprint: durableFingerprint, store: exactStore });
      const exactApplier = createApplier({ store: exactStore, inventory: { records, canonicalRoots: roots }, privacy: exactPrivacy });
      let approvalHeadless = false;
      let approvalNonce = "";
      const exactIntegration = createIntegration({
        store: exactStore, inventory, privacy: exactPrivacy, schemas, observation: {}, synthesisModule: {}, applier: exactApplier, commands,
        pipeline: { createPipeline(deps) { return {
          runEvolutionCycle: async () => ({ result: "no-eligible" }),
          async runApprovalFlow(args) {
            const proposal = exactStore.getRecord("proposal", args.proposalId).payload;
            const decision = exactStore.readRecords("decision").map((record) => record.payload).findLast((item) => item.proposalId === args.proposalId && item.newState === "approved");
            approvalHeadless = args.headless === true;
            approvalNonce = decision?.nonce ?? "";
            const applied = await deps.applier.applyProposal({ proposal: { ...proposal, proposedContent }, decision, mode: args.mode, actor: args.actor, headless: args.headless });
            return applied.ok ? { result: "applied", responseText: "appliedHash " + applied.appliedHash, auditEvents: [] } : { result: "failed-closed", reason: applied.reason, responseText: applied.reason };
          },
          runRollbackFlow: async () => ({ result: "failed-closed" }),
        }; } },
        scheduler: { createScheduler: () => ({ setMode() {}, getCircuitBreaker: () => ({ open: false }), dispose() {} }) },
        options: { stateRoot: exactStateRoot, projectFingerprint: durableFingerprint },
      });
      const staleBridgeFile = path.join(exactStateRoot, "self-evolve", "bridge", durableFingerprint, "responses", "stale.json");
      mkdirSync(path.dirname(staleBridgeFile), { recursive: true });
      writeFileSync(staleBridgeFile, "{}", "utf8");
      const exactBoot = await exactIntegration.boot({ hostVersion: runningHealth.data.version });
      const mailboxCleanupExecuted = !existsSync(staleBridgeFile);
      const controlState = readControlState(exactStateRoot, durableFingerprint);
      const controlRequest = createControlRequest({ controlState, action: "set-consent", payload: { key: "durableObservations", enabled: true }, timestamp: Date.now(), requestId: "live-control" });
      submitControlRequest(exactStateRoot, controlRequest);
      await exactIntegration.processMailbox();
      const controlResponse = pollControlResponse(exactStateRoot, durableFingerprint, controlRequest.requestId);
      const controlPersisted = exactStore.getSettings().global.consent.durableObservations === true;
      const staleControlFile = path.join(exactStateRoot, "self-evolve", "bridge", durableFingerprint, "control-responses", "stale-control.json");
      writeFileSync(staleControlFile, "{}", "utf8");
      const controlCleanup = await exactIntegration.runRetentionSweep();
      const grant = exactStore.readRecords("audit-event").map((record) => record.payload).findLast((event) => event.details?.action === "headless-approval-nonce").details;
      const exactCommand = "/self-evolve approve " + exactProposal.id + " --target-hash " + grant.targetHash + " --proposed-content-hash " + grant.proposedContentHash + " --decision-version " + grant.decisionVersion + " --nonce " + grant.nonce;
      const exactApply = await exactIntegration.handleCommand(exactCommand);
      const exactReplay = await exactIntegration.handleCommand(exactCommand);
      await exactIntegration.shutdown();
      await durableManualRestart.dispose();
      await compatibilityHooks.dispose();

      const actualOpenCodeProcess = {
        serverTargetLoaded: typeof SelfEvolvePlugin === "function",
        tuiTargetLoaded: Boolean(SelfEvolveTuiModule?.id === "mcrescenzo.self-evolve" && typeof SelfEvolveTuiModule.tui === "function"),
        durableIntegrationBooted: /Self-evolve status:/u.test(text(durableManualOutput)),
        runningVersionFromGlobalHealth: runningHealth?.data?.healthy === true && typeof runningHealth?.data?.version === "string",
        durableHealthReportsGlobalVersion: text(durableHealthOutput).includes("host " + runningHealth.data.version),
        globalStateLayoutCreated: existsSync(path.join(hostStateRoot, "self-evolve", "global", "settings.json")),
        projectStateLayoutCreated: existsSync(path.join(hostStateRoot, "self-evolve", durableFingerprint)),
        startupRetentionExecuted,
        manualCommandRouted: /stored mode|effective mode/u.test(text(durableManualOutput)),
        autoCommandRouted: /changed to auto/u.test(text(durableAutoOutput)),
        yoloCommandRouted: /changed to yolo/u.test(text(durableYoloOutput)),
        ordinaryDefaultDurableManual: /stored mode manual|effective mode manual/u.test(text(durableManualOutput)),
        manualPassiveHookAbsent: durableManual.event === undefined && durableManualRestart.event === undefined,
        autoPassiveHookRegistered: typeof durableAuto.event === "function",
        yoloPassiveHookRegistered: typeof durableYolo.event === "function",
        noWorkingSessionInjection: injectionCalls.promptAsync === 0 && injectionCalls.appendPrompt === 0,
        disposeCompleted: true,
      };
      const inProcessFixture = {
        realPackagedModules: true,
        mockedProviderBoundary: true,
        clientPathStateRootContract: await SelfEvolvePlugin.__test.resolveStateRoot({ directory: ctx.directory, client: { path: { get: async () => ({ data: { state: hostStateRoot } }) } } }, { env: {} }) === hostStateRoot,
        exactHeadlessApply: exactApply.ok === true && readFileSync(exactSkillPath, "utf8") === proposedContent,
        exactHeadlessFlagPassed: approvalHeadless,
        exactNoncePreserved: approvalNonce === grant.nonce,
        replayRejected: exactReplay.ok === false,
        mailboxLayoutCreated: existsSync(path.join(exactStateRoot, "self-evolve", "bridge", durableFingerprint, "requests")),
        mailboxPollingBooted: exactBoot.ok === true,
        mailboxCleanupExecuted,
        controlStatePublished: controlState?.projectFingerprint === durableFingerprint && typeof controlState?.nonce === "string",
        controlMailboxAccepted: controlResponse?.ok === true && controlPersisted,
        controlCleanupExecuted: controlCleanup.ok === true && !existsSync(staleControlFile),
        mailboxDisposeCompleted: true,
      };

      const payload = {
        ok: true,
        pluginLoadedInOpenCode: true,
        sessionID,
        commands: { status, pause, pausedStatus, resume, finalStatus, lifecycle },
        checks: {
          analyzerRegistered: Boolean(analyzer?.hidden && analyzer?.permission?.edit === "deny" && analyzer?.permission?.bash === "deny"),
          tuiTargetImported: Boolean(SelfEvolveTuiModule?.id === "mcrescenzo.self-evolve" && typeof SelfEvolveTuiModule.tui === "function"),
          statusText: /Self-evolve status: active/.test(status.text),
          pauseText: /paused/i.test(pause.text),
          pausedStatusText: /Self-evolve status: paused/.test(pausedStatus.text),
          resumeText: /resumed/i.test(resume.text),
          finalStatusText: /Self-evolve status: active/.test(finalStatus.text),
          partsArrayPreserved: output.parts === originalParts && [status, pause, pausedStatus, resume, finalStatus].every((item) => item.samePartsArray),
          noPassiveHooks: compatibilityHooks.event === undefined && compatibilityHooks["chat.message"] === undefined,
          lifecycleMessagesRead: lifecycleCalls.messages.length === 1,
          lifecycleAnalyzerCreated: lifecycleCalls.create.length === 1 && ["mcrescenzo.self-evolve.analyzer", "self-evolve-analyzer"].includes(lifecycleCalls.create[0].body?.agent),
          lifecycleAnalyzerPrompted: lifecycleCalls.prompt.length === 1 && /Analyze this OpenCode session excerpt/.test(lifecycleCalls.prompt[0].body?.parts?.[0]?.text || ""),
          lifecycleCleanup: lifecycleCalls.abort.length === 1,
          lifecycleToast: lifecycleCalls.showToast.length === 1,
          lifecycleNoPromptAsync: lifecycleCalls.promptAsync.length === 0,
          lifecycleAcceptedOutput: /found proposal se-1/.test(lifecycle.text) && /Suggested action:/.test(lifecycle.text),
          lifecycleNoAnalyzerLeak: !analyzerLeakPattern.test(lifecycle.text),
          ...actualOpenCodeProcess,
          ...inProcessFixture,
        },
        evidenceSplit: { actualOpenCodeProcess, inProcessFixture },
        diagnostics: { serverUrlType: typeof ctx.serverUrl, serverUrlValue: String(ctx.serverUrl ?? ""), durableHealthText: text(durableHealthOutput) },
      };
      console.log(${JSON.stringify(SENTINEL)} + JSON.stringify(payload));
      })().catch((error) => console.log(${JSON.stringify(SENTINEL)} + JSON.stringify({ ok: false, error: String(error?.message ?? error), checks: {} }))); }, 0);
    },
  };
}
`, "utf8");

    await writeFile(restartProbePlugin, `
import SelfEvolvePlugin from ${JSON.stringify(pathToFileURL(pluginPath).href)};
import { initialStateRootSelection } from ${JSON.stringify(pathToFileURL(stateRootModulePath).href)};
import { mkdirSync } from "node:fs";
import path from "node:path";

function text(output) {
  return (output.parts || []).map((part) => part.text || part.content || "").filter(Boolean).join("\\n");
}

export default async function SelfEvolveRestartProbe(ctx) {
  const hooks = await SelfEvolvePlugin(ctx);
  return {
    config: async () => {
      setTimeout(async () => {
        const phase = process.env.SELF_EVOLVE_RESTART_PHASE;
        const output = { parts: [] };
        const run = async (argumentsValue) => {
          await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "restart-" + phase, arguments: argumentsValue }, output);
          return text(output);
        };
        let before = await run("status");
        for (let attempt = 0; /startup-validation-pending/u.test(before) && attempt < 100; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          before = await run("status");
        }
        const healthText = await run("health");
        const officialHealthResponse = await fetch(new URL("/global/health", ctx.serverUrl), { redirect: "error" });
        const officialHealth = await officialHealthResponse.json();
        let command = "";
        if (phase === "seed-auto") command = "auto";
        if (phase === "auto") {
          const skillRoot = path.join(ctx.directory, "restart-probe-skills");
          mkdirSync(skillRoot, { recursive: true });
          command = "yolo confirm --allowlist " + skillRoot;
        }
        if (phase === "yolo") command = "manual";
        const changed = command ? await run(command) : "";
        const serverStateRoot = (await ctx.client.path.get({ query: { directory: ctx.directory } })).data.state;
        const tuiStateRoot = initialStateRootSelection({ hostStateRoot: serverStateRoot, environment: {} }).stateRoot;
        console.log(${JSON.stringify(SENTINEL)} + JSON.stringify({
          phase,
          passiveHook: typeof hooks.event === "function",
          chatHookAbsent: hooks["chat.message"] === undefined,
          before,
          changed,
          healthText,
          officialHealth,
          serverStateRoot,
          tuiStateRoot,
        }));
      }, 50);
    },
    dispose: hooks.dispose,
  };
}
`, "utf8");

    const configContent = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "noop/noop",
      small_model: "noop/noop",
      plugin: [fixturePlugin],
      instructions: [],
      mcp: {},
      permission: { read: "deny", edit: "deny", bash: "deny", task: "deny" },
    }, null, 2);
    await writeFile(explicitConfig, configContent, "utf8");
    await writeFile(path.join(opencodeConfigDir, "opencode.json"), configContent, "utf8");

    const env = {
      PATH: process.env.PATH || "",
      HOME: homeDir,
      USER: process.env.USER || "self-evolve-smoke",
      TMPDIR: tempRoot,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_CACHE_HOME: cacheHome,
      XDG_STATE_HOME: stateHome,
      OPENCODE_CONFIG: explicitConfig,
      OPENCODE_CONFIG_CONTENT: configContent,
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    };
    const cliVersion = await commandOutput(opencodeCommand, ["--version"], { cwd: projectDir, env });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let resolveListening;
    let rejectListening;
    const listening = new Promise((resolve, reject) => {
      resolveListening = resolve;
      rejectListening = reject;
    });

    const smokePayload = new Promise((resolve, reject) => {
      function processLine(line) {
        const listenMatch = line.match(/opencode server listening on (http:\/\/[^\s]+)/);
        if (listenMatch) resolveListening(listenMatch[1]);
        const marker = line.indexOf(SENTINEL);
        if (marker < 0) return;
        try {
          resolve(JSON.parse(line.slice(marker + SENTINEL.length)));
        } catch (error) {
          reject(new Error(`failed to parse smoke payload: ${error.message}`));
        }
      }
      child = spawn(opencodeCommand, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--log-level", "ERROR"], {
        cwd: projectDir,
        env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        lines.forEach(processLine);
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        stderrBuffer += chunk;
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = lines.pop() ?? "";
        lines.forEach(processLine);
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        rejectListening(new Error(`opencode exited before listening (code=${code}, signal=${signal})`));
        reject(new Error(`opencode exited before smoke completed (code=${code}, signal=${signal})`));
      });
    });
    // Attach a no-op rejection handler so that if listening/health/session-create
    // throws before smokePayload is awaited, the finally-block force-kill (which
    // rejects this promise via child.on("exit")) does not surface as an unhandled
    // rejection under Node's default --unhandled-rejections=throw.
    smokePayload.catch(() => {});

    const baseUrl = await withTimeout(listening, "opencode listen");
    const health = await fetchHealth(baseUrl);
    if (health?.healthy !== true || health?.version !== cliVersion) throw new Error(`expected healthy OpenCode ${cliVersion} from opencode --version, received ${JSON.stringify(health)}`);
    await createSession(baseUrl, projectDir);
    const payload = await withTimeout(smokePayload, "self-evolve live command hook smoke");
    assertSmokePayload(payload);
    const restartPhases = [];
    for (const phase of ["seed-auto", "auto", "yolo", "manual"]) {
      restartPhases.push(await runRestartProbe({ phase, probePlugin: restartProbePlugin, projectDir, baseEnv: env, configPath: restartProbeConfig }));
    }
    const [seedAuto, autoRestart, yoloRestart, manualRestart] = restartPhases;
    const restartChecks = {
      ordinaryDefaultDurableManual: seedAuto.passiveHook === false && /effective mode manual|stored mode manual/u.test(seedAuto.before),
      persistedAutoFreshProcessHook: autoRestart.passiveHook === true && /effective mode auto|stored mode auto/u.test(autoRestart.before),
      persistedYoloFreshProcessHook: yoloRestart.passiveHook === true && /effective mode yolo|stored mode yolo/u.test(yoloRestart.before),
      persistedManualFreshProcessNoHook: manualRestart.passiveHook === false && /effective mode manual|stored mode manual/u.test(manualRestart.before),
      noPassiveChatHooks: restartPhases.every((item) => item.chatHookAbsent === true),
      serverTuiStateRootsMatch: restartPhases.every((item) => item.serverStateRoot === item.tuiStateRoot && item.serverStateRoot === path.join(stateHome, "opencode")),
      productionPluginReportsCliVersion: restartPhases.every((item) => item.officialHealth?.version === cliVersion && item.healthText.includes("host " + cliVersion) && item.healthText.includes("source global-health")),
    };
    const failedRestartChecks = Object.entries(restartChecks).filter(([, value]) => !value).map(([key]) => key);
    if (failedRestartChecks.length) throw new Error(`fresh-process restart checks failed: ${failedRestartChecks.join(", ")}\n${JSON.stringify(restartPhases)}`);
    const directChildSessionEvidence = await runDirectPluginChildProbe({ pluginPath, projectDir, baseEnv: env, configPath: directProbeConfig });
    if (
      directChildSessionEvidence.directRegistration !== true
      || typeof directChildSessionEvidence.sessionId !== "string"
      || directChildSessionEvidence.officialHealth?.version !== cliVersion
      || directChildSessionEvidence.stateLayoutCreated !== true
      || directChildSessionEvidence.commandRegistered !== true
      || directChildSessionEvidence.commandHookExecuted !== true
      || directChildSessionEvidence.commandResultReturned !== true
      || directChildSessionEvidence.localProviderRequests < 1
      || directChildSessionEvidence.processAliveBeforeStop !== true
      || directChildSessionEvidence.processAliveAfterStop !== false
    ) {
      throw new Error(`direct plugin child-session checks failed: ${JSON.stringify(directChildSessionEvidence)}`);
    }
    report = {
      ok: true,
      smoke: "self-evolve-live-command-hook",
      opencode: health,
      cliVersion,
      runningVersionEvidence: {
        cliEqualsGlobalHealth: cliVersion === health.version,
        pluginReportsGlobalHealthVersion: payload.checks.durableHealthReportsGlobalVersion === true,
        directChildSessionBootedAgainstGlobalHealth: directChildSessionEvidence.stateLayoutCreated === true && directChildSessionEvidence.officialHealth?.version === cliVersion,
        directChildProductionCommandExecuted: directChildSessionEvidence.commandHookExecuted === true && directChildSessionEvidence.commandResultReturned === true,
      },
      evidence: payload.checks,
      evidenceSplit: payload.evidenceSplit,
      restartEvidence: { phases: restartPhases, checks: restartChecks },
      directChildSessionEvidence,
      cleanup: { tempRoot, processAliveBeforeStop: child.exitCode === null && child.signalCode === null },
    };
  } catch (error) {
    error.stdout = stdout;
    error.stderr = stderr;
    throw error;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      if (process.platform === "win32") child.kill("SIGTERM");
      else process.kill(-child.pid, "SIGTERM");
      await waitForExit(child).catch(() => {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      });
    }
    await rm(tempRoot, { recursive: true, force: true });
    if (report) {
      report.cleanup.processAliveAfterStop = child ? child.exitCode === null && child.signalCode === null : false;
      report.cleanup.tempRootRemoved = !existsSync(tempRoot);
      if (report.cleanup.processAliveAfterStop || !report.cleanup.tempRootRemoved) {
        report.ok = false;
        process.exitCode = 1;
      }
      console.log(JSON.stringify(report, null, 2));
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  if (error.stdout) console.error(`--- opencode stdout ---\n${error.stdout}`);
  if (error.stderr) console.error(`--- opencode stderr ---\n${error.stderr}`);
  process.exitCode = 1;
});
