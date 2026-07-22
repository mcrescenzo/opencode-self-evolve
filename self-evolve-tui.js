import { createHash } from "node:crypto";
import { DEFAULT_BUDGETS, Mode, makeDecision } from "./self-evolve-schemas.js";

/** @typedef {import("@opencode-ai/plugin/tui").TuiPlugin} TuiPlugin */
/** @typedef {import("@opencode-ai/plugin/tui").TuiPluginApi} TuiPluginApi */

const PREVIEW_LINE_LIMIT = 50;
const NOTIFICATION_KEY = "self-evolve:notification-history";
const FIRST_USE_KEY = "self-evolve:first-use-seen";
const DISMISSED_KEY = "self-evolve:dismissed-ids";
const LAST_SHOWN_KEY = "self-evolve:last-shown-at";
const ACTOR = "self-evolve-tui";
const MAX_SERVER_WAIT_MS = 5_000;

function nowFor(api) {
  return typeof api.now === "function" ? api.now() : Date.now();
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function lines(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").split("\n");
}

function boundedPreview(inputLines) {
  if (inputLines.length <= PREVIEW_LINE_LIMIT) return inputLines.join("\n");
  return [...inputLines.slice(0, PREVIEW_LINE_LIMIT), "[truncated - use /self-evolve review <id> for full content]"].join("\n");
}

function proposalContent(proposal) {
  return proposal.proposedContent ?? proposal.appliedContent ?? proposal.content ?? "";
}

export function formatProposalDigest(proposal, inventory = {}) {
  const target = proposal?.skillTarget?.relativePath ?? proposal?.target ?? "unknown skill";
  const risk = proposal?.injectionFlagged
    ? "critical"
    : proposal?.risk ?? (proposal?.criticPassed === false || proposal?.validDeterministic === false ? "high" : "low");
  const currentTokens = Number(inventory?.currentTokens ?? proposal?.currentTokens ?? 0);
  const proposedTokens = Number(inventory?.proposedTokens ?? proposal?.proposedTokens ?? 0);
  const tokenDelta = Number.isFinite(proposal?.tokenDelta)
    ? proposal.tokenDelta
    : Number.isFinite(currentTokens) && Number.isFinite(proposedTokens)
      ? proposedTokens - currentTokens
      : 0;
  const actionLabel = proposal?.state === "applied" ? "Review applied change" : proposal?.state === "pending" ? "Review proposal" : "Review record";
  return {
    title: `${actionLabel}: ${target}`,
    body: String(proposal?.rationaleText ?? proposal?.rationale ?? "No rationale supplied."),
    risk,
    tokenDelta,
    actionLabel,
  };
}

export function formatDiffOrNewSkillPreview(proposal, currentContent) {
  const proposedLines = lines(proposalContent(proposal));
  if (currentContent === undefined || currentContent === null || currentContent === "") {
    return { kind: "new", previewText: boundedPreview(proposedLines), linesChanged: proposedLines.length };
  }
  const currentLines = lines(currentContent);
  const changed = [];
  const length = Math.max(currentLines.length, proposedLines.length);
  let linesChanged = 0;
  for (let index = 0; index < length; index += 1) {
    if (currentLines[index] === proposedLines[index]) continue;
    linesChanged += 1;
    if (currentLines[index] !== undefined) changed.push(`- ${currentLines[index]}`);
    if (proposedLines[index] !== undefined) changed.push(`+ ${proposedLines[index]}`);
  }
  return { kind: "diff", previewText: boundedPreview(changed), linesChanged };
}

export function formatEligibilityExplanation(eligibility = {}) {
  const output = [];
  for (const reason of eligibility.reasons ?? []) output.push(`- ${reason}`);
  for (const [name, value] of Object.entries(eligibility.thresholdsMet ?? {})) output.push(`- Met ${name}: ${value}`);
  for (const [name, value] of Object.entries(eligibility.thresholdsMissed ?? {})) output.push(`- Missing ${name}: ${value}`);
  if (!output.length) output.push(`- Eligibility: ${eligibility.eligible === false ? "not eligible" : "validated"}`);
  return output;
}

export function safeIdlePredicate(api, debounceMs) {
  let idleSince;
  return () => {
    const sessionID = api.route?.current?.params?.sessionID;
    const status = typeof api.state?.session?.status === "function" ? api.state.session.status(sessionID) : api.state?.session?.status;
    const kind = typeof status === "string" ? status : status?.type ?? status?.status;
    if (kind !== "idle") {
      idleSince = undefined;
      return false;
    }
    const now = nowFor(api);
    const reportedSince = status && typeof status === "object" ? status.since ?? status.updatedAt : undefined;
    if (idleSince === undefined) idleSince = Number.isFinite(reportedSince) ? reportedSince : now;
    return now - idleSince >= debounceMs;
  };
}

export function notificationRateLimiter(api, budgetPerHour) {
  const budget = Math.max(0, Math.trunc(budgetPerHour));
  const recent = () => {
    const cutoff = nowFor(api) - 3_600_000;
    const stored = api.kv.get(NOTIFICATION_KEY, []);
    return Array.isArray(stored) ? stored.filter((entry) => Number.isFinite(entry?.at) && entry.at > cutoff) : [];
  };
  return {
    canNotify(reason) {
      const history = recent();
      return history.length < budget
        ? { ok: true, remaining: budget - history.length, reason }
        : { ok: false, reason: "notification-budget-exhausted" };
    },
    record(reason) {
      const history = recent();
      history.push({ at: nowFor(api), reason: String(reason ?? "proposal") });
      api.kv.set(NOTIFICATION_KEY, history);
      return { ok: true, remaining: Math.max(0, budget - history.length) };
    },
  };
}

export function buildDecisionFromDialog(proposal, choice, actor) {
  const states = {
    apply: "approved",
    snooze: "pending",
    dismiss: "rejected",
    exclude: "rejected",
    undo: "rolled-back",
  };
  const normalized = String(choice).toLowerCase();
  const newState = states[normalized];
  if (!newState) throw new TypeError(`unsupported-dialog-choice: ${choice}`);
  const timestamp = proposal.decisionTimestamp ?? proposal.synthesizedAt ?? 0;
  const decisionVersion = proposal.decisionVersion + 1;
  const nonce = proposal.decisionNonce ?? sha256(`${proposal.id}:${decisionVersion}:${timestamp}:${normalized}:${actor}`);
  return makeDecision({
    proposalId: proposal.id,
    targetHash: proposal.skillTarget.currentHash,
    proposedContentHash: proposal.proposedContentHash,
    decisionVersion,
    actor,
    timestamp,
    nonce,
    priorState: proposal.state,
    newState,
  });
}

export function shouldShowProposal(proposal, { lastShownAt = {}, dismissedIds = [], now = Date.now() } = {}) {
  if (!proposal || !["pending", "applied"].includes(proposal.state)) return false;
  if (new Set(dismissedIds).has(proposal.id)) return false;
  if (Number.isFinite(proposal.snoozedUntil) && proposal.snoozedUntil > now) return false;
  const shown = typeof lastShownAt === "number" ? lastShownAt : lastShownAt?.[proposal.id];
  const changedAt = proposal.updatedAt ?? proposal.appliedAt ?? proposal.synthesizedAt ?? 0;
  return !Number.isFinite(shown) || shown < changedAt;
}

function unwrap(result) {
  return result?.data ?? result;
}

function bridgeFor(api, options) {
  return options?.selfEvolveBridge ?? api.client?.selfEvolve;
}

function commandForChoice(choice, proposalId) {
  if (choice === "apply") return { verb: "approve", proposalId };
  if (choice === "snooze") return { verb: "snooze", proposalId, duration: "1d" };
  if (choice === "dismiss" || choice === "exclude") return { verb: "reject", proposalId };
  if (choice === "undo") return { verb: "undo", proposalId };
  throw new TypeError(`unsupported-dialog-choice: ${choice}`);
}

function resultFailure(result) {
  const value = unwrap(result);
  if (value?.ok === false) return value.reason ?? value.error ?? "decision-failed";
  return null;
}

function dialogError(api, message) {
  api.ui.DialogAlert({
    title: "Self-evolve error",
    message: `${message}. See /self-evolve health for details.`,
  });
}

/** @type {TuiPlugin} */
export async function SelfEvolveTuiPlugin(api, options = {}, meta) {
  if (typeof api.ui?.DialogConfirm !== "function" || typeof api.ui?.DialogSelect !== "function") {
    console.warn("self-evolve TUI disabled: native dialog capabilities are unavailable; proposals remain in the durable inbox");
    return;
  }

  const config = options?.selfEvolve ?? options ?? {};
  const debounceMs = Number.isFinite(config.idleDebounceMs) ? config.idleDebounceMs : DEFAULT_BUDGETS.idleDebounceMs;
  const budget = Number.isFinite(config.notificationsPerHour) ? config.notificationsPerHour : DEFAULT_BUDGETS.notificationsPerHour;
  const eventType = config.eventType ?? "self-evolve.proposal";
  const serverTimeoutMs = Math.min(MAX_SERVER_WAIT_MS, Math.max(1, Number.isFinite(config.serverTimeoutMs) ? config.serverTimeoutMs : MAX_SERVER_WAIT_MS));
  const bridge = bridgeFor(api, options);
  const idle = safeIdlePredicate(api, debounceMs);
  const limiter = notificationRateLimiter(api, budget);
  const inFlight = new Set();
  const unsubscribers = [];
  const timers = new Set();
  let disposed = false;
  let refreshQueued = false;

  const dismissedIds = () => {
    const value = api.kv.get(DISMISSED_KEY, []);
    return Array.isArray(value) ? value : [];
  };
  const lastShownAt = () => {
    const value = api.kv.get(LAST_SHOWN_KEY, {});
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  };
  const dialogsEnabled = () => api.kv.get(FIRST_USE_KEY) === true;

  function setTimer(fn, delay) {
    const handle = setTimeout(() => {
      timers.delete(handle);
      fn();
    }, delay);
    timers.add(handle);
  }

  async function boundedServerCall(task) {
    let timer;
    try {
      return await Promise.race([
        task(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("server-response-timeout")), serverTimeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function getInbox() {
    if (typeof bridge?.getInbox !== "function") return [];
    const value = unwrap(await boundedServerCall(() => bridge.getInbox({ signal: api.lifecycle.signal })));
    return Array.isArray(value) ? value : value?.proposals ?? [];
  }

  async function getFreshProposal(proposalId) {
    if (typeof bridge?.getProposal !== "function") return null;
    const value = unwrap(await boundedServerCall(() => bridge.getProposal({ proposalId, signal: api.lifecycle.signal })));
    return value?.proposal ?? value ?? null;
  }

  async function executeCommand(command) {
    if (typeof bridge?.execute !== "function") throw new Error("server-command-bridge-unavailable");
    return boundedServerCall(() => bridge.execute({ command, signal: api.lifecycle.signal }));
  }

  function busyDialog(proposal, body) {
    api.ui.DialogSelect({
      title: `Applying decision: ${proposal.skillTarget?.relativePath ?? proposal.id}`,
      options: [{ title: "Working...", value: "busy", description: body, disabled: true }],
      skipFilter: true,
    });
  }

  async function submitChoice(proposal, choice, body) {
    if (inFlight.has(proposal.id)) return { ok: false, reason: "decision-in-flight" };
    inFlight.add(proposal.id);
    busyDialog(proposal, body);
    try {
      const fresh = await getFreshProposal(proposal.id);
      if (!fresh) throw new Error("proposal-not-found");
      if (choice === "undo" && fresh.state !== "applied") throw new Error("proposal-not-applied");
      const decision = buildDecisionFromDialog({ ...fresh, decisionTimestamp: nowFor(api) }, choice, ACTOR);
      if (typeof bridge?.decide !== "function") throw new Error("server-decision-bridge-unavailable");
      const result = await boundedServerCall(() => bridge.decide({ decision, command: commandForChoice(choice, fresh.id), signal: api.lifecycle.signal }));
      const failure = resultFailure(result);
      if (failure) {
        if (/stale-prior-state|nonce-already-burned|replayed-decision/.test(failure)) {
          api.ui.DialogAlert({ title: "Proposal changed", message: `${failure}. The durable inbox will be refreshed.` });
          queueRefresh();
          return { ok: false, reason: failure };
        }
        throw new Error(failure);
      }
      if (choice === "exclude") await executeCommand({ verb: "repo-override", excluded: true });
      const shown = lastShownAt();
      api.kv.set(LAST_SHOWN_KEY, { ...shown, [fresh.id]: nowFor(api) });
      if (choice === "dismiss" || choice === "exclude") api.kv.set(DISMISSED_KEY, [...new Set([...dismissedIds(), fresh.id])]);
      return { ok: true, decision };
    } catch (error) {
      dialogError(api, error instanceof Error ? error.message : String(error));
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    } finally {
      inFlight.delete(proposal.id);
    }
  }

  function reviewBody(proposal) {
    const digest = formatProposalDigest(proposal, proposal.inventory);
    const preview = formatDiffOrNewSkillPreview(proposal, proposal.priorContent ?? proposal.currentContent);
    const eligibility = formatEligibilityExplanation(proposal.eligibility);
    return [
      digest.body,
      `Risk: ${digest.risk}`,
      `Token delta: ${digest.tokenDelta >= 0 ? "+" : ""}${digest.tokenDelta}`,
      ...eligibility,
      `${preview.kind === "new" ? "New skill" : "Diff"} (${preview.linesChanged} changed lines):`,
      preview.previewText,
    ].join("\n");
  }

  function showProposal(proposal) {
    const digest = formatProposalDigest(proposal, proposal.inventory);
    const body = reviewBody(proposal);
    const audit = proposal.state === "applied" && proposal.mode === "yolo";
    const choices = audit
      ? [["Undo", "undo"], ["Dismiss audit", "dismiss-audit"]]
      : [["Apply", "apply"], ["Snooze", "snooze"], ["Dismiss", "dismiss"], ["Exclude repository", "exclude"]];
    const optionsForDialog = choices.map(([title, value]) => ({
      title,
      value,
      description: value === "undo" ? "Rollback only if the applied hash still matches." : digest.actionLabel,
      footer: body,
      disabled: value === "undo" && proposal.state !== "applied",
    }));
    const onSelect = (option) => {
      if (option.disabled || inFlight.has(proposal.id)) return;
      if (option.value === "dismiss-audit") {
        api.kv.set(DISMISSED_KEY, [...new Set([...dismissedIds(), proposal.id])]);
        return;
      }
      void submitChoice(proposal, option.value, body);
    };
    for (const option of optionsForDialog) option.onSelect = () => onSelect(option);
    api.ui.toast({ variant: "info", message: "New self-evolve proposal ready for review" });
    api.ui.DialogSelect({ title: digest.title, options: optionsForDialog, onSelect, skipFilter: true });
  }

  async function refreshInbox() {
    refreshQueued = false;
    if (disposed || api.lifecycle.signal.aborted || !dialogsEnabled()) return { ok: false, reason: "dialogs-disabled" };
    if (!idle()) {
      setTimer(queueRefresh, debounceMs);
      return { ok: false, reason: "session-not-idle" };
    }
    try {
      const proposals = await getInbox();
      const proposal = proposals.find((item) => shouldShowProposal(item, {
        lastShownAt: lastShownAt(),
        dismissedIds: dismissedIds(),
        now: nowFor(api),
      }));
      if (!proposal) return { ok: false, reason: "inbox-empty" };
      const allowance = limiter.canNotify(`proposal:${proposal.id}`);
      if (!allowance.ok) return { ok: false, reason: allowance.reason };
      limiter.record(`proposal:${proposal.id}`);
      if (typeof api.attention?.notify === "function") {
        await api.attention.notify({ title: "Self-evolve", message: "A proposal is ready for review", notification: true, sound: false });
      }
      showProposal(proposal);
      return { ok: true };
    } catch (error) {
      if (!api.lifecycle.signal.aborted) dialogError(api, error instanceof Error ? error.message : String(error));
      return { ok: false, reason: "inbox-read-failed" };
    }
  }

  function queueRefresh() {
    if (refreshQueued || disposed || api.lifecycle.signal.aborted) return;
    refreshQueued = true;
    queueMicrotask(() => void refreshInbox());
  }

  function confirm(title, message, onConfirm) {
    api.ui.DialogConfirm({ title, message, onConfirm: () => void onConfirm(), onCancel: () => {} });
  }

  async function applyMode(mode, allowlist) {
    await executeCommand({ verb: "mode", mode, ...(mode === "yolo" ? { confirmed: true, allowlist } : {}) });
  }

  function handleSettingsEvent(event) {
    const request = event?.properties ?? event?.data ?? event ?? {};
    if (request.action === "mode" && Mode.values.includes(request.mode)) {
      if (request.mode !== "yolo") {
        confirm("Change self-evolve mode", `Set the global mode to ${request.mode}?`, () => applyMode(request.mode));
        return;
      }
      confirm("Enable elevated yolo mode?", "Yolo may apply validated changes without per-change approval inside the explicit allowlist.", () => {
        confirm("Confirm yolo allowlist", `Only these roots may be changed:\n${(request.allowlist ?? []).join("\n") || "No roots supplied"}`, () => applyMode("yolo", request.allowlist ?? []));
      });
      return;
    }
    if (request.action === "allowlist") {
      confirm("Modify yolo allowlist?", "Changing the allowlist changes where unattended writes may occur.", () => {
        confirm("Confirm allowlist roots", (request.allowlist ?? []).join("\n") || "No roots supplied", () => applyMode("yolo", request.allowlist ?? []));
      });
    }
  }

  function handleConsentEvent(event) {
    const request = event?.properties ?? event?.data ?? event ?? {};
    const definitions = {
      sanitizedExcerpts: ["Consent to sanitized excerpts?", "Redaction is heuristic, not a secrecy guarantee."],
      crossRepoAggregation: ["Consent to cross-repository aggregation?", "Only sanitized normalized evidence is aggregated; repository identifiers are excluded."],
    };
    if (!definitions[request.key]) return;
    const [title, message] = definitions[request.key];
    confirm(title, message, () => executeCommand({ verb: "consent", key: request.key, value: request.value !== false }));
  }

  if (api.kv.get(FIRST_USE_KEY) === undefined) {
    api.ui.DialogConfirm({
      title: "Enable self-evolve proposal dialogs?",
      message: "Self-evolve can analyze bounded structured evidence and show native proposal reviews. It never injects messages into your working session. Allow future proposal dialogs?",
      onConfirm: () => {
        api.kv.set(FIRST_USE_KEY, true);
        queueRefresh();
      },
      onCancel: () => api.kv.set(FIRST_USE_KEY, false),
    });
  }

  unsubscribers.push(api.event.on(eventType, queueRefresh));
  unsubscribers.push(api.event.on("session.idle", queueRefresh));
  unsubscribers.push(api.event.on("session.status", queueRefresh));
  unsubscribers.push(api.event.on("self-evolve.settings", handleSettingsEvent));
  unsubscribers.push(api.event.on("self-evolve.consent", handleConsentEvent));

  const abort = () => {
    disposed = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
  api.lifecycle.signal.addEventListener("abort", abort, { once: true });
  api.lifecycle.onDispose(() => {
    abort();
    api.lifecycle.signal.removeEventListener("abort", abort);
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  });

  if (dialogsEnabled()) queueRefresh();
}

export default { tui: SelfEvolveTuiPlugin };
