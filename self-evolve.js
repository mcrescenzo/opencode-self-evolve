import {
  applyControlCommand,
  beginAnalyzerRun,
  buildTranscript,
  completeAnalysis,
  createRegistry,
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

// Reassigned on every SelfEvolvePlugin(...) call so the most recently
// resolved options are always used by hook bodies and by
// `registry.setOptions()`. This is what "re-seeds options" means in
// practice: the shared module-level registry survives, only the options used
// for NEW session state (and the eviction cap) are refreshed.
let currentPluginOptions = resolveOptions();

function now(options) {
  return typeof options?.now === "function" ? options.now() : Date.now();
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
  let configuredModel = null;

  return {
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
      // Read the module-level `currentPluginOptions` at call time (not a
      // per-instance closure variable) so behavior is consistent even if
      // OpenCode's double-instantiation leaves more than one instance's
      // hooks reachable.
      await handleCommand(ctx, input, output, currentPluginOptions, configuredModel);
    },

    dispose: () => {
      // The module-level registry is keyed by runtime session IDs and would
      // otherwise retain per-session state for the whole process lifetime. Clear
      // it when opencode unloads the plugin so nothing outlives this instance.
      registry.clear();
    },
  };
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
  responseText,
  runAnalysis,
  scanText,
  showProposalToast,
  __resetRegistryForTests: () => registry.clear(),
};

export default SelfEvolvePlugin;
