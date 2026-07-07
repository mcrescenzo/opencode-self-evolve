import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TIMEOUT_MS = 20_000;
const SENTINEL = "SELF_EVOLVE_LIVE_SMOKE ";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginPath = path.join(repoRoot, "self-evolve.js");
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

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
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
    const explicitConfig = path.join(tempRoot, "opencode.json");
    const port = await getFreePort();

    await Promise.all([projectDir, opencodeConfigDir, dataHome, cacheHome, stateHome, homeDir].map((dir) => mkdir(dir, { recursive: true })));

    await writeFile(fixturePlugin, `
import SelfEvolvePlugin from ${JSON.stringify(pathToFileURL(pluginPath).href)};

function text(output) {
  return (output.parts || []).map((part) => part.text || part.content || "").filter(Boolean).join("\\n");
}

async function runCommand(hooks, output, sessionID, args) {
  const originalParts = output.parts;
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID, arguments: args }, output);
  return { args, text: text(output), samePartsArray: output.parts === originalParts };
}

export default async function SelfEvolveLiveSmokePlugin(ctx) {
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 42_000 });
  return {
    config: async (cfg) => {
      cfg.model = cfg.model || "noop/noop";
      cfg.agent = cfg.agent || {};
      await hooks.config(cfg);

      const sessionID = "live-smoke-session";
      const output = { parts: [{ type: "text", text: "original" }] };
      const originalParts = output.parts;
      const status = await runCommand(hooks, output, sessionID, "status");
      const pause = await runCommand(hooks, output, sessionID, "pause");
      const pausedStatus = await runCommand(hooks, output, sessionID, "status");
      const resume = await runCommand(hooks, output, sessionID, "resume");
      const finalStatus = await runCommand(hooks, output, sessionID, "status");
      const analyzer = cfg.agent["self-evolve-analyzer"];
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
      const lifecycleHooks = await SelfEvolvePlugin(lifecycleCtx, { now: () => 43_000, deliveryTimeoutMs: 50, sdkTimeoutMs: 50, cleanupTimeoutMs: 50 });
      await lifecycleHooks.config({ model: "noop/noop", agent: {} });
      const lifecycleOutput = { parts: [{ type: "text", text: "original" }] };
      const lifecycle = await runCommand(lifecycleHooks, lifecycleOutput, "lifecycle-session", "scan");
      const analyzerLeakPattern = /Analyze this OpenCode session excerpt|Redacted transcript excerpt|JSON schema|\\{"proposal"|self-evolve-analyzer/;

      const payload = {
        ok: true,
        pluginLoadedInOpenCode: true,
        sessionID,
        commands: { status, pause, pausedStatus, resume, finalStatus, lifecycle },
        checks: {
          analyzerRegistered: Boolean(analyzer?.hidden && analyzer?.permission?.edit === "deny" && analyzer?.permission?.bash === "deny"),
          statusText: /Self-evolve status: active/.test(status.text),
          pauseText: /paused/i.test(pause.text),
          pausedStatusText: /Self-evolve status: paused/.test(pausedStatus.text),
          resumeText: /resumed/i.test(resume.text),
          finalStatusText: /Self-evolve status: active/.test(finalStatus.text),
          partsArrayPreserved: output.parts === originalParts && [status, pause, pausedStatus, resume, finalStatus].every((item) => item.samePartsArray),
          noPassiveHooks: hooks.event === undefined && hooks["chat.message"] === undefined,
          lifecycleMessagesRead: lifecycleCalls.messages.length === 1,
          lifecycleAnalyzerCreated: lifecycleCalls.create.length === 1 && lifecycleCalls.create[0].body?.agent === "self-evolve-analyzer",
          lifecycleAnalyzerPrompted: lifecycleCalls.prompt.length === 1 && /Analyze this OpenCode session excerpt/.test(lifecycleCalls.prompt[0].body?.parts?.[0]?.text || ""),
          lifecycleCleanup: lifecycleCalls.abort.length === 1,
          lifecycleToast: lifecycleCalls.showToast.length === 1,
          lifecycleNoPromptAsync: lifecycleCalls.promptAsync.length === 0,
          lifecycleAcceptedOutput: /found proposal se-1/.test(lifecycle.text) && /Suggested action:/.test(lifecycle.text),
          lifecycleNoAnalyzerLeak: !analyzerLeakPattern.test(lifecycle.text),
        },
      };
      console.log(${JSON.stringify(SENTINEL)} + JSON.stringify(payload));
    },
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
    await createSession(baseUrl, projectDir);
    const payload = await withTimeout(smokePayload, "self-evolve live command hook smoke");
    assertSmokePayload(payload);
    report = {
      ok: true,
      smoke: "self-evolve-live-command-hook",
      opencode: health,
      evidence: payload.checks,
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
      report.cleanup.tempRootRemoved = true;
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
