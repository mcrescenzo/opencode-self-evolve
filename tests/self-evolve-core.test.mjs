import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  DEFAULT_OPTIONS,
  STATUSES,
  SELF_EVOLVE_ANALYZER_AGENT,
  SELF_EVOLVE_SOURCE,
  applyControlCommand,
  beginAnalyzerRun,
  buildTranscript,
  classifyPlacement,
  completeAnalysis,
  createRegistry,
  createSessionState,
  currentStatus,
  finishAnalysisSuppressed,
  isUnsafeTarget,
  helpText,
  parseCommand,
  parseAnalyzerOutput,
  redactText,
  reserveAnalysis,
  resolveOptions,
  statusText,
  truncateTail,
  truncateText,
  validateAnalyzerPayload,
} from "../self-evolve-core.js";

function validPayload(overrides = {}) {
  const proposal = {
    title: "Document self-evolve command behavior",
    summary: "The transcript shows confusion about the self-evolve command surface, so the command docs should state the intercepted behavior clearly.",
    evidence: ["The session discussed /self-evolve command handling and plugin interception."],
    target: { path: "commands/self-evolve.md", surface: "global slash command docs", symbol: "" },
    placement: "global",
    risk: "low",
    riskMitigation: "Limit the change to documentation and keep runtime behavior unchanged.",
    confidence: 0.91,
    suggestedAction: "Clarify the command forms and explain that the plugin intercepts them before a normal model turn.",
    ...(overrides.proposal ?? {}),
  };
  return { reason: "Concrete command documentation improvement.", ...overrides, proposal };
}

function startManual(state, at = 1, messageCount = 6) {
  const reserve = reserveAnalysis(state, { kind: "manual" }, at);
  assert.equal(reserve.allowed, true);
  const gate = beginAnalyzerRun(state, messageCount, at);
  assert.equal(gate.allowed, true);
}

test("resolveOptions coerces numeric strings and defaults invalid numeric values", () => {
  const opts = resolveOptions({
    minIntervalMs: "2500",
    maxAnalyzerRuns: "-1",
    maxProposals: "0",
    minConfidence: "0.8",
    analyzerTimeoutMs: "not-a-number",
    sdkTimeoutMs: 0,
  });

  assert.equal(opts.minIntervalMs, 2500);
  assert.equal(opts.maxAnalyzerRuns, DEFAULT_OPTIONS.maxAnalyzerRuns);
  assert.equal(opts.maxProposals, 0);
  assert.equal(opts.minConfidence, 0.8);
  assert.equal(opts.analyzerTimeoutMs, DEFAULT_OPTIONS.analyzerTimeoutMs);
  assert.equal(opts.sdkTimeoutMs, 0);
});

test("truncation helpers do not leak content for zero or negative limits", () => {
  assert.equal(truncateTail("abcdef", 0, "secret"), "[omitted 6 chars of secret]");
  assert.equal(truncateTail("abcdef", -2, "secret"), "[omitted 6 chars of secret]");
  assert.equal(truncateText("abcdef", 0, "secret"), "[truncated 6 chars of secret]");
  assert.equal(truncateText("abcdef", -2, "secret"), "[truncated 6 chars of secret]");
});

test("truncation helpers never split an astral surrogate pair", () => {
  // "😀" is U+1F600, two UTF-16 code units (0xD83D 0xDE00).
  const head = "ab😀cd"; // length 6: a b hi lo c d
  // maxChars=3 lands on the low surrogate; the head cut must step back to 2.
  const truncatedHead = truncateText(head, 3, "msg");
  const headKept = truncatedHead.split("\n")[0];
  assert.equal(headKept, "ab");
  assert.ok(!hasLoneSurrogate(headKept), "head cut leaked a lone surrogate");

  const tail = "ab😀cd";
  // maxChars=3 -> cut index = length-3 = 3, a low surrogate; must step back to 2.
  const truncatedTail = truncateTail(tail, 3, "msg");
  const tailKept = truncatedTail.split("\n")[1];
  assert.equal(tailKept, "😀cd");
  assert.ok(!hasLoneSurrogate(tailKept), "tail cut leaked a lone surrogate");

  // ASCII boundaries are unaffected.
  assert.equal(truncateText("abcdef", 3, "x"), "abc\n[truncated 3 chars of x]");
  assert.equal(truncateTail("abcdef", 3, "x"), "[omitted 3 earlier chars of x]\ndef");
});

function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
      i++;
    } else if (c >= 0xDC00 && c <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

test("registry getOrCreate and delete manage session state", () => {
  const registry = createRegistry({ maxAnalyzerRuns: 2 });
  const state = registry.getOrCreate("s-registry", 123);

  assert.equal(state.options.maxAnalyzerRuns, 2);
  assert.equal(registry.has("s-registry"), true);
  assert.equal(registry.delete("s-registry"), true);
  assert.equal(registry.has("s-registry"), false);
});

test("registry lazily evicts oldest inactive sessions while preserving pending proposals", () => {
  const registry = createRegistry({ maxRegistrySessions: 2 });
  const first = registry.getOrCreate("first", 1);
  first.pendingProposal = { id: "se-1", title: "Keep pending proposal" };
  registry.getOrCreate("second", 2);
  registry.getOrCreate("third", 3);
  registry.getOrCreate("fourth", 4);

  assert.equal(registry.has("first"), true, "pending proposal state must not be evicted");
  assert.equal(registry.has("second"), false, "oldest inactive state should be evicted first");
  assert.equal(registry.has("third"), false, "inactive state should be evicted when cap is still exceeded");
  assert.equal(registry.has("fourth"), true);
  assert.equal(registry.map.size, 2);
});

test("maxRegistrySessions:0 caps the registry at zero and evicts eagerly instead of growing unbounded", () => {
  // A caller setting 0 intends "do not accumulate session state". The old guard
  // treated <= 0 as "uncapped" and returned before evicting, so the Map grew
  // without any ceiling. Now 0 must clamp the cap to zero: only the session
  // currently being served (and any analyzing/pending ones) may remain.
  const registry = createRegistry({ maxRegistrySessions: 0 });
  for (let i = 0; i < 25; i++) {
    registry.getOrCreate(`s-${i}`, i + 1);
    // After each call the only retained inactive session is the one just served.
    assert.equal(registry.map.size, 1, `registry must not grow past the zero cap (iter ${i})`);
    assert.equal(registry.has(`s-${i}`), true, "the session currently being served survives the zero cap");
  }

  // A session with a pending proposal is protected from eviction even at cap 0.
  const pending = registry.getOrCreate("pending", 100);
  pending.pendingProposal = { id: "se-keep", title: "Keep pending proposal" };
  registry.getOrCreate("next", 101);
  assert.equal(registry.has("pending"), true, "pending proposal state must survive even a zero cap");
  assert.equal(registry.has("next"), true, "the session currently being served survives the zero cap");
});

test("manual analyzer runs bypass cooldown while retaining caps", () => {
  const state = createSessionState("s1", { minIntervalMs: 600000 }, 0);

  startManual(state, 1000, 1);
  completeAnalysis(state, { proposal: null, reason: "No proposal." }, { now: 1000, messageCount: 1 });
  assert.equal(currentStatus(state, 2000), STATUSES.COOLDOWN);

  assert.equal(reserveAnalysis(state, { kind: "manual" }, 2000).allowed, true);
  const gate = beginAnalyzerRun(state, 1, 2000);
  assert.equal(gate.allowed, true);
  assert.equal(state.analyzerRuns, 2);
});

test("reserveAnalysis reports run and proposal caps", () => {
  const runCapped = createSessionState("run-cap", { maxAnalyzerRuns: 1 }, 0);
  runCapped.analyzerRuns = 1;
  assert.deepEqual(reserveAnalysis(runCapped, { kind: "manual" }, 100), { allowed: false, reason: "run-cap" });

  const proposalCapped = createSessionState("proposal-cap", { maxProposals: 1 }, 0);
  proposalCapped.proposalCount = 1;
  assert.deepEqual(reserveAnalysis(proposalCapped, { kind: "manual" }, 100), { allowed: false, reason: "proposal-cap" });
});

test("transcript builder preserves manual-scan transcript text without trigger promotion fields", () => {
  const transcript = buildTranscript([
    { id: "1", role: "assistant", parts: [{ type: "text", text: "The plugin command failed with a stack trace." }] },
  ]);
  assert.match(transcript.text, /plugin command failed/);
  assert.equal(transcript.messageCount, 1);
  assert.equal(transcript.includedMessages, 1);
  assert.equal("highSignal" in transcript, false);
  assert.equal("highSignalReason" in transcript, false);
});

test("messageLimit:0 yields an empty transcript instead of keeping every message", () => {
  const transcript = buildTranscript([
    { id: "1", role: "user", parts: [{ type: "text", text: "First message." }] },
    { id: "2", role: "assistant", parts: [{ type: "text", text: "Second message." }] },
  ], { messageLimit: 0 });
  assert.equal(transcript.includedMessages, 0);
  assert.equal(transcript.text, "");
});

test("invalid JSON is suppressed and counted as analyzer failure", () => {
  const state = createSessionState("s3", {}, 0);
  startManual(state);
  const result = completeAnalysis(state, "not json", { now: 10, messageCount: 6 });
  assert.equal(result.accepted, false);
  assert.equal(result.failure, true);
  assert.equal(state.pendingProposal, null);
  assert.equal(state.analyzerFailures, 1);
});

test("low-confidence proposals are rejected without counting as analyzer failures", () => {
  const state = createSessionState("s4", {}, 0);
  startManual(state);
  const result = completeAnalysis(state, JSON.stringify(validPayload({ proposal: { confidence: 0.2 } })), { now: 10, messageCount: 6 });
  assert.equal(result.accepted, false);
  assert.equal(result.failure, false);
  assert.match(result.reason, /confidence/i);
  assert.equal(state.analyzerFailures, 0);
  assert.equal(state.pendingProposal, null);
});

test("padded low-value proposals are rejected despite meeting length minimums", () => {
  const state = createSessionState("quality", {}, 0);
  const padded = validPayload({
    proposal: {
      title: "Improve docs now",
      summary: "Useful useful useful useful useful useful useful text for padding only.",
      evidence: ["Useful useful useful useful useful useful text passes the old length check."],
      target: { path: "src/auth.md", surface: "repo docs", symbol: "" },
      placement: "repo-local",
      riskMitigation: "Low risk low risk low risk.",
      suggestedAction: "Make useful useful useful docs better later.",
    },
  });

  const result = validateAnalyzerPayload(padded, state, { targetRoot: "/repo" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /substantive|connect/i);
});

test("target-relevance gate ignores evidence beyond the first 4 that would be truncated from output", () => {
  // Target terms are only "webhook" and "retry" (surface tokens repo/local/docs
  // are stop-words). Neither term appears in the summary, suggested action, or
  // the first four evidence items — only in the fifth (index 4), which the
  // cleaned output drops via evidence.slice(0, 4). The relevance gate must be
  // evaluated against the bounded evidence, so this proposal must NOT pass.
  const baseProposal = {
    title: "Document the outbound alert dispatch flow",
    summary: "The transcript shows confusion about how outbound alert dispatching behaves, so the guide should describe the fan-out sequence clearly.",
    target: { path: "docs/webhook-retry.md", surface: "repo-local docs", symbol: "" },
    placement: "repo-local",
    risk: "low",
    riskMitigation: "Limit the change to documentation and keep runtime behavior unchanged.",
    confidence: 0.91,
    suggestedAction: "Explain the outbound dispatch sequence and clarify how the handler forwards each queued event.",
  };
  const outOfBoundEvidence = [
    "The session traced outbound alert dispatch behavior across the handler.",
    "Operators asked how the dispatcher batches events before sending them.",
    "The guide never explains the sequence used for fan-out delivery paths.",
    "Discussion covered throttling and backoff during outage windows.",
    "The session traced a webhook retry storm during the outage.",
  ];

  const stateReject = createSessionState("bounded-evidence-reject", {}, 0);
  const rejected = validateAnalyzerPayload(
    validPayload({ proposal: { ...baseProposal, evidence: outOfBoundEvidence } }),
    stateReject,
    { targetRoot: "/repo" },
  );
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /evidence does not connect/i);

  // When the connecting evidence sits within the first 4 items, the same
  // proposal is accepted and the surfaced evidence is capped at 4 items.
  const inBoundEvidence = [
    "The session traced a webhook retry storm across the dispatch handler.",
    "Operators asked how the dispatcher batches events before sending them.",
    "The guide never explains the sequence used for fan-out delivery paths.",
    "Discussion covered throttling and backoff during outage windows.",
    "The session traced outbound alert dispatch behavior across the handler.",
  ];
  const stateAccept = createSessionState("bounded-evidence-accept", {}, 0);
  const accepted = validateAnalyzerPayload(
    validPayload({ proposal: { ...baseProposal, evidence: inBoundEvidence } }),
    stateAccept,
    { targetRoot: "/repo" },
  );
  assert.equal(accepted.ok, true);
  assert.equal(accepted.proposal.evidence.length, 4);
});

test("accepted proposal text is sanitized before storage and delivery", () => {
  const state = createSessionState("sanitize", {}, 0);
  const payload = validPayload({
    proposal: {
      title: "Add \u001b[31mtroubleshooting docs\u001b[0m [now](https://evil.example)",
      summary: "The transcript shows troubleshooting docs confusion with \u0007control output and a [bad link](javascript:alert(1)).",
      evidence: ["The session mentioned troubleshooting docs, confusing output, and a raw https://evil.example/path link."],
      target: { path: "docs/troubleshooting.md", surface: "repo-local docs", symbol: "" },
      placement: "repo-local",
      riskMitigation: "Keep the troubleshooting docs change small and avoid links to external sites.",
      suggestedAction: "Add troubleshooting docs guidance without using `markdown` links like https://evil.example/path.",
    },
  });

  const result = validateAnalyzerPayload(payload, state, { targetRoot: "/repo" });
  assert.equal(result.ok, true);
  const deliveredText = [
    result.proposal.title,
    result.proposal.summary,
    result.proposal.evidence.join(" "),
    result.proposal.riskMitigation,
    result.proposal.suggestedAction,
  ].join("\n");
  assert.doesNotMatch(deliveredText, /\u001b|\u0007|https?:|javascript:|`/);
  assert.match(deliveredText, /link removed/);
});

test("duplicate proposal fingerprints are suppressed after dismiss", () => {
  const state = createSessionState("s5", {}, 0);
  startManual(state);
  const first = completeAnalysis(state, validPayload(), { now: 10, messageCount: 6, targetRoot: "/repo" });
  assert.equal(first.accepted, true);
  assert.equal(first.proposal.id, "se-1");

  const dismissed = applyControlCommand(state, { verb: "dismiss", proposalID: "se-1" }, 20);
  assert.match(dismissed.text, /Dismissed/);
  assert.equal(state.pendingProposal, null);

  startManual(state, 30, 12);
  const second = completeAnalysis(state, validPayload(), { now: 40, messageCount: 12, targetRoot: "/repo" });
  assert.equal(second.accepted, false);
  assert.match(second.reason, /Duplicate/);
});

test("control commands cover help, unknown command, and dismiss sub-branches", () => {
  const state = createSessionState("control", {}, 0);

  const help = applyControlCommand(state, parseCommand("help"), 10);
  assert.equal(help.changed, false);
  assert.match(help.text, /\/self-evolve help/);
  assert.match(help.text, /redacted recent-session transcript to the configured model provider/);
  assert.match(helpText(), /\/self-evolve help/);

  const unknown = applyControlCommand(state, parseCommand("wat"), 10);
  assert.equal(unknown.changed, false);
  assert.match(unknown.text, /Unknown \/self-evolve command: wat/);

  const missingID = applyControlCommand(state, { verb: "dismiss", proposalID: "" }, 10);
  assert.equal(missingID.changed, false);
  assert.match(missingID.text, /Usage:/);

  const noPending = applyControlCommand(state, { verb: "dismiss", proposalID: "se-1" }, 10);
  assert.equal(noPending.changed, false);
  assert.match(noPending.text, /No pending/);

  state.pendingProposal = { id: "se-2", title: "Other proposal", fingerprint: "fp" };
  const wrongID = applyControlCommand(state, { verb: "dismiss", proposalID: "se-1" }, 10);
  assert.equal(wrongID.changed, false);
  assert.match(wrongID.text, /Pending proposal is se-2/);
  assert.equal(state.pendingProposal.id, "se-2");
});

test("statusText includes cooldown and pending proposal details", () => {
  const state = createSessionState("status", {}, 0);
  state.cooldownUntil = 60_000;

  const cooldownText = statusText(state, 1_000);
  assert.match(cooldownText, /Self-evolve status: cooldown/);
  assert.match(cooldownText, /Cooldown until: 1970-01-01T00:01:00\.000Z/);

  state.pendingProposal = { id: "se-3", title: "Pending docs proposal" };
  const pendingText = statusText(state, 1_000);
  assert.match(pendingText, /Self-evolve status: proposal-pending/);
  assert.match(pendingText, /Pending proposal: se-3 - Pending docs proposal/);
});

test("redaction covers obvious tokens and transcript bounds skip self-evolve messages", () => {
  const secretText = [
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
    "Authorization: Basic dXNlcjpwYXNz",
    "Cookie: sessionid=abcdef1234567890; csrftoken=secret",
    "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz1234567890",
    "DATABASE_URL=postgres://user:password@example.com/db",
    "Visit https://user:password@example.com/private if this leaks",
    "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----",
  ].join("\n");
  const redacted = redactText(secretText);
  assert.doesNotMatch(redacted, /abcdefghijklmnopqrstuvwxyz123456/);
  assert.doesNotMatch(redacted, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(redacted, /dXNlcjpwYXNz/);
  assert.doesNotMatch(redacted, /sessionid=abcdef/);
  assert.doesNotMatch(redacted, /user:password/);
  assert.doesNotMatch(redacted, /BEGIN PRIVATE KEY/);
  assert.match(redacted, /redacted/i);

  const transcript = buildTranscript([
    { id: "1", role: "user", parts: [{ type: "text", text: secretText }] },
    { id: "2", role: "assistant", mode: SELF_EVOLVE_ANALYZER_AGENT, parts: [{ type: "text", text: "hidden analyzer output" }] },
    { id: "3", role: "assistant", parts: [{ type: "text", text: "prior notification", metadata: { source: SELF_EVOLVE_SOURCE } }] },
  ]);
  assert.equal(transcript.messageCount, 1);
  assert.doesNotMatch(transcript.text, /hidden analyzer output/);
  assert.doesNotMatch(transcript.text, /prior notification/);
  assert.match(transcript.text, /redacted/i);
});

test("redaction covers common provider token formats individually", () => {
  const providerTokens = [
    ["stripe", `sk_live_${"a".repeat(24)}`],
    ["aws", "AKIAIOSFODNN7EXAMPLE"],
    ["slack", `xoxb-123456789012-123456789012-${"a".repeat(24)}`],
    ["github classic", `ghp_${"A".repeat(36)}`],
    ["github fine-grained", `github_pat_${"A".repeat(82)}`],
    ["google", `AIza${"A".repeat(35)}`],
    ["anthropic", `sk-ant-api03-${"A".repeat(30)}`],
    ["sendgrid", `SG.${"A".repeat(22)}.${"B".repeat(22)}`],
    ["npm", `npm_${"A".repeat(36)}`],
  ];

  for (const [label, token] of providerTokens) {
    const redacted = redactText(`leaked ${label} token: ${token}`);
    assert.equal(redacted.includes(token), false, `${label} token should be redacted`);
    assert.match(redacted, /redacted/i, `${label} token should leave a redaction marker`);
  }
});

test("private-key redaction is linear for unmatched BEGIN markers", () => {
  const input = "-----BEGIN PRIVATE KEY-----\n".repeat(10000);
  const startedAt = performance.now();
  const redacted = redactText(input);
  const elapsedMs = performance.now() - startedAt;

  assert.equal(redacted, "[redacted: private key]");
  assert.ok(elapsedMs < 200, `private-key redaction took ${elapsedMs.toFixed(1)}ms`);
});

test("analyzer failure cap disables a session", () => {
  const state = createSessionState("s6", { maxAnalyzerFailures: 3 }, 0);
  for (let i = 0; i < 3; i += 1) {
    startManual(state, i + 1, 6 + i);
    completeAnalysis(state, "{invalid", { now: 10 + i, messageCount: 6 + i });
  }
  assert.equal(state.analyzerFailures, 3);
  assert.equal(currentStatus(state, 20), STATUSES.DISABLED);
});

test("forced suppression preserves analyzerFailures; clean suppression resets them (bad-state-20)", () => {
  const state = createSessionState("s7", { maxAnalyzerFailures: 3 }, 0);
  state.analyzerFailures = 2;

  // Forced suppression (the stale-token / paused / disabled path) must NOT reset
  // the failure streak — otherwise pause-during-LLM + resume silently lifts the cap.
  finishAnalysisSuppressed(state, "state changed after reading messages", 10, state.options, 6);
  assert.equal(state.analyzerFailures, 2);

  // Clean suppression (analyzer ran fine, no actionable proposal) does reset.
  finishAnalysisSuppressed(state, "no actionable proposal", 20, state.options, 6, true);
  assert.equal(state.analyzerFailures, 0);
});

test("low-confidence (clean) suppression via completeAnalysis still resets the failure streak", () => {
  const state = createSessionState("s8", { maxAnalyzerFailures: 3 }, 0);
  state.analyzerFailures = 2;
  startManual(state);
  const result = completeAnalysis(state, JSON.stringify(validPayload({ proposal: { confidence: 0.2 } })), { now: 10, messageCount: 6 });
  assert.equal(result.failure, false);
  assert.equal(state.analyzerFailures, 0);
});

test("out-of-order completion: a late stale run cannot clobber a newer finished scan (bad-state / vu3)", () => {
  const state = createSessionState("s-vu3", {}, 0);

  // Run 1 reserves (token N); its analyzer call is still in flight.
  const run1 = reserveAnalysis(state, { kind: "manual" }, 1);
  assert.equal(run1.allowed, true);

  // Pause + resume clears the in-flight reservation without recording a finish,
  // so a fresh scan can be reserved while run1's completion is still pending.
  applyControlCommand(state, { verb: "pause" }, 2);
  applyControlCommand(state, { verb: "resume" }, 3);

  // Run 2 reserves (token N+1) and COMPLETES first with a real proposal.
  const run2 = reserveAnalysis(state, { kind: "manual" }, 4);
  assert.equal(run2.allowed, true);
  assert.ok(run2.token > run1.token);
  const newer = completeAnalysis(state, validPayload(), { now: 10, messageCount: 6, targetRoot: "/repo", token: run2.token });
  assert.equal(newer.accepted, true);
  const installedProposalId = state.pendingProposal.id;
  assert.equal(state.lastFinishedAnalysisToken, run2.token);

  // Run 1's delayed completion now fires. analyzing is false and
  // currentAnalysisToken is null, but its token predates the last finished
  // token, so it must be rejected as stale and leave run2's proposal intact.
  const stale = completeAnalysis(state, validPayload({ proposal: { title: "Stale clobber attempt" } }), { now: 20, messageCount: 6, targetRoot: "/repo", token: run1.token });
  assert.equal(stale.accepted, false);
  assert.equal(stale.stale, true);
  assert.equal(state.pendingProposal.id, installedProposalId);
  assert.equal(state.lastFinishedAnalysisToken, run2.token);
});

test("placement helper classifies global, plugin-local, repo-local, and unknown", () => {
  assert.equal(classifyPlacement({ path: "commands/self-evolve.md", surface: "global slash command docs" }), "global");
  assert.equal(classifyPlacement({ path: "opencode.json", surface: "global OpenCode config" }), "global");
  assert.equal(classifyPlacement("plugins/self-evolve/self-evolve.js"), "plugin-local");
  assert.equal(classifyPlacement("AGENTS.md", "/workspace/project"), "repo-local");
  assert.equal(classifyPlacement("docs/example.md", "/workspace/project"), "repo-local");
  assert.equal(classifyPlacement("commands/self-evolve.md", "/workspace/project"), "repo-local");
  assert.equal(classifyPlacement("src/app.js"), "repo-local");
  assert.equal(classifyPlacement(".env"), "unknown");
});

test("repo-local OpenCode convention paths validate when placement matches", () => {
  const state = createSessionState("s9", {}, 0);
  const agentsPayload = validPayload({
    proposal: {
      summary: "The transcript shows confusion about AGENTS.md project instructions, so clarifying that file would improve future command behavior.",
      evidence: ["The session discussed AGENTS.md instructions and how repo-local command behavior should be interpreted."],
      target: { path: "AGENTS.md", surface: "repo-local project instructions", symbol: "" },
      placement: "repo-local",
      suggestedAction: "Clarify the AGENTS.md instructions for repo-local self-evolve command behavior.",
    },
  });
  const docsPayload = validPayload({
    proposal: {
      summary: "The transcript shows confusion about the command behavior docs, so a command-behavior page would reduce future ambiguity.",
      evidence: ["The session discussed command behavior docs and where repo-local documentation should explain it."],
      target: { path: "docs/command-behavior.md", surface: "repo-local docs", symbol: "" },
      placement: "repo-local",
      suggestedAction: "Document the command behavior in docs/command-behavior.md for future repo-local reference.",
    },
  });

  assert.equal(validateAnalyzerPayload(agentsPayload, state, { targetRoot: "/workspace/project" }).ok, true);
  assert.equal(validateAnalyzerPayload(docsPayload, state, { targetRoot: "/workspace/project" }).ok, true);
});

test("bare self-evolve command parses as a manual scan", () => {
  assert.deepEqual(parseCommand(""), { verb: "scan" });
  assert.deepEqual(parseCommand("   "), { verb: "scan" });
  assert.deepEqual(parseCommand("status"), { verb: "status" });
});

test("absolute paths outside the target root are rejected, including sibling-prefix paths", () => {
  assert.equal(classifyPlacement("/workspace/project/src/app.js", "/workspace/project"), "repo-local");
  assert.equal(classifyPlacement("/workspace/project-evil/src/app.js", "/workspace/project"), "unknown");
  assert.equal(classifyPlacement("/workspace/other/src/app.js", "/workspace/project"), "unknown");

  const state = createSessionState("s10", {}, 0);
  const payload = validPayload({
    proposal: {
      target: { path: "/workspace/project-evil/src/app.js", surface: "repo docs", symbol: "" },
      placement: "repo-local",
    },
  });
  const validation = validateAnalyzerPayload(payload, state, { targetRoot: "/workspace/project" });
  assert.equal(validation.ok, false);
  assert.match(validation.reason, /outside safe placement scope/i);
});

test("non-POSIX-absolute paths (Windows/UNC/tilde) do not fall through to repo-local", () => {
  // POSIX path.isAbsolute() rejects these prefixes, so without the drive-letter/
  // UNC/tilde gate they would skip root-containment and be classified repo-local.
  assert.equal(classifyPlacement("C:\\Users\\evil\\app.js", "/workspace/project"), "unknown");
  assert.equal(classifyPlacement("c:/Users/evil/app.js", "/workspace/project"), "unknown");
  assert.equal(classifyPlacement("\\\\server\\share\\app.js", "/workspace/project"), "unknown");
  assert.equal(classifyPlacement("~/secrets/app.js", "/workspace/project"), "unknown");
  assert.equal(classifyPlacement("~", "/workspace/project"), "unknown");
  // Also rejected when no root is available to prove containment.
  assert.equal(classifyPlacement("C:\\Users\\evil\\app.js"), "unknown");
  assert.equal(classifyPlacement("~/secrets/app.js"), "unknown");

  // An analyzer declaring repo-local for a Windows-absolute target must not validate.
  const state = createSessionState("s-win", {}, 0);
  const payload = validPayload({
    proposal: {
      summary: "The transcript references a Windows path, but a drive-letter target should never be treated as repo-local.",
      evidence: ["The session mentioned C:/Users/evil/app.js while discussing repo-local edits and command behavior."],
      target: { path: "C:\\Users\\evil\\app.js", surface: "repo docs", symbol: "" },
      placement: "repo-local",
      suggestedAction: "Document the command behavior without editing any absolute out-of-root path.",
    },
  });
  const validation = validateAnalyzerPayload(payload, state, { targetRoot: "/workspace/project" });
  assert.equal(validation.ok, false);
  assert.match(validation.reason, /outside safe placement scope/i);
});

test("relative ../-escaping paths are rejected instead of falling through to repo-local", () => {
  // path.isAbsolute() is false for these, so before the unconditional
  // resolve+relative check they skipped the root-containment gate and were
  // classified "repo-local", letting a target escape the project root.
  assert.equal(classifyPlacement("../../etc/passwd", "/workspace/project"), "unknown");
  assert.equal(classifyPlacement("../sibling/src/app.js", "/workspace/project"), "unknown");
  assert.equal(classifyPlacement("src/../../escape.js", "/workspace/project"), "unknown");
  // Also rejected when no explicit root is supplied (resolves against cwd).
  assert.equal(classifyPlacement("../../etc/passwd"), "unknown");
  // A benign in-root relative path with interior ../ that stays contained is fine.
  assert.equal(classifyPlacement("src/util/../app.js", "/workspace/project"), "repo-local");

  // An analyzer declaring repo-local for a ../-escaping target must not validate.
  const state = createSessionState("s-rel-escape", {}, 0);
  const payload = validPayload({
    proposal: {
      summary: "The transcript references a relative escape path, but a ../ target should never be treated as repo-local.",
      evidence: ["The session mentioned ../../etc/passwd while discussing repo-local edits and command behavior."],
      target: { path: "../../etc/passwd", surface: "repo docs", symbol: "" },
      placement: "repo-local",
      suggestedAction: "Document the command behavior without editing any relative out-of-root path.",
    },
  });
  const validation = validateAnalyzerPayload(payload, state, { targetRoot: "/workspace/project" });
  assert.equal(validation.ok, false);
  assert.match(validation.reason, /outside safe placement scope/i);
});

test("unsafe target validation catches secret-like files and exposure actions", () => {
  for (const target of ["id_rsa", ".npmrc", "cert.pem", "debug.log"]) {
    assert.equal(isUnsafeTarget(target), true, `${target} should be unsafe`);
  }

  const state = createSessionState("unsafe", {}, 0);
  const secretTarget = validPayload({
    proposal: {
      summary: "The transcript discusses id_rsa handling, but secret files should never be proposed as targets.",
      evidence: ["The session mentioned id_rsa and credential handling in a repo-local context."],
      target: { path: "id_rsa", surface: "repo-local file", symbol: "" },
      placement: "repo-local",
      suggestedAction: "Document id_rsa handling without touching the private key file.",
    },
  });
  const secretResult = validateAnalyzerPayload(secretTarget, state, { targetRoot: "/repo" });
  assert.equal(secretResult.ok, false);
  assert.match(secretResult.reason, /secret|runtime|dependency|ignored/i);

  const exposureAction = validPayload({
    proposal: {
      summary: "The transcript discusses troubleshooting output, but the action asks to expose contents.",
      evidence: ["The session mentioned troubleshooting output and a request to paste private file contents."],
      target: { path: "docs/troubleshooting.md", surface: "repo-local docs", symbol: "" },
      placement: "repo-local",
      suggestedAction: "Print and paste the contents of id_rsa into the troubleshooting notes.",
    },
  });
  const actionResult = validateAnalyzerPayload(exposureAction, state, { targetRoot: "/repo" });
  assert.equal(actionResult.ok, false);
  assert.match(actionResult.reason, /sensitive file contents/i);
});

test("validateAnalyzerPayload rejects a target whose surface is only stop-words", () => {
  const state = createSessionState("stopword", {}, 0);
  // Path basename ("update") and surface ("repo local docs") are composed
  // entirely of QUALITY_STOP_WORDS, so targetTerms() returns []. The
  // evidence-to-target check must not be silently skipped in that case.
  const stopWordTarget = validPayload({
    proposal: {
      target: { path: "docs/update.md", surface: "repo local docs", symbol: "" },
      placement: "repo-local",
    },
  });
  const result = validateAnalyzerPayload(stopWordTarget, state, { targetRoot: "/repo" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /lacks a concrete term/i);
});


test("parseAnalyzerOutput extracts JSON wrapped in prose via brace extraction", () => {
  const wrapped = 'Here is my analysis:\n{"proposal":null,"reason":"No safe actionable proposal."}\nDone.';
  const result = parseAnalyzerOutput(wrapped);
  assert.equal(result.ok, true);
  assert.equal(result.value.proposal, null);
  assert.equal(result.value.reason, "No safe actionable proposal.");
});
