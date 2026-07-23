import {
  applyControlCommand,
  beginAnalyzerRun,
  buildTranscript,
  completeAnalysis,
  createRegistry,
  isDurableLifecycleEvent,
  finishAnalysisFailure,
  finishAnalysisSuppressed,
  parseCommand,
  PRIVACY_DISCLOSURE,
  reserveAnalysis,
  resolveOptions,
  SELF_EVOLVE_ANALYZER_AGENT,
  SELF_EVOLVE_SOURCE,
} from "./self-evolve-core.js";
import {
  ANALYZER_SYSTEM_PROMPT,
  ANALYZER_TOOLS,
  buildAnalyzerPrompt,
} from "./analyzer-prompt.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  initialStateRootSelection,
  officialClientStateRoot,
  resolveStateRoot,
  stateRootIdentity,
} from "./self-evolve-state-root.js";
import { readTuiHostHealth } from "./self-evolve-bridge.js";

/**
 * @typedef {import("@opencode-ai/plugin").Plugin} OpenCodePlugin
 * @typedef {import("@opencode-ai/plugin").PluginInput} OpenCodePluginInput
 * @typedef {import("@opencode-ai/plugin").PluginOptions} OpenCodePluginOptions
 * @typedef {import("@opencode-ai/plugin").Hooks} OpenCodePluginHooks
 */

// Created exactly once at module load and NEVER reassigned. OpenCode calls
// every exported plugin factory and may instantiate SelfEvolvePlugin more
// than once per process (documented double-instantiation); reassigning this
// binding inside the factory would silently wipe all session state (pause,
// disable, pending proposal, rate-limit counters) on the second call. Instead,
// the factory calls `registry.setOptions(...)` to re-seed the configured
// options (so `/self-evolve status` shows the real caps) without discarding
// any existing registry entries. `currentPluginOptions` below is the
// factory-reassignable piece; option-resolution reads it at call time.
const registry = createRegistry();

// Durable late-start recovery is coordinated separately from the legacy
// session registry. OpenCode may keep hooks from more than one factory
// instance reachable, so a post-start command must not boot duplicate
// integrations for the same host/project/state-root tuple.
const lateDurableRecoveryRegistry = new Map();
const durableHostObjectIDs = new WeakMap();
let nextDurableHostObjectID = 1;

// Reassigned on every SelfEvolvePlugin(...) call so the most recently
// resolved options are always used by hook bodies and by
// `registry.setOptions()`. This is what "re-seeds options" means in
// practice: the shared module-level registry survives, only the options used
// for NEW session state (and the eviction cap) are refreshed.
let currentPluginOptions = resolveOptions();

function now(options) {
  return typeof options?.now === "function" ? options.now() : Date.now();
}

function durableHostIdentity(ctx) {
  try {
    return `origin:${new URL(officialGlobalHealthUrl(ctx?.serverUrl)).origin}`;
  } catch {
    const hostObject = ctx?.client && typeof ctx.client === "object" ? ctx.client : ctx;
    if (!hostObject || (typeof hostObject !== "object" && typeof hostObject !== "function")) return "host:unavailable";
    let id = durableHostObjectIDs.get(hostObject);
    if (!id) {
      id = nextDurableHostObjectID;
      nextDurableHostObjectID += 1;
      durableHostObjectIDs.set(hostObject, id);
    }
    return `object:${id}`;
  }
}

function durableOptionIdentity(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value !== "object" && typeof value !== "function") return `${typeof value}:${String(value)}`;
  let id = durableHostObjectIDs.get(value);
  if (!id) {
    id = nextDurableHostObjectID;
    nextDurableHostObjectID += 1;
    durableHostObjectIDs.set(value, id);
  }
  return `reference:${id}`;
}

function lateDurableRecoveryKey(ctx, options, selection) {
  return JSON.stringify({
    host: durableHostIdentity(ctx),
    directory: String(ctx?.directory ?? ""),
    worktree: String(options?.worktree ?? ctx?.worktree ?? ""),
    stateRoot: String(selection?.stateRoot ?? options?.stateRoot ?? ""),
    projectFingerprint: String(options?.projectFingerprint ?? ""),
    remoteUrl: String(options?.remoteUrl ?? ""),
    projectName: String(options?.projectName ?? ""),
    scopeFingerprint: String(options?.scopeFingerprint ?? ""),
    hostSupported: options?.hostSupported !== false,
    processExcluded: durableOptionIdentity(options?.processExcluded),
    repoOptOut: durableOptionIdentity(options?.repoOptOut),
    rolloutGates: durableOptionIdentity(options?.rolloutGates ?? options?.settings?.rolloutGates),
    pipeline: durableOptionIdentity(options?.pipeline),
    pipelineFactory: durableOptionIdentity(options?.pipelineFactory),
    clock: durableOptionIdentity(options?.now),
    faultInjection: durableOptionIdentity(options?.faultInjection),
  });
}

function textPart(text, options = {}) {
  return {
    type: "text",
    text,
    synthetic: options.synthetic ?? true,
    ignored: options.ignored ?? false,
    metadata: { source: SELF_EVOLVE_SOURCE, ...(options.metadata ?? {}) },
  };
}

function displayPart(input) {
  const args = (input.arguments ?? "").trim();
  return textPart(args ? `/${input.command} ${args}` : `/${input.command}`, {
    synthetic: false,
    ignored: true,
    metadata: { kind: "display" },
  });
}

function replaceParts(output, ...parts) {
  output.parts = output.parts ?? [];
  output.parts.splice(0, output.parts.length, ...parts);
}

function errorMessage(error, fallback = "unknown error") {
  const detail = error?.data?.message ?? error?.message ?? error?._tag ?? error?.name;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {}
  }
  return String(error || fallback);
}

function modelOption(model) {
  if (!model) return null;
  if (typeof model === "object" && !Array.isArray(model) && model.providerID && (model.modelID || model.id)) {
    return { providerID: String(model.providerID), modelID: String(model.modelID ?? model.id) };
  }
  if (typeof model !== "string") return null;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return null;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

async function callSessionMethod(ctx, methodName, sessionID, body) {
  const method = ctx?.client?.session?.[methodName];
  if (typeof method !== "function") throw new Error(`OpenCode session.${methodName} is unavailable.`);
  const attempts = [
    () => method.call(ctx.client.session, { path: { id: sessionID }, query: { directory: ctx.directory }, body }),
    () => method.call(ctx.client.session, { path: { sessionID }, query: { directory: ctx.directory }, body }),
    () => method.call(ctx.client.session, { sessionID, directory: ctx.directory, ...body }),
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (!result?.error) return result;
      lastError = result.error;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(errorMessage(lastError, `OpenCode session.${methodName} failed.`));
}

function analyzerPermissionNames() {
  return [...new Set(["*", ...Object.keys(ANALYZER_TOOLS), "external_directory"])];
}

function analyzerPermissionRules() {
  return analyzerPermissionNames().map((permission) => ({ permission, pattern: "*", action: "deny" }));
}

function analyzerPermissionConfig() {
  return Object.fromEntries(analyzerPermissionNames().map((permission) => [permission, "deny"]));
}

function omitKeys(value, keys) {
  const omit = new Set(keys);
  return Object.fromEntries(Object.entries(value || {}).filter(([key]) => !omit.has(key)));
}

async function callSessionCreate(ctx, body) {
  const method = ctx?.client?.session?.create;
  if (typeof method !== "function") throw new Error("OpenCode session.create is unavailable.");

  const bodies = [
    body,
    omitKeys(body, ["permission"]),
    omitKeys(body, ["permission", "parentID"]),
  ];
  const seen = new Set();
  let lastError;

  for (const candidate of bodies) {
    const key = JSON.stringify(candidate);
    if (seen.has(key)) continue;
    seen.add(key);

    const attempts = [
      () => method.call(ctx.client.session, { body: candidate, query: { directory: ctx.directory } }),
      () => method.call(ctx.client.session, { directory: ctx.directory, ...candidate }),
    ];

    for (const attempt of attempts) {
      try {
        const result = await attempt();
        if (!result?.error) return result;
        lastError = result.error;
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw new Error(errorMessage(lastError, "OpenCode session.create failed."));
}

function createdSessionID(result) {
  return result?.data?.id ?? result?.data?.sessionID ?? result?.data?.session?.id ?? result?.id ?? result?.sessionID ?? result?.session?.id;
}

async function callSessionCleanup(ctx, sessionID) {
  const session = ctx?.client?.session;
  const methodName = typeof session?.abort === "function" ? "abort" : typeof session?.interrupt === "function" ? "interrupt" : null;
  if (!methodName) throw new Error("OpenCode session cleanup is unavailable.");
  const method = session[methodName];
  const attempts = [
    () => method.call(session, { path: { id: sessionID }, query: { directory: ctx.directory } }),
    () => method.call(session, { path: { sessionID }, query: { directory: ctx.directory } }),
    () => method.call(session, { sessionID, directory: ctx.directory }),
    () => method.call(session, sessionID),
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (!result?.error) return result;
      lastError = result.error;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(errorMessage(lastError, `OpenCode session.${methodName} cleanup failed.`));
}

async function withTimeout(task, timeoutMs, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return await task();
  let timeoutID;
  const timeout = new Promise((_, reject) => {
    timeoutID = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
  });
  try {
    return await Promise.race([task(), timeout]);
  } finally {
    clearTimeout(timeoutID);
  }
}

const DEFAULT_HOST_HEALTH_TIMEOUT_MS = 2_000;
const DEFAULT_HOST_HEALTH_RETRY_WINDOW_MS = 5_000;
const DEFAULT_HOST_HEALTH_RETRY_DELAY_MS = 100;
const MAX_HOST_HEALTH_RETRY_DELAY_MS = 1_000;

function hostCompatibility(hostVersion, supported, reason, diagnostic) {
  return Object.freeze({ hostVersion, supported, reason, ...(diagnostic ? { diagnostic } : {}) });
}

function officialGlobalHealthUrl(serverUrl) {
  if (!(serverUrl instanceof URL) && (typeof serverUrl !== "string" || !serverUrl.trim())) throw new Error("host-health-server-url-unavailable");
  const parsed = new URL(serverUrl instanceof URL ? serverUrl.href : serverUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("host-health-server-url-invalid");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("host-health-server-url-invalid");
  if (!parsed.origin || parsed.origin === "null" || !["", "/"].includes(parsed.pathname)) throw new Error("host-health-server-url-invalid");
  return new URL("/global/health", parsed.origin).href;
}

async function abortableTask(task, signal) {
  if (!signal) return await task();
  if (signal.aborted) throw new Error("host-health-aborted");
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new Error("host-health-aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([task(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function boundedHostHealthDuration(value, fallback, maximum) {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(0, value)) : fallback;
}

function waitForHostHealthRetry(delayMs, signal) {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("host-health-aborted"));
      return;
    }
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new Error("host-health-aborted")));
    const timer = setTimeout(() => finish(resolve), delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function hostHealthErrorDiagnostic(error) {
  const code = error?.cause?.code ?? error?.code;
  if (typeof code === "string") {
    const knownCodes = new Map([
      ["ABORT_ERR", "aborted"],
      ["EAI_AGAIN", "dns-temporary"],
      ["ECONNREFUSED", "connection-refused"],
      ["ECONNRESET", "connection-reset"],
      ["EHOSTUNREACH", "host-unreachable"],
      ["ENETUNREACH", "network-unreachable"],
      ["ENOTFOUND", "dns-not-found"],
      ["ETIMEDOUT", "timeout"],
      ["UND_ERR_CONNECT_TIMEOUT", "connect-timeout"],
      ["UND_ERR_SOCKET", "socket-error"],
    ]);
    if (knownCodes.has(code.toUpperCase())) return knownCodes.get(code.toUpperCase());
    return "error";
  }
  const message = String(error?.message ?? error ?? "");
  const httpStatus = /^host-health-http-(error|[1-5][0-9]{2})$/u.exec(message)?.[1];
  if (httpStatus) return `http-${httpStatus}`;
  for (const [pattern, label] of [
    [/host-health-server-url-unavailable/u, "server-url-unavailable"],
    [/host-health-server-url-invalid/u, "server-url-invalid"],
    [/host-health-fetch-unavailable/u, "fetch-unavailable"],
    [/connection refused|econnrefused/iu, "connection-refused"],
    [/fetch failed/iu, "fetch-failed"],
    [/aborted|aborterror/iu, "aborted"],
  ]) {
    if (pattern.test(message)) return label;
  }
  const knownNames = new Map([
    ["AbortError", "aborted"],
    ["Error", "error"],
    ["FetchError", "fetch-error"],
    ["TimeoutError", "timeout"],
    ["TypeError", "type-error"],
  ]);
  return knownNames.get(String(error?.name ?? "")) ?? "error";
}

function sdkHealthTransportFailure(error, responseStatus) {
  const status = Number(responseStatus ?? error?.status ?? error?.statusCode ?? error?.data?.status ?? error?.response?.status);
  if (Number.isInteger(status)) {
    return [404, 405].includes(status);
  }
  const code = String(error?.cause?.code ?? error?.code ?? "").toUpperCase();
  if (new Set([
    "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH",
    "ENOTFOUND", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
  ]).has(code)) return true;
  const message = String(error?.message ?? error ?? "");
  return /\b(connection refused|econnrefused|fetch failed|network (?:error|unavailable)|transport unavailable|sdk unavailable|not listening)\b/iu.test(message);
}

function compatibilityFromObservedVersion(value, options = {}, diagnostic) {
  const observedVersion = typeof value === "string" && value.trim() ? value.trim() : "unknown";
  if (observedVersion === "unknown" || observedVersion.length > 64) return { compatibility: hostCompatibility(observedVersion, false, "host-version-malformed", diagnostic), retryable: false };
  if (/^[0-9]+\.[0-9]+\.[0-9]+-/u.test(observedVersion)) {
    return { compatibility: hostCompatibility(observedVersion, false, "host-version-prerelease-unsupported", diagnostic), retryable: false };
  }
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(observedVersion);
  if (!match) return { compatibility: hostCompatibility(observedVersion, false, "host-version-malformed", diagnostic), retryable: false };
  const [, majorText, minorText, patchText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  if (![major, minor, patch].every(Number.isSafeInteger)) return { compatibility: hostCompatibility(observedVersion, false, "host-version-malformed", diagnostic), retryable: false };
  const inDeclaredRange = major === 1 && (minor > 18 || (minor === 18 && patch >= 3));
  if (!inDeclaredRange) return { compatibility: hostCompatibility(observedVersion, false, "host-version-unsupported", diagnostic), retryable: false };
  if (options.hostSupported === false) return { compatibility: hostCompatibility(observedVersion, false, "host-support-disabled-by-option", diagnostic), retryable: false };
  return { compatibility: hostCompatibility(observedVersion, true, "host-compatible", diagnostic), retryable: false };
}

async function resolveRunningHostCompatibilityAttempt(ctx, options = {}) {
  const health = ctx?.client?.global?.health;
  let result;
  let fetchController;
  let onStartupAbort;
  let attemptActive = true;
  try {
    result = await withTimeout(() => abortableTask(async () => {
      const fetchOfficialHealth = async () => {
        const healthUrl = officialGlobalHealthUrl(ctx?.serverUrl);
        const fetchImplementation = ctx?.__testOnlySelfEvolveFetch ?? globalThis.fetch;
        if (typeof fetchImplementation !== "function") throw new Error("host-health-fetch-unavailable");
        fetchController = new AbortController();
        if (options.__startupSignal?.aborted) fetchController.abort();
        else if (options.__startupSignal) {
          onStartupAbort = () => fetchController.abort();
          options.__startupSignal.addEventListener("abort", onStartupAbort, { once: true });
        }
        const response = await fetchImplementation(healthUrl, { method: "GET", redirect: "manual", headers: { accept: "application/json" }, signal: fetchController.signal });
        if (!response?.ok) {
          const status = response?.status;
          const error = new Error(`host-health-http-${status ?? "error"}`);
          if (Number.isInteger(status) && ![404, 405].includes(status)) {
            error.selfEvolveAuthoritativeHealthFailure = true;
          }
          throw error;
        }
        try {
          return { data: await response.json() };
        } catch (cause) {
          const error = new Error("host-health-response-malformed");
          error.cause = cause;
          error.selfEvolveAuthoritativeHealthFailure = true;
          throw error;
        }
      };
      if (typeof health !== "function") return await fetchOfficialHealth();
      let sdkError;
      let sdkResponseStatus;
      try {
        const sdkResult = await health.call(ctx.client.global);
        if (!sdkResult?.error) return sdkResult;
        sdkError = sdkResult.error;
        sdkResponseStatus = sdkResult?.response?.status;
      } catch (error) {
        sdkError = error;
      }
      if (!sdkHealthTransportFailure(sdkError, sdkResponseStatus)) {
        const error = new Error("host-health-sdk-authoritative-error");
        error.cause = sdkError;
        error.selfEvolveAuthoritativeHealthFailure = true;
        throw error;
      }
      if (!attemptActive || options.__startupSignal?.aborted) throw new Error("host-health-attempt-inactive");
      try {
        return await fetchOfficialHealth();
      } catch (fallbackError) {
        const error = new Error(`host-health-sdk-${hostHealthErrorDiagnostic(sdkError)}-fallback-${hostHealthErrorDiagnostic(fallbackError)}`);
        error.selfEvolveAuthoritativeHealthFailure = fallbackError?.selfEvolveAuthoritativeHealthFailure === true;
        throw error;
      }
    }, options.__startupSignal), options.__testHostHealthTimeoutMs ?? DEFAULT_HOST_HEALTH_TIMEOUT_MS, "OpenCode global health");
  } catch (error) {
    attemptActive = false;
    fetchController?.abort();
    const message = String(error?.message ?? error);
    const reason = error?.selfEvolveAuthoritativeHealthFailure === true
      ? "host-health-authoritative-error"
      : message.startsWith("OpenCode global health timed out")
      ? "host-health-timeout"
      : "host-health-unavailable";
    const diagnostic = message.startsWith("host-health-sdk-")
      ? message.slice("host-health-".length, "host-health-".length + 160)
      : `${fetchController ? "fallback" : "sdk"}-${hostHealthErrorDiagnostic(error)}`;
    const retryable = (reason === "host-health-unavailable" || (reason === "host-health-timeout" && fetchController !== undefined))
      && !options.__startupSignal?.aborted
      && ![
        "host-health-aborted",
        "host-health-fetch-unavailable",
        "host-health-server-url-invalid",
        "host-health-server-url-unavailable",
      ].some((marker) => message.includes(marker));
    return { compatibility: hostCompatibility("unknown", false, reason, diagnostic), retryable };
  } finally {
    attemptActive = false;
    if (onStartupAbort) options.__startupSignal?.removeEventListener("abort", onStartupAbort);
  }
  if (result?.error) return { compatibility: hostCompatibility("unknown", false, "host-health-authoritative-error", `sdk-${hostHealthErrorDiagnostic(result.error)}`), retryable: false };
  const data = result?.data;
  const observedVersion = typeof data?.version === "string" && data.version.trim() ? data.version.trim() : "unknown";
  if (data?.healthy === false) return { compatibility: hostCompatibility(observedVersion, false, "host-health-unhealthy"), retryable: false };
  if (data?.healthy !== true) return { compatibility: hostCompatibility(observedVersion, false, "host-health-malformed"), retryable: false };
  return compatibilityFromObservedVersion(observedVersion, options);
}

async function resolveRunningHostCompatibility(ctx, options = {}) {
  const retryWindowMs = boundedHostHealthDuration(
    options.__testHostHealthRetryWindowMs,
    DEFAULT_HOST_HEALTH_RETRY_WINDOW_MS,
    DEFAULT_HOST_HEALTH_RETRY_WINDOW_MS,
  );
  const initialRetryDelayMs = boundedHostHealthDuration(
    options.__testHostHealthRetryDelayMs,
    DEFAULT_HOST_HEALTH_RETRY_DELAY_MS,
    MAX_HOST_HEALTH_RETRY_DELAY_MS,
  );
  const attemptTimeoutMs = boundedHostHealthDuration(
    options.__testHostHealthTimeoutMs,
    DEFAULT_HOST_HEALTH_TIMEOUT_MS,
    30_000,
  );
  const startedAt = Date.now();
  let retryDelayMs = initialRetryDelayMs;
  let latest = hostCompatibility("unknown", false, "host-health-unavailable");
  let attempts = 0;

  while (true) {
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = Math.max(0, retryWindowMs - elapsedMs);
    if (attempts > 0 && remainingMs <= 0) return latest;
    attempts += 1;
    const currentTimeoutMs = retryWindowMs === 0
      ? attemptTimeoutMs
      : Math.max(1, Math.min(attemptTimeoutMs, remainingMs));
    const attempt = await resolveRunningHostCompatibilityAttempt(ctx, {
      ...options,
      __testHostHealthTimeoutMs: currentTimeoutMs,
    });
    latest = attempt.compatibility;
    if (!attempt.retryable || retryWindowMs === 0 || options.__startupSignal?.aborted) return latest;

    const afterAttemptRemainingMs = retryWindowMs - (Date.now() - startedAt);
    if (afterAttemptRemainingMs <= 0) return latest;
    const waitMs = Math.min(retryDelayMs, afterAttemptRemainingMs);
    try {
      await waitForHostHealthRetry(waitMs, options.__startupSignal);
    } catch {
      return hostCompatibility("unknown", false, "host-health-unavailable");
    }
    retryDelayMs = Math.min(MAX_HOST_HEALTH_RETRY_DELAY_MS, Math.max(1, retryDelayMs * 2));
  }
}

function unsupportedHostCommandText(command, compatibility) {
  const diagnostic = compatibility.diagnostic ? `; diagnostic ${compatibility.diagnostic}` : "";
  const detail = `host ${compatibility.hostVersion}; compatibility ${compatibility.reason}${diagnostic}`;
  if (["default", "status"].includes(command.verb)) {
    return `Self-evolve status: effective mode manual; autonomous authority disabled; ${detail}.`;
  }
  if (command.verb === "health") {
    return `Self-evolve health: ${detail}; effective mode manual; autonomous authority disabled.`;
  }
  if (command.verb === "mode" && command.mode === "manual") {
    return `Self-evolve remains in effective mode manual because autonomous authority is disabled; ${detail}. No files were changed.`;
  }
  return `Self-evolve autonomous authority unavailable (${compatibility.reason}); host ${compatibility.hostVersion}${diagnostic}; effective mode manual. No mode change, self-evolve analyzer call, or file write was attempted.`;
}

function inputSessionID(input) {
  return input?.sessionID ?? input?.sessionId ?? input?.session?.id;
}

function resultData(result) {
  if (!result || result.error) return [];
  if (Array.isArray(result.data)) return result.data;
  if (Array.isArray(result.data?.messages)) return result.data.messages;
  if (Array.isArray(result.messages)) return result.messages;
  return [];
}

async function readRecentMessages(ctx, sessionID, limit) {
  const attempts = [
    () => ctx.client.session.messages({
      path: { id: sessionID },
      query: { directory: ctx.directory, limit },
    }),
    () => ctx.client.session.messages({
      path: { sessionID },
      query: { directory: ctx.directory, limit },
    }),
    () => ctx.client.session.messages({ sessionID, directory: ctx.directory, limit }),
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (!result?.error) return { ok: true, messages: resultData(result) };
      lastError = result.error;
    } catch (error) {
      lastError = error;
    }
  }
  return { ok: false, error: lastError };
}

function responseText(result) {
  const candidates = [
    result?.data?.parts,
    result?.data?.message?.parts,
    result?.message?.parts,
    result?.parts,
  ];
  for (const parts of candidates) {
    if (Array.isArray(parts)) {
      const text = parts.map((part) => part?.text || part?.content || "").filter(Boolean).join("\n");
      if (text.trim()) return text;
    }
  }
  return String(result?.data?.text ?? result?.text ?? result?.message?.text ?? "");
}

function analyzerOutput(result) {
  const structured = result?.data?.info?.structured_output ?? result?.data?.structured_output ?? result?.info?.structured_output ?? result?.structured_output ??
    result?.data?.info?.structured ?? result?.data?.structured ?? result?.info?.structured ?? result?.structured;
  if (structured !== undefined) return structured;
  return responseText(result);
}

async function runHiddenAnalyzer(ctx, sessionID, transcript, trigger, configuredModel, options) {
  const prompt = buildAnalyzerPrompt({ transcript, trigger, directory: ctx.directory });
  const model = modelOption(configuredModel);
  let analyzerSessionID;
  const createBody = {
    parentID: sessionID,
    title: "Self-evolve analyzer",
    agent: SELF_EVOLVE_ANALYZER_AGENT,
    ...(model ? { model } : {}),
    permission: analyzerPermissionRules(),
  };
  const body = {
    agent: SELF_EVOLVE_ANALYZER_AGENT,
    ...(model ? { model } : {}),
    tools: { ...ANALYZER_TOOLS },
    system: ANALYZER_SYSTEM_PROMPT,
    parts: [textPart(prompt, { metadata: { kind: "analysis" } })],
  };
  try {
    // withTimeout()/Promise.race cannot cancel the underlying session.create. If the
    // SDK call is merely slow and resolves AFTER sdkTimeoutMs, a session has still been
    // created server-side but analyzerSessionID stays undefined, so the finally block's
    // cleanup never fires and the session is orphaned. Attach a late-resolution handler
    // that cleans up such an orphan. The timedOut guard ensures we only clean up on the
    // late path — in the fast (in-time) path this handler runs first as a microtask with
    // timedOut still false and returns, leaving cleanup to the normal flow / finally block
    // so we never abort the live session we are about to use.
    let timedOut = false;
    const createPromise = callSessionCreate(ctx, createBody);
    createPromise.then(
      (r) => {
        if (!timedOut) return;
        const lateID = createdSessionID(r);
        if (lateID) callSessionCleanup(ctx, lateID).catch(() => {});
      },
      () => {},
    );
    let created;
    try {
      created = await withTimeout(
        () => createPromise,
        options.sdkTimeoutMs,
        "Self-evolve session.create",
      );
    } catch (error) {
      timedOut = true;
      throw error;
    }
    analyzerSessionID = createdSessionID(created);
    if (!analyzerSessionID) throw new Error("OpenCode did not return a self-evolve analyzer session ID.");
    const result = await withTimeout(
      () => callSessionMethod(ctx, "prompt", analyzerSessionID, body),
      options.analyzerTimeoutMs,
      "Self-evolve analyzer",
    );
    return analyzerOutput(result);
  } finally {
    if (analyzerSessionID) {
      try {
        await withTimeout(
          () => callSessionCleanup(ctx, analyzerSessionID),
          options.cleanupTimeoutMs,
          "Self-evolve analyzer cleanup",
        );
      } catch {}
    }
  }
}

function proposalNotification(proposal) {
  const target = proposal.target.path || proposal.target.surface;
  return [
    `Self-evolve found a possible improvement: ${proposal.title}`,
    "",
    proposal.summary,
    "",
    "Advisory only: no changes will be made unless you explicitly ask.",
    "Options:",
    "- Implement now: ask an agent to make this change.",
    "- Save follow-up: ask to record it as backlog work for later.",
    `- Ignore it: run /self-evolve dismiss ${proposal.id}.`,
    "- Disable self-evolve for this session: run /self-evolve disable.",
    "",
    `Proposal ID: ${proposal.id}`,
    `Placement: ${proposal.placement}`,
    `Target: ${target}${proposal.target.symbol ? ` (${proposal.target.symbol})` : ""}`,
    `Risk: ${proposal.risk}. Mitigation: ${proposal.riskMitigation}`,
    `Confidence: ${proposal.confidence.toFixed(2)}`,
    "Evidence:",
    ...proposal.evidence.map((item) => `- ${item}`),
    "",
    `Suggested action: ${proposal.suggestedAction}`,
  ].join("\n");
}

const TOAST_DURATION_MS = 8000;

async function showProposalToast(ctx, proposal, options = {}) {
  const opts = resolveOptions(options);
  try {
    if (typeof ctx?.client?.tui?.showToast !== "function") return;
    await withTimeout(
      () => ctx.client.tui.showToast({
        body: {
          variant: "info",
          title: `Self-evolve: ${proposal.title}`,
          message: `${proposal.summary}\n\nConfidence: ${proposal.confidence.toFixed(2)} | Risk: ${proposal.risk}\nTarget: ${proposal.target.path || proposal.target.surface}`,
          duration: TOAST_DURATION_MS,
        },
      }),
      opts.deliveryTimeoutMs,
      "Self-evolve proposal toast",
    );
  } catch {}
}

function humanizeScanReason(reason) {
  const key = String(reason || "").trim();
  const copy = {
    "already-analyzing": "a scan is already running for this session",
    disabled: "self-evolve is disabled for this session",
    paused: "manual scans are paused for this session",
    "proposal-pending": "a proposal is already pending; dismiss or handle it before scanning again",
    "run-cap": "this session has reached its analyzer run limit",
    "proposal-cap": "this session has reached its proposal limit",
    "failure-cap": "self-evolve stopped after repeated analyzer failures",
  };
  if (copy[key]) return copy[key];
  return key.replace(/[.!?]+$/, "") || "no actionable proposal was found";
}

function scanText(result) {
  const noFiles = "No files were changed.";
  if (result?.accepted) {
    return [
      `Manual self-evolve scan found proposal ${result.proposal.id}: ${result.proposal.title}`,
      noFiles,
      "",
      proposalNotification(result.proposal),
    ].join("\n");
  }
  const reason = humanizeScanReason(result?.reason);
  if (result?.blocked) return `Manual self-evolve scan skipped: ${reason}. ${noFiles}`;
  return `Manual self-evolve scan completed without a proposal: ${reason}. ${noFiles}`;
}

async function runAnalysis(ctx, sessionID, trigger, pluginOptions, configuredModel) {
  const options = resolveOptions(pluginOptions);
  const state = registry.getOrCreate(sessionID, now(options));
  const reserve = reserveAnalysis(state, trigger, now(options), options);
  if (!reserve.allowed) return { accepted: false, blocked: true, reason: reserve.reason };
  let analyzedMessageCount = state.lastSeenMessageCount;

  try {
    const messagesResult = await withTimeout(
      () => readRecentMessages(ctx, sessionID, options.messageLimit),
      options.sdkTimeoutMs,
      "Self-evolve message read",
    );
    if (!messagesResult.ok) {
      if (state.currentAnalysisToken !== reserve.token || state.disabled || state.paused) {
        return finishAnalysisSuppressed(state, "Analysis failure ignored because self-evolve state changed while reading messages.", now(options), options, state.lastSeenMessageCount, false, reserve.token);
      }
      return finishAnalysisFailure(state, "Could not read recent session messages for self-evolve analysis.", now(options), options, state.lastSeenMessageCount, reserve.token);
    }

    const transcript = buildTranscript(messagesResult.messages, options);
    analyzedMessageCount = transcript.messageCount;
    // A concurrent /self-evolve disable or pause may have landed while we awaited
    // readRecentMessages. Bail before beginAnalyzerRun so a cancelled session does
    // not consume an analyzerRuns slot and a full LLM round-trip. (Forced
    // suppression: preserves analyzerFailures.)
    if (state.currentAnalysisToken !== reserve.token || state.disabled || state.paused) {
      return finishAnalysisSuppressed(state, "Analysis cancelled: self-evolve state changed after reading messages.", now(options), options, transcript.messageCount, false, reserve.token);
    }
    const gate = beginAnalyzerRun(state, transcript.messageCount, now(options));
    if (!gate.allowed) return { accepted: false, blocked: true, reason: gate.reason };

    const raw = await runHiddenAnalyzer(ctx, sessionID, transcript, trigger, configuredModel, options);
    if (state.currentAnalysisToken !== reserve.token || state.disabled || state.paused) {
      return finishAnalysisSuppressed(state, "Analysis result ignored because self-evolve state changed before completion.", now(options), options, transcript.messageCount, false, reserve.token);
    }

    const completed = completeAnalysis(state, raw, {
      now: now(options),
      options,
      messageCount: transcript.messageCount,
      targetRoot: ctx.directory,
      token: reserve.token,
    });
    if (completed.accepted) {
      await showProposalToast(ctx, completed.proposal, options);
    }
    return completed;
  } catch (error) {
    if (state.currentAnalysisToken !== reserve.token || state.disabled || state.paused) {
      return finishAnalysisSuppressed(state, "Analysis failure ignored because self-evolve state changed before completion.", now(options), options, analyzedMessageCount, false, reserve.token);
    }
    return finishAnalysisFailure(state, errorMessage(error), now(options), options, analyzedMessageCount, reserve.token);
  }
}

async function handleCommand(ctx, input, output, pluginOptions, configuredModel) {
  const sessionID = inputSessionID(input);
  if (!sessionID) {
    replaceParts(output, displayPart(input), textPart("Self-evolve command skipped: no session ID was provided."));
    return;
  }
  const state = registry.getOrCreate(sessionID, now(pluginOptions));
  const command = parseCommand(input.arguments ?? "");

  if (command.verb === "scan") {
    replaceParts(output, displayPart(input), textPart(`Running one manual self-evolve scan for this session.\n${PRIVACY_DISCLOSURE}`));
    const result = await runAnalysis(ctx, sessionID, { kind: "manual", reason: "manual-scan" }, pluginOptions, configuredModel);
    replaceParts(output, displayPart(input), textPart(scanText(result)));
    return;
  }

  const applied = applyControlCommand(state, command, now(pluginOptions), resolveOptions(pluginOptions));
  replaceParts(output, displayPart(input), textPart(applied.text));
}

async function provisionalStartupMode(stateRoot, identity, options = {}, compatibility = hostCompatibility("unknown", false, "host-health-unavailable")) {
  if (!stateRoot) return "manual";
  try {
    const schemas = await import("./self-evolve-schemas.js");
    const global = schemas.makeGlobalSettings(JSON.parse(readFileSync(path.join(stateRoot, "self-evolve", "global", "settings.json"), "utf8")));
    const repo = schemas.makeRepoSettings(JSON.parse(readFileSync(path.join(stateRoot, "self-evolve", identity.projectFingerprint, "settings.json"), "utf8")));
    return schemas.resolveMode(global.mode, repo.mode, {
      killSwitchActive: process.env.SELF_EVOLVE_KILL === "1" || process.env.SELF_EVOLVE_KILL === "true" || global.killSwitchActive,
      paused: global.paused,
      processExcluded: options.processExcluded === true || repo.projectFingerprint !== identity.projectFingerprint,
      repoOptOut: repo.excluded || options.repoOptOut === true,
      hostSupported: compatibility.supported,
    });
  } catch {
    return "manual";
  }
}

async function validateOfficialRootAfterStartup(ctx, provisionalRoot, options = {}) {
  const retries = Math.min(3, Math.max(0, options.stateRootValidationRetries ?? 2));
  const timeoutMs = options.stateRootTimeoutMs ?? 250;
  const backoffMs = Math.min(1_000, Math.max(1, options.stateRootValidationBackoffMs ?? 50));
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const officialRoot = await officialClientStateRoot(ctx, { timeoutMs });
      if (provisionalRoot && provisionalRoot !== officialRoot) throw new Error("state-root-validation-mismatch");
      return officialRoot;
    } catch (error) {
      lastError = error;
      if (String(error?.message ?? error).startsWith("state-root-validation-mismatch") || attempt >= retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, backoffMs * (2 ** attempt)));
    }
  }
  throw lastError ?? new Error("state-root-validation-failed");
}

async function createDurablePipeline(ctx, options, selectedStateRoot, compatibility) {
  const storeModule = await import("./self-evolve-store.js");
  const identity = storeModule.resolveProjectIdentity({
    projectFingerprint: options.projectFingerprint,
    remoteUrl: options.remoteUrl,
    worktreePath: options.worktree ?? ctx?.worktree,
    directory: ctx?.directory,
  });
  if (options.pipeline) return { integration: options.pipeline, identity };
  if (typeof options.pipelineFactory === "function") return { integration: await options.pipelineFactory({ ctx, options, identity }), identity };
  const stateRoot = selectedStateRoot ?? await resolveStateRoot(ctx, options);
  if (!stateRoot) return null;
  const [pipelineModule, inventoryModule, privacyModule, synthesisModule, applierModule, commandsModule, schemasModule, observationModule, schedulerModule, integrationModule] = await Promise.all([
    import("./self-evolve-pipeline.js"),
    import("./self-evolve-inventory.js"),
    import("./self-evolve-privacy.js"),
    import("./self-evolve-synthesis.js"),
    import("./self-evolve-applier.js"),
    import("./self-evolve-commands.js"),
    import("./self-evolve-schemas.js"),
    import("./self-evolve-observation.js"),
    import("./self-evolve-scheduler.js"),
    import("./self-evolve-integration.js"),
  ]);
  let durableStore;
  try {
    const projectFingerprint = identity.projectFingerprint;
    durableStore = storeModule.openStore(stateRoot, { projectFingerprint, projectName: options.projectName, now: options.now });
    const settings = durableStore.getSettings();
    const privacy = privacyModule.createPrivacyGuard({ consent: settings.global.consent, projectFingerprint, retentionDays: settings.global.retentionDays, storageQuotaMiB: settings.global.budgets.storageQuotaMiB, store: durableStore, now: options.now });
    const roots = inventoryModule.loadAllowlist({ globalSkillRoots: settings.global.allowedSkillRoots }).canonicalRoots;
    const records = inventoryModule.discoverSkills(roots);
    const applier = applierModule.createApplier({ store: durableStore, inventory: { records, canonicalRoots: roots }, privacy, now: options.now });
    const integration = integrationModule.createIntegration({ store: durableStore, inventory: inventoryModule, privacy, synthesisModule, applier, commands: commandsModule, pipeline: pipelineModule, scheduler: schedulerModule, schemas: schemasModule, observation: observationModule, options: { ...options, hostVersion: compatibility?.hostVersion ?? "unknown", hostVersionSource: compatibility?.diagnostic === "tui-app-version" ? "tui-app-version" : "global-health", hostSupported: compatibility?.supported === true, stateRoot, projectFingerprint, ctx }, now: options.now });
    return { integration, identity };
  } catch (error) {
    try { durableStore?.close(); } catch {}
    throw error;
  }
}

/**
 * @param {OpenCodePluginInput} ctx
 * @param {OpenCodePluginOptions} [options]
 * @returns {Promise<OpenCodePluginHooks>}
 */
async function SelfEvolvePlugin(ctx, options = {}) {
  // Re-seed the shared module-level `currentPluginOptions` and the shared
  // module-level `registry`'s options. This must NEVER reassign `registry`
  // itself (see the module-level comment above) — `setOptions()` updates the
  // options used for new session state and the eviction cap in place, so any
  // existing per-session state (pause/disable, pending proposal, rate-limit
  // counters) survives a second SelfEvolvePlugin(...) call.
  currentPluginOptions = resolveOptions(options);
  registry.setOptions(currentPluginOptions);
  const instancePluginOptions = currentPluginOptions;
  let configuredModel = null;
  const durableEnabled = currentPluginOptions.durableAutonomy !== false;
  let durableRuntimePromise = null;
  let settledRuntime = null;
  let hostRecoveryTimer = null;
  let resolveDeferredRuntime;
  let startupValidationPending = false;
  let startupTask;
  let lateRecoveryPromise = null;
  const durableInstanceToken = {};
  let lateRecoveryCoordination = null;
  let usesSharedLateRuntime = false;
  let disposed = false;
  let durableUnavailableReason;
  let runningHostCompatibility = hostCompatibility("unknown", false, "host-health-unavailable");
  let initialSelection;
  let initialIdentity;
  let startupMode = "manual";
  if (durableEnabled) {
    initialSelection = initialStateRootSelection({
      explicitStateRoot: instancePluginOptions.stateRoot,
      hostStateRoot: ctx?.path?.state,
      environment: instancePluginOptions.env ?? process.env,
      hasOfficialPathApi: typeof ctx?.client?.path?.get === "function",
    });
    if (initialSelection?.stateRoot) {
      const storeModule = await import("./self-evolve-store.js");
      initialIdentity = storeModule.resolveProjectIdentity({
        projectFingerprint: instancePluginOptions.projectFingerprint,
        remoteUrl: instancePluginOptions.remoteUrl,
        worktreePath: instancePluginOptions.worktree ?? ctx?.worktree,
        directory: ctx?.directory,
      });
      const provisionalCompatibility = hostCompatibility("unknown", instancePluginOptions.hostSupported !== false, "startup-validation-pending");
      startupMode = await provisionalStartupMode(initialSelection.stateRoot, initialIdentity, instancePluginOptions, provisionalCompatibility);
    }
    startupValidationPending = true;
    durableRuntimePromise = new Promise((resolve) => { resolveDeferredRuntime = resolve; });
    const coordinationKey = lateDurableRecoveryKey(ctx, instancePluginOptions, initialSelection);
    lateRecoveryCoordination = lateDurableRecoveryRegistry.get(coordinationKey);
    if (lateRecoveryCoordination?.closingPromise) {
      try { await lateRecoveryCoordination.closingPromise; } catch {}
      lateRecoveryCoordination = lateDurableRecoveryRegistry.get(coordinationKey);
    }
    if (!lateRecoveryCoordination) {
      lateRecoveryCoordination = {
        key: coordinationKey,
        users: new Set(),
        controller: new AbortController(),
        recoveryPromise: null,
        closingPromise: null,
        runtime: null,
        compatibility: null,
        unavailableReason: undefined,
        commandDispatches: new WeakMap(),
        eventDispatches: new WeakMap(),
        lateRecoveryAttempted: false,
      };
      lateDurableRecoveryRegistry.set(coordinationKey, lateRecoveryCoordination);
    }
    lateRecoveryCoordination.users.add(durableInstanceToken);
  }

  const buildValidatedDurableRuntime = async () => {
    let runtime;
    const sharedSignal = lateRecoveryCoordination?.controller?.signal;
    const sharedRecoveryCancelled = () => sharedSignal?.aborted || !lateRecoveryCoordination || lateRecoveryCoordination.users.size === 0;
    try {
      runningHostCompatibility = await resolveRunningHostCompatibility(ctx, { ...instancePluginOptions, __startupSignal: sharedSignal });
      if (sharedRecoveryCancelled()) return null;
      if (
        runningHostCompatibility.reason === "host-health-unavailable"
        && initialSelection?.stateRoot
        && initialIdentity?.projectFingerprint
      ) {
        try {
          const tuiHealth = readTuiHostHealth(initialSelection.stateRoot, initialIdentity.projectFingerprint, {
            now: Date.now(),
            stateRootIdentity: stateRootIdentity(initialSelection.stateRoot),
          });
          if (tuiHealth) runningHostCompatibility = compatibilityFromObservedVersion(tuiHealth.hostVersion, instancePluginOptions, "tui-app-version").compatibility;
          else runningHostCompatibility = hostCompatibility("unknown", false, "host-health-unavailable", `${runningHostCompatibility.diagnostic ?? "global-unavailable"}-tui-unavailable`.slice(0, 160));
        } catch (error) {
          runningHostCompatibility = hostCompatibility("unknown", false, "host-health-unavailable", `${runningHostCompatibility.diagnostic ?? "global-unavailable"}-tui-${hostHealthErrorDiagnostic(error)}`.slice(0, 160));
        }
      }
      if (!runningHostCompatibility.supported) {
        durableUnavailableReason = runningHostCompatibility.reason;
        return null;
      }
      const selectedRoot = initialSelection?.provisional
        ? await validateOfficialRootAfterStartup(ctx, initialSelection.stateRoot, instancePluginOptions)
        : initialSelection?.stateRoot ?? await resolveStateRoot(ctx, instancePluginOptions);
      if (sharedRecoveryCancelled()) return null;
      runtime = await createDurablePipeline(ctx, instancePluginOptions, selectedRoot, runningHostCompatibility);
      if (!runtime?.integration) throw new Error("durable-initialization-failed");
      if (typeof runtime.integration.boot === "function") {
        const boot = await runtime.integration.boot({ ctx, hostVersion: runningHostCompatibility.hostVersion, hostVersionSource: runningHostCompatibility.diagnostic === "tui-app-version" ? "tui-app-version" : "global-health", recoverHostSessions: false });
        if (boot?.ok !== true) throw new Error(boot?.health?.lastError ?? "durable-boot-failed");
      }
      if (sharedRecoveryCancelled()) {
        try { await (runtime.integration.shutdown?.() ?? runtime.integration.close?.()); } catch {}
        return null;
      }
      durableUnavailableReason = undefined;
      return runtime;
    } catch (error) {
      try { await (runtime?.integration?.shutdown?.() ?? runtime?.integration?.close?.()); } catch {}
      durableUnavailableReason = String(error?.message ?? error ?? "startup-validation-failed").split(":", 1)[0];
      return null;
    }
  };

  const acquireCoordinatedDurableRuntime = async () => {
    if (disposed || !durableEnabled || !durableRuntimePromise || !lateRecoveryCoordination) {
      return { runtime: null, compatibility: runningHostCompatibility, unavailableReason: durableUnavailableReason };
    }
    if (lateRecoveryCoordination.runtime) {
      return {
        runtime: lateRecoveryCoordination.runtime,
        compatibility: lateRecoveryCoordination.compatibility,
        unavailableReason: lateRecoveryCoordination.unavailableReason,
      };
    }
    let sharedRecovery = lateRecoveryCoordination.recoveryPromise;
    if (!sharedRecovery) {
      sharedRecovery = (async () => {
        const runtime = await buildValidatedDurableRuntime();
        const sharedOutcome = {
          runtime,
          compatibility: runningHostCompatibility,
          unavailableReason: durableUnavailableReason,
        };
        lateRecoveryCoordination.runtime = runtime;
        lateRecoveryCoordination.compatibility = runningHostCompatibility;
        lateRecoveryCoordination.unavailableReason = durableUnavailableReason;
        if (runtime) void Promise.resolve(runtime.integration?.recoverHostSessions?.()).catch(() => {});
        return sharedOutcome;
      })();
      lateRecoveryCoordination.recoveryPromise = sharedRecovery;
      void sharedRecovery.finally(() => {
        if (lateRecoveryCoordination?.recoveryPromise === sharedRecovery) lateRecoveryCoordination.recoveryPromise = null;
      }).catch(() => {});
    }
    return await sharedRecovery;
  };

  const installCoordinatedRuntime = (outcome) => {
    runningHostCompatibility = outcome.compatibility ?? hostCompatibility("unknown", false, "host-health-unavailable");
    durableUnavailableReason = outcome.unavailableReason;
    const runtime = outcome.runtime;
    if (!runtime || disposed) return null;
    settledRuntime = runtime;
    durableRuntimePromise = Promise.resolve(runtime);
    usesSharedLateRuntime = true;
    return runtime;
  };

  const recoverLateTuiHost = async () => {
    if (disposed || !durableEnabled || !durableRuntimePromise || !lateRecoveryCoordination) return null;
    if (lateRecoveryPromise) return await lateRecoveryPromise;
    if (!lateRecoveryCoordination.lateRecoveryAttempted && lateRecoveryCoordination.recoveryPromise) {
      const initialRecovery = lateRecoveryCoordination.recoveryPromise;
      await initialRecovery;
      if (lateRecoveryCoordination.recoveryPromise === initialRecovery) lateRecoveryCoordination.recoveryPromise = null;
    }
    if (lateRecoveryCoordination.lateRecoveryAttempted) {
      if (lateRecoveryCoordination.recoveryPromise) await lateRecoveryCoordination.recoveryPromise;
      return installCoordinatedRuntime({
        runtime: lateRecoveryCoordination.runtime,
        compatibility: lateRecoveryCoordination.compatibility,
        unavailableReason: lateRecoveryCoordination.unavailableReason,
      });
    }
    lateRecoveryCoordination.lateRecoveryAttempted = true;
    startupValidationPending = true;
    lateRecoveryPromise = (async () => {
      const outcome = await acquireCoordinatedDurableRuntime();
      runningHostCompatibility = outcome.compatibility ?? hostCompatibility("unknown", false, "host-health-unavailable");
      durableUnavailableReason = outcome.unavailableReason;
      return installCoordinatedRuntime(outcome);
    })();
    try {
      return await lateRecoveryPromise;
    } finally {
      startupValidationPending = false;
      lateRecoveryPromise = null;
    }
  };

  const executeSelfEvolveCommand = async (input, output) => {
    // Read the module-level `currentPluginOptions` at call time (not a
    // per-instance closure variable) so behavior is consistent even if
    // OpenCode's double-instantiation leaves more than one instance's
    // hooks reachable.
    const command = parseCommand(input.arguments ?? "");
    if (durableEnabled && currentPluginOptions.durableAutonomy !== false) {
      if (startupValidationPending) {
        replaceParts(output, displayPart(input), textPart("Self-evolve durable integration unavailable (startup-validation-pending). Host compatibility and state-root validation must complete before commands gain authority. No mode change, self-evolve analyzer call, or file write was attempted."));
        return;
      }
      if (!runningHostCompatibility.supported) {
        const runtime = runningHostCompatibility.reason === "host-health-unavailable"
          ? await recoverLateTuiHost()
          : null;
        if (!runtime) {
          replaceParts(output, displayPart(input), textPart(unsupportedHostCommandText(command, runningHostCompatibility)));
          return;
        }
      }
      const runtime = await durableRuntimePromise;
      const pipeline = runtime?.integration;
      const sessionID = inputSessionID(input);
      if (pipeline) {
        const projectFingerprint = runtime.identity.projectFingerprint;
        const scopeFingerprint = currentPluginOptions.scopeFingerprint ?? projectFingerprint;
        if (typeof pipeline.handleCommand === "function") {
          const result = await pipeline.handleCommand({
            command: input.arguments ?? "",
            ctx,
            sessionID,
            projectFingerprint,
            scopeFingerprint,
          });
          replaceParts(output, displayPart(input), textPart(result?.responseText ?? "Self-evolve command failed: durable integration returned no response."));
          return;
        }
        // Keep the injected pre-integration test seam compatible with v0.2.0:
        // older pipeline stubs expose only runEvolutionCycle().
        if (command.verb === "scan" && sessionID) {
          const result = await pipeline.runEvolutionCycle({ ctx, sessionID, projectFingerprint, scopeFingerprint, trigger: { kind: "manual", reason: "manual-scan" }, mode: currentPluginOptions.mode ?? "manual", options: currentPluginOptions });
          replaceParts(output, displayPart(input), textPart(result.responseText));
          return;
        }
      }
      const detail = durableUnavailableReason ? ` (${durableUnavailableReason})` : "";
      replaceParts(output, displayPart(input), textPart(`Self-evolve durable integration unavailable${detail}. No mode change or files were applied. Configure an explicit stateRoot and restart OpenCode if host state-path validation cannot complete.`));
      return;
    }
    await handleCommand(ctx, input, output, currentPluginOptions, configuredModel);
  };

  const hooks = {
    config: async (cfg) => {
      configuredModel = cfg.model;
      cfg.agent = cfg.agent ?? {};
      cfg.agent[SELF_EVOLVE_ANALYZER_AGENT] = {
        description: "Hidden session-local self-evolve analyzer that returns strict JSON proposals from bounded redacted transcript evidence.",
        mode: "primary",
        hidden: true,
        model: cfg.model,
        temperature: 0,
        steps: 1,
        prompt: ANALYZER_SYSTEM_PROMPT,
        permission: analyzerPermissionConfig(),
      };
    },

    "command.execute.before": async (input, output) => {
      if (input.command !== "self-evolve") return;
      if (lateRecoveryCoordination && input && typeof input === "object") {
        const priorDispatch = lateRecoveryCoordination.commandDispatches.get(input);
        if (priorDispatch) {
          await priorDispatch.promise;
          if (priorDispatch.output !== output) replaceParts(output, ...(priorDispatch.output?.parts ?? []));
          return;
        }
        const dispatch = executeSelfEvolveCommand(input, output);
        lateRecoveryCoordination.commandDispatches.set(input, { promise: dispatch, output });
        await dispatch;
        return;
      }
      await executeSelfEvolveCommand(input, output);
    },

    dispose: async () => {
      if (disposed) return;
      // The module-level registry is keyed by runtime session IDs and would
      // otherwise retain per-session state for the whole process lifetime. Clear
      // it when opencode unloads the plugin so nothing outlives this instance.
      registry.clear();
      disposed = true;
      if (hostRecoveryTimer) clearTimeout(hostRecoveryTimer);
      hostRecoveryTimer = null;
      resolveDeferredRuntime?.(null);
      resolveDeferredRuntime = undefined;
      startupValidationPending = false;
      const coordination = lateRecoveryCoordination;
      let ownsCoordinatorClose = false;
      let resolveCoordinatorClose;
      if (coordination) {
        coordination.users.delete(durableInstanceToken);
        if (
          coordination.users.size === 0
          && !coordination.closingPromise
          && lateDurableRecoveryRegistry.get(coordination.key) === coordination
        ) {
          ownsCoordinatorClose = true;
          coordination.closingPromise = new Promise((resolve) => { resolveCoordinatorClose = resolve; });
          coordination.controller.abort();
        }
      }
      try { await startupTask; } catch {}
      try { await lateRecoveryPromise; } catch {}
      if (coordination && ownsCoordinatorClose) {
        try { await coordination.recoveryPromise; } catch {}
        const sharedRuntime = coordination.runtime;
        try {
          const pipeline = sharedRuntime?.integration;
          await (pipeline?.shutdown?.() ?? pipeline?.close?.());
        } catch {
        } finally {
          coordination.runtime = null;
          if (lateDurableRecoveryRegistry.get(coordination.key) === coordination) {
            lateDurableRecoveryRegistry.delete(coordination.key);
          }
          coordination.closingPromise = null;
          resolveCoordinatorClose?.();
        }
      } else if (coordination?.closingPromise && coordination.users.size === 0) {
        try { await coordination.closingPromise; } catch {}
      }
      if (!usesSharedLateRuntime) {
        try {
          const pipeline = (await durableRuntimePromise)?.integration;
          await (pipeline?.shutdown?.() ?? pipeline?.close?.());
        } catch {}
      }
      settledRuntime = null;
    },
  };

  if (durableEnabled && startupMode !== "manual") {
    hooks.event = async (input) => {
      if (!isDurableLifecycleEvent(input)) return;
      const integration = settledRuntime?.integration;
      if (!integration) return;
      if (lateRecoveryCoordination && input && typeof input === "object") {
        const priorDispatch = lateRecoveryCoordination.eventDispatches.get(input);
        if (priorDispatch) {
          await priorDispatch;
          return;
        }
        const dispatch = Promise.resolve(integration?.handleEvent?.(input));
        lateRecoveryCoordination.eventDispatches.set(input, dispatch);
        await dispatch;
        return;
      }
      await integration?.handleEvent?.(input);
    };
  }

  if (durableEnabled && durableRuntimePromise) {
    const delayMs = Math.min(5_000, Math.max(0, instancePluginOptions.hostRecoveryDelayMs ?? 0));
    hostRecoveryTimer = setTimeout(() => {
      hostRecoveryTimer = null;
      startupTask = (async () => {
        if (!resolveDeferredRuntime || disposed) return;
        const deferredResolve = resolveDeferredRuntime;
        const outcome = await acquireCoordinatedDurableRuntime();
        const runtime = installCoordinatedRuntime(outcome);
        if (!disposed) {
          resolveDeferredRuntime = undefined;
          deferredResolve(runtime);
          startupValidationPending = false;
        }
      })();
    }, delayMs);
    hostRecoveryTimer.unref?.();
  }

  return hooks;
}

SelfEvolvePlugin.__test = {
  get registry() {
    return registry;
  },
  analyzerPermissionNames,
  handleCommand,
  humanizeScanReason,
  proposalNotification,
  readRecentMessages,
  replaceParts,
  resolveStateRoot,
  responseText,
  runAnalysis,
  scanText,
  showProposalToast,
  __resetRegistryForTests: () => registry.clear(),
};

export default SelfEvolvePlugin;
