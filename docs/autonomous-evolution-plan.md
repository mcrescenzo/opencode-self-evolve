# Autonomous Skill Evolution: Evidence-Backed Design Plan

**Status:** Historical discussion draft. **Superseded for v0.3 by
`docs/autonomy-contract.md` (normative).**

**Date:** 2026-07-15

**Decision state:** This document does not authorize implementation. The
locked product/authority/privacy/lifecycle contract for v0.3 lives in
`docs/autonomy-contract.md`. Where this draft conflicts with the contract
(notably: project-local targets, unattended writes, the four rollout modes
manual/shadow/review/advisory, and "manual mode performs no durable writes"),
**`docs/autonomy-contract.md` wins**. This draft remains useful as
evidence-architecture background; it is not normative.

**Conflict summary (superseded statements):**
- Model-selected project-local targets -> superseded by exact operator-approved global roots.
- Unattended or retired `yolo` writes -> superseded by explicit approval for every Apply and Undo.
- "manual / shadow / review / advisory" four-mode progression -> superseded by
  project analysis modes Manual and Auto.
- "Manual mode performs no passive model calls or durable observation writes"
  -> refined: manual performs no *passive* calls or writes, but does write
  bounded structured observations *when `/self-evolve` is invoked*.

## Executive Summary

The proposed autonomous mode should be:

- **Autonomous about noticing:** it may observe opted-in OpenCode sessions in the background and record bounded, structured indications of recurring friction.
- **Conservative about generalizing:** deterministic policy must decide when observations are sufficiently independent, current, scoped, and well-supported to become a synthesis candidate.
- **Model-assisted about drafting:** a deny-all-tools synthesizer may compare eligible evidence with the current skill and draft the smallest warranted change.
- **Human-gated about mutation:** the plugin must not edit skills, invoke implementation agents, commit, publish, or otherwise apply a proposal. Implementation remains a separate explicit user action.

The central architectural change is to accumulate **observations rather than proposed edits**. A background observer should record claims such as:

> The user corrected the agent twice for removing a worktree before checking that it was clean.

It should not immediately conclude:

> Append this paragraph to the worktree skill.

Only after multiple independent observations satisfy deterministic eligibility rules should a synthesizer consider whether the current skill needs to be clarified, consolidated, shortened, split, or left unchanged.

The recommended pipeline is:

```text
opted-in session activity
  -> episode coordinator
  -> deterministic friction receipts
  -> bounded observer
  -> validated durable evidence ledger
  -> correlation and deterministic eligibility
  -> bounded skill inventory and current-content snapshot
  -> synthesizer
  -> deterministic validation and skeptic review
  -> advisory proposal or no-op
  -> explicit human implementation decision
  -> post-change intervention epoch
```

The initial autonomous scope should be limited to **global and repository-scoped OpenCode skills**. The existing manual scanner can continue to consider the broader set of tooling surfaces it supports today.

## Current Baseline

The current plugin is deliberately conservative:

- Analysis is triggered only by `/self-evolve` and `/self-evolve scan` through `command.execute.before`; there are no passive event or message-analysis hooks (`docs/internals.md`).
- State is session-local and in memory. It is cleared on plugin disposal (`self-evolve.js`, `self-evolve-core.js`).
- A scan reads a bounded, redacted transcript and excludes self-evolve-authored messages (`self-evolve-core.js`).
- The hidden analyzer runs at temperature zero, takes one step, and has all tools denied (`self-evolve.js`, `analyzer-prompt.js`).
- Analyzer output is schema-shaped and then validated locally for substance, target safety, path containment, placement, risk, confidence, and duplicate fingerprints (`self-evolve-core.js`).
- Proposals are advisory. The plugin does not edit files, invoke implementation tools, persist proposals, or mutate external systems.

These are useful foundations. Autonomous mode would nevertheless be a material change to the plugin's privacy and lifecycle contract because it introduces passive observation, background provider calls, and durable local state. It must therefore be a separately opted-in mode rather than an implicit extension of current behavior.

The following current invariants should remain unchanged:

- The entrypoint exports only the plugin function.
- The module-level runtime registry is created once and never reassigned.
- Analyzer and synthesizer sessions remain deny-all-tools.
- Untrusted model output never directly selects a writable path or performs an action.
- Manual mode remains available and remains the default.

The following current invariants would be deliberately revised for autonomous mode:

- Manual-only analysis.
- Session-local, in-memory-only evidence.
- At most one analysis stage directly producing one proposal.
- No passive lifecycle hook.

Those revisions require explicit user approval, updated documentation, migration-safe state handling, and new privacy controls.

## Goals

1. Detect recurring, reusable friction that may indicate a gap, ambiguity, conflict, or redundancy in an OpenCode skill.
2. Accumulate evidence across time without treating repeated model assertions as independent support.
3. Keep repository evidence isolated from other repositories and apply a stricter standard to global-skill proposals.
4. Prefer no change, deletion, consolidation, or replacement over append-only instruction growth.
5. Produce infrequent, auditable proposals tied to concrete observations and the exact skill version reviewed.
6. Keep background work bounded by explicit privacy, storage, cost, concurrency, and notification budgets.
7. Preserve an immediate pause, disable, inspection, export, and purge path.
8. Learn from accepted, dismissed, expired, and superseded proposals without creating a self-confirming feedback loop.
9. Make rollout outcomes falsifiable through precision, duplication, privacy, cost, and token-growth metrics.

## Non-Goals

The initial autonomous mode will not:

- Automatically edit any skill or other file.
- Invoke a coding agent, skill-authoring agent, workflow, shell command, or external tool to implement a proposal.
- Commit, push, publish, open issues, write to external trackers, or mutate remote systems.
- Persist complete transcripts.
- Treat model confidence as a calibrated probability or an authorization signal.
- Let a model determine consent, scope authorization, retention, independence, cross-repository promotion, or whether a proposal is applied.
- Automatically improve commands, agents, workflows, plugins, instructions, or project conventions. These may remain in the manual scanner until autonomous skill evolution proves reliable.
- Guarantee that a proposal is correct merely because it passed the evidence threshold.
- Optimize for proposal volume. A low proposal rate is expected and desirable.

## Design Principles

### 1. Observations are hypotheses, not facts

A model-generated observation is an interpretation anchored to source material. Its provenance must be retained, and it must not become established truth merely because another model repeats it.

### 2. Eligibility before scoring

Hard gates should decide whether a candidate is safe and sufficiently supported. A score may rank already-eligible candidates, but a high score must not compensate for missing independence, stale evidence, unresolved contradictions, scope leakage, or model-only support.

### 3. One incident contributes once

Retries, summaries, child sessions, delegated agents, compactions, forks, quoted output, and repeated observer passes can all describe the same underlying incident. They must not multiply the evidence count.

### 4. Scope is policy, not model judgment

The model may suggest that evidence appears repository-specific or globally reusable. Deterministic policy must authorize the actual scope. Repository evidence must never silently become global evidence.

### 5. Current content is part of the evidence

The synthesizer must review the exact current skill content. Every proposal must bind to a content hash and become stale if the skill changes before review.

### 6. No change is a successful result

Both the observer and synthesizer must be encouraged and allowed to return no observation or no proposal. Suppression is not a failure.

### 7. Instruction tokens must pay rent

More text is not automatically more useful. Every proposed addition must justify its ongoing context cost and identify what it replaces, consolidates, or makes unnecessary where possible.

### 8. Acceptance is not evidence

User acceptance means a proposal is worth trying. It does not prove that the change improved future behavior. Post-change outcomes belong to a new intervention epoch.

### 9. Fail closed

Ambiguous roots, corrupt state, unsupported lifecycle events, stale hashes, lock uncertainty, privacy classification failures, or budget exhaustion should suppress background work rather than weaken a gate.

## Domain Terms

- **Episode:** One logical user task or problem-solving attempt. Several OpenCode sessions or subagents may belong to the same episode.
- **Receipt:** A deterministic source artifact such as a user correction, tool invocation, tool result, command outcome, or host lifecycle event.
- **Observation:** A bounded structured claim, derived from one episode and anchored to one or more receipts.
- **Incident:** The underlying friction or failure represented by one or more correlated observations.
- **Evidence cluster:** A group of observations that may support or contradict the same normalized claim.
- **Exposure:** A relevant opportunity for a skill to have influenced behavior, when the host can identify one.
- **Candidate:** An evidence cluster that has not yet passed all synthesis eligibility gates.
- **Eligible candidate:** A candidate that passed deterministic scope, independence, quality, freshness, contradiction, privacy, and budget gates.
- **Proposal:** An advisory, evidence-linked skill change drafted against an exact current-content hash.
- **Intervention:** A skill version change that the user confirms was applied outside the background plugin.
- **Intervention epoch:** The period after an applied change during which new evidence is evaluated against the new skill version. Pre-change evidence cannot be reused to justify repeated patches.

## Proposed Architecture

### Runtime Registry

The existing module-level registry should remain responsible for transient runtime concerns:

- Session pause and disable state.
- In-flight job reservations.
- Temporary analyzer tokens.
- Per-process concurrency.
- Current command status.

The runtime registry should not become the durable evidence store and should not be serialized wholesale.

### Evidence Store

Introduce a separate, durable evidence-store module with a small interface. Conceptually, it should support operations such as:

```text
recordObservation(observation)
listObservations(scope, filters)
listEligibleCandidates(scope)
recordProposal(proposal)
recordProposalOutcome(proposalID, outcome)
markIntervention(target, contentHash, proposalID)
purge(scope)
```

The exact interface should remain smaller than the implementation. It should hide atomic writes, locking, schema versions, retention, deduplication indexes, and corruption recovery from hook and command callers.

### Episode Coordinator

The coordinator converts noisy runtime activity into one bounded observation opportunity per stable episode cursor.

Required behavior:

- Operate only when autonomous collection is explicitly enabled for the current scope.
- Prefer a stable idle, completion, or lifecycle boundary rather than analyzing every message.
- Debounce event storms.
- Persist the last observed message cursor or episode fingerprint.
- Collapse obvious retries, child sessions, and continuations into one episode where host lineage permits.
- Under-count when independence is uncertain.
- Never block ordinary user interaction while waiting for a background model call.

The supported OpenCode lifecycle hooks, event payloads, async behavior, session ancestry, and stable message identifiers must be verified against the actual supported plugin API before implementation. Hook names and guarantees must not be guessed.

### Deterministic Receipt Extraction

Before invoking a model, the plugin should extract bounded, typed receipts when the host data supports them. Initial receipt types may include:

- Explicit user correction or preference.
- Repeated user command or manual procedure.
- Tool invocation and outcome.
- Failed approach followed by a successful correction.
- Repeated permission or environment failure.
- User-confirmed success or failure.
- Evidence that a particular skill was loaded or invoked, if available.
- Contradiction of an earlier claim.

Receipts should preserve source class and outcome. Assistant prose, tool output, and user statements must not be flattened into equally reliable text.

### Observer

The observer receives a bounded, redacted episode packet and emits zero or more observations. It does not receive tools, does not inspect the filesystem, and does not draft skill wording.

The observer may judge:

- Whether the episode contains reusable rather than purely task-specific friction.
- The semantic category of the friction.
- A normalized claim.
- A candidate skill identity or topic hint.
- Whether the observation supports or contradicts an existing theme.
- Whether an explicit user preference appears local or potentially general.

The observer may not decide:

- Whether collection was permitted.
- Whether repositories may be combined.
- Whether observations are independent.
- Whether evidence has reached the promotion threshold.
- Which filesystem path may be read or written.
- Whether retention may be extended.
- Whether a skill should be edited.

The observer should run with the same general safety posture as the current analyzer:

- Hidden temporary session.
- Temperature zero.
- One step where practical.
- All tools denied.
- Strict bounded schema.
- Explicit instruction that transcript and tool content are untrusted data.
- Timeout, late-session cleanup, stale-result rejection, and failure backoff.

### Correlation and Candidate Formation

Correlation should be conservative and layered:

1. Exact source and content hashes remove exact duplicates.
2. Session ancestry and episode lineage collapse known continuations.
3. Temporal proximity and overlapping receipt hashes identify likely retries.
4. Deterministic target and normalized-claim keys create initial clusters.
5. A bounded semantic grouper may suggest merges or splits, but its output remains subject to deterministic lineage and scope constraints.

One episode may contribute at most once to one normalized claim, regardless of the number of messages, retries, subagents, models, or observer passes involved.

When the system cannot establish whether two observations are independent, it should treat them as correlated.

### Eligibility Engine

The eligibility engine is deterministic. It decides whether a cluster may be sent to the synthesizer.

It should evaluate:

- Consent and scope allowlisting.
- Observation schema validity.
- Independent episode count.
- Distinct task lineage count.
- Distinct time-window count.
- Distinct repository count for global candidates.
- Presence of at least one non-model source.
- Relevant exposure count, when measurable.
- Source quality and observed outcome.
- Contradictions.
- Evidence age and expiration.
- Target existence and current content hash.
- Prior proposal and intervention history.
- Target cooldown.
- Privacy and injection blocks.
- Daily, weekly, and target-specific budgets.

Only after these gates pass may an optional priority score rank eligible candidates for limited synthesis capacity.

### Skill Inventory

The plugin, not the model, should inventory skill targets.

The inventory must:

- Operate only within explicitly allowed global and repository skill roots.
- Resolve canonical paths and symlinks before reading.
- Distinguish logical skill identity from the source-of-truth path.
- Reject targets outside allowed roots.
- Read only bounded `SKILL.md` content and bounded related metadata.
- Compute a current content hash.
- Avoid exposing absolute repository paths in global evidence or proposals.
- Treat model target hints as suggestions, never path authorization.

Public package users may have different global config layouts. Initial implementation must not assume this development checkout's config topology. Allowed roots should come from verified host discovery or explicit configuration.

### Synthesizer

The synthesizer receives only:

- One eligible evidence cluster.
- Bounded current content for one selected skill or a bounded overlap set.
- The target content hash.
- Prior proposal outcomes relevant to the same theme.
- Token and change-shape budgets.
- A strict output schema.

It should be required to consider remedies in this order:

1. No change.
2. Delete obsolete guidance.
3. Consolidate duplicated guidance.
4. Clarify or replace existing wording.
5. Move procedural detail into a command, reference, or other more appropriate surface.
6. Add bounded guidance to an existing skill.
7. Propose a new skill under a stricter threshold.

The output should include:

- `changeKind`: `none`, `delete`, `consolidate`, `rewrite`, `add`, or `new-skill`.
- Target logical identity and exact current-content hash.
- Evidence observation IDs.
- A claim-to-evidence mapping.
- The smallest proposed replacement, diff, or new content.
- Content that would be removed or consolidated.
- Before and after character counts and approximate token counts.
- Expected behavioral effect.
- Possible overfitting and counterexamples.
- Conflicts or overlap with related skills.
- Risk and mitigation.
- One or more sanitized behavioral evaluation scenarios.
- A reason when no change is warranted.

The synthesizer remains deny-all-tools. It cannot discover files, edit files, launch agents, or override deterministic gates.

### Critic and Validation

Every non-null synthesis result should pass two forms of review.

#### Deterministic validation

- Schema and field bounds.
- Target identity and path containment.
- Current hash still matches.
- Evidence IDs belong to the eligible cluster.
- No expired or prohibited observation is cited.
- Global scope rules remain satisfied.
- No URLs, control characters, secret patterns, or unsafe instructions.
- Before/after size and token calculations are recomputed locally.
- Growth budget and pending-proposal limits are satisfied.
- Proposal fingerprint is not a duplicate.

#### Skeptic review

A separate deny-all-tools critic may assess:

- Whether the evidence actually supports the proposed rule.
- Whether the change is already covered.
- Whether the wording is overfit to one incident or repository.
- Whether a command, reference, code fix, or no-op is more appropriate.
- Whether the proposal creates instruction conflicts.
- Whether it can be made shorter.
- Whether cited counterexamples undermine the proposal.

Agreement between observer, synthesizer, and critic is quality control. It must never be counted as additional independent evidence.

### Proposal Queue and Digest

Proposals should be durable and move through an explicit lifecycle:

```text
draft
  -> pending-review
  -> accepted
  -> applied
  -> monitoring
  -> effective | ineffective | superseded

pending-review
  -> dismissed | snoozed | expired | superseded
```

Definitions:

- **Accepted:** The user agrees the proposal is worth implementing. No file is changed.
- **Applied:** The user or a separate explicitly authorized implementation flow changed the target, and the new hash is recorded.
- **Monitoring:** New observations are evaluated against the new skill version.
- **Effective:** Available post-change evidence supports the intended behavior, while acknowledging that absence of incidents may reflect lack of exposure.
- **Ineffective:** The same qualified incidents recur after sufficient relevant exposure.

Notifications should be delivered as a bounded digest, not one toast per observation. A recommended initial policy is no more than one new proposal notification per configured digest interval and one pending proposal per target.

## Evidence Model

### Observation Schema

The durable schema should be versioned. A representative shape is:

```json
{
  "schemaVersion": 1,
  "observationID": "obs-...",
  "createdAt": "2026-07-15T00:00:00.000Z",
  "expiresAt": "2026-10-13T00:00:00.000Z",
  "scope": {
    "kind": "repo",
    "scopeFingerprint": "..."
  },
  "episode": {
    "episodeID": "...",
    "taskLineageID": "...",
    "sessionIDHash": "...",
    "correlationGroup": "..."
  },
  "source": {
    "kind": "explicit-user-correction",
    "receiptHashes": ["..."],
    "outcome": "corrected-and-succeeded"
  },
  "signalType": "missing-guardrail",
  "normalizedClaim": "Agent omitted clean-worktree verification before removal.",
  "polarity": "supports",
  "targetHint": {
    "skillID": "git-worktree-conventions",
    "scope": "global"
  },
  "targetVersionHash": "...",
  "relevantOpportunityCount": 1,
  "privacyClass": "sanitized",
  "injectionFlags": [],
  "derivedFrom": [],
  "observer": {
    "promptVersion": "...",
    "model": "provider/model",
    "confidence": 0.78
  }
}
```

Model confidence is retained for calibration and debugging. It is not the primary eligibility signal.

### Source Quality

Sources should be classified rather than flattened into one score.

Stronger source classes include:

- Deterministic tool or command outcome.
- Explicit user correction, preference, or confirmation.
- Repeated user behavior or workaround with observable outcomes.
- Host-confirmed skill invocation or exposure, if available.

Weaker source classes include:

- Assistant assertion.
- Analyzer or observer inference.
- Unverified explanation of a failure.
- Quoted content from another session or document.

Model- or assistant-authored statements may help locate a candidate but cannot independently satisfy the evidence threshold.

### Independence

Independent support means distinct underlying episodes, not distinct messages or session IDs.

The following should normally count as one incident:

- Repeated retries in one task.
- Parent and child sessions addressing the same task.
- A compacted session and its continuation.
- Multiple agents discussing the same failure.
- A user quoting a prior observation.
- A self-evolve proposal and a later implementation discussion derived from it.

The following may count as independent when lineage and receipts support it:

- The same failure on unrelated tasks on different days.
- The same correction across separate repositories.
- A recurring workaround after a prior task was completed.
- A post-intervention recurrence against a new target hash.

### Contradictions

Observations may support or contradict a claim. Contradictions must not be averaged away.

Examples:

- A workaround initially appeared necessary but later proved incorrect.
- A user explicitly rejects a proposed convention.
- A tool failure was caused by transient infrastructure rather than missing skill guidance.
- A skill already contained the relevant instruction but was not loaded.

An unresolved material contradiction should block synthesis. The system may later reopen the cluster if new evidence resolves it.

### Freshness and Versioning

Evidence should expire or require revalidation when:

- The target skill content hash changes.
- The repository identity or relevant tooling changes materially.
- The observation exceeds its retention window.
- The observer schema or prompt changes in a way that invalidates prior interpretation.
- The user marks the observation obsolete or incorrect.

Old evidence may remain in an audit history after expiration, subject to retention settings, but it must not continue contributing to eligibility.

### Exposure Denominators

Raw incident count can be misleading. Where possible, eligibility and evaluation should consider:

```text
qualified incidents / relevant opportunities
```

Three incidents in three relevant uses differ from three incidents in five hundred. If skill exposure cannot be measured reliably, the denominator must remain unknown rather than being invented. Unknown exposure should reduce confidence in impact claims but need not erase strong repeated corrections.

### Provisional Eligibility Thresholds

These are starting hypotheses for shadow-mode calibration, not final truths.

#### Repository-scoped candidate

- At least three independent episodes.
- At least two task lineages.
- Evidence across at least two time windows or days.
- At least one explicit user or deterministic outcome source.
- No unresolved material contradiction.
- Current target exists and matches the reviewed hash.
- No privacy, injection, cooldown, or budget block.

#### Global candidate

- At least five independent episodes.
- Evidence from at least two repository scopes.
- Evidence across at least two time windows.
- At least one explicit user or deterministic outcome source in more than one scope, unless the user explicitly designated the preference as global.
- The normalized claim contains no repository-specific path, name, customer detail, or convention.
- All repository-scoped requirements also pass.

#### Explicit user direction

An explicit statement such as “make this a global rule” may reduce recurrence requirements, but it should not bypass privacy, target, contradiction, staleness, or human-review gates.

#### Rare high-impact incidents

A single verified security, data-integrity, or destructive-action incident may warrant an immediate manual-review alert. It should not silently lower the normal skill-change threshold or trigger unattended synthesis. Severity changes urgency, not evidence independence.

### Ranking Eligible Candidates

If more candidates are eligible than the synthesis budget allows, ranking may consider:

- Independent recurrence.
- Breadth across tasks and repositories.
- Source strength.
- Observed impact.
- Recency.
- Relevant opportunity rate.
- Expected instruction cost.
- Prior dismissal or unsuccessful intervention history.

The ranking formula should be simple, inspectable, and calibrated from shadow-mode outcomes. It should not be presented as a probabilistic confidence unless it has actually been calibrated.

## Preventing Runaway Skill Growth

### Replacement-First Contract

Every proposal must explicitly answer:

1. What behavior should improve?
2. Which evidence supports that behavior?
3. Is the behavior already covered?
4. Can existing wording be deleted, consolidated, or replaced?
5. Why is a skill the correct surface rather than a command, reference, code change, or no-op?
6. What is the smallest general rule that covers the evidence without encoding one incident?
7. What counterexample would make the rule harmful or overbroad?
8. What is the before/after token impact?

An append-only proposal that cannot answer these questions should be rejected.

### Token Budgets

Token counts can be approximated deterministically from characters when an exact tokenizer is unavailable, and must be labeled approximate.

Provisional policy:

- Emit a warning when an existing skill grows by more than 10% or roughly 100 tokens.
- Reject unattended synthesis drafts beyond a stricter configured maximum unless they also remove or relocate material and remain net-bounded.
- Require an explicit user override for larger changes.
- Apply a separate initial-size budget to new skills.
- Track average net token delta across accepted proposals.

The exact numbers should be calibrated. The invariant is more important than the initial threshold: the synthesizer must report and justify context growth.

### New-Skill Standard

Creating a new skill should require more evidence than revising an existing skill:

- The behavior recurs across multiple independent episodes.
- No existing skill is a coherent owner.
- The skill has a clear trigger-shaped routing description.
- The proposed interface is narrower than the repeated implementation complexity it hides.
- Overlap with global and repository skills has been checked.
- A bounded initial token budget is satisfied.
- The proposal identifies why a command, reference, or project instruction is insufficient.

### Cooldowns and Pending Limits

Recommended initial safeguards:

- One pending proposal per target.
- One active proposal per normalized theme.
- A target cooldown after dismissal or application.
- A longer cooldown after repeated dismissal for the same reason.
- A global maximum of new proposals per week.
- No new proposal against a target while an earlier intervention is still being monitored.

### Intervention Epochs

When a proposal is applied outside the plugin:

- Record the new skill hash.
- Close the supporting pre-change cluster for promotion purposes.
- Continue to retain its audit history under policy.
- Evaluate new incidents only against the new version.
- Exclude implementation discussions and proposal text from evidence.
- Require sufficient post-change exposure before calling the intervention effective or ineffective.

This prevents old evidence from financing an endless series of small patches.

## Privacy and Security

### Consent Model

Autonomous collection must be disabled by default.

Consent should distinguish:

- Background provider calls.
- Durable local observation storage.
- Retention of short sanitized evidence excerpts.
- Global versus repository-scoped collection.
- Cross-repository aggregation for global candidates.
- Cost and notification budgets.

Recommended mode progression:

- `manual`: current behavior only.
- `shadow`: collect observations; do not synthesize or notify.
- `review`: compute eligibility; synthesis remains an explicit command.
- `advisory`: eligible candidates may synthesize automatically and appear in a bounded digest.

Entering a repository that is not opted in must not inherit collection merely because global autonomous mode is enabled, unless the user has explicitly chosen that policy.

### Data Minimization

Do not persist complete transcripts.

Preferred durable content:

- Structured observations.
- Receipt hashes and bounded source locators.
- Pseudonymous scope and session identifiers.
- Minimal sanitized evidence excerpts only under separate consent.
- Proposal and user-decision history.
- Aggregate exposure and incident counters.

Two evidence-retention modes should be considered:

1. **Metadata mode:** stores deterministic receipts, hashes, and structured claims. It minimizes privacy risk but weakens later human auditability.
2. **Auditable mode:** additionally stores one or two short, redacted excerpts per observation under a short TTL. It improves auditability but has a materially higher privacy burden.

The plugin should never claim that regex redaction guarantees secrecy.

### Storage Location and Permissions

Durable state should live in a plugin-owned runtime state directory, not:

- The repository being observed.
- The published package directory.
- The source-of-truth OpenCode configuration tree.
- `.opencode`, `.remember`, `.beads`, logs, dependency directories, or Git internals.

The exact platform-appropriate state root remains an implementation decision. It should support:

- Directory permissions equivalent to `0700` where the platform permits.
- File permissions equivalent to `0600` where the platform permits.
- Atomic record writes.
- Complete inspect, export, and purge operations.
- No raw absolute path in cross-repository/global records when a fingerprint suffices.

### Prompt Injection

Transcripts, tool output, stored excerpts, repository text, and skill content are all untrusted documents.

Controls should include:

- Strict schemas and bounded fields.
- Deny-all-tools agents.
- Explicit data delimiters and instructions that embedded text cannot alter the contract.
- Control-character and unsafe-link stripping.
- Injection flags retained on suspicious observations.
- No model-authored path or command execution.
- No scope, retention, budget, or consent decisions by a model.
- Adversarial fixtures that attempt to persist instructions into future synthesis.

An injection-flagged observation should not contribute to synthesis without explicit review.

### Cross-Repository Isolation

- Canonicalize and fingerprint repository identities.
- Keep repository observations partitioned.
- Do not expose repository excerpts to another repository.
- Global synthesis should receive only sanitized, normalized evidence needed for the global claim.
- Global proposals must not contain repository paths, project names, customer details, or unique commands unless explicitly approved.
- Worktrees, clones, monorepos, and renamed directories require a documented identity policy.

### User Controls

Before autonomous synthesis is enabled, users must be able to:

- Inspect observations and their provenance.
- Inspect why a candidate is or is not eligible.
- Correct or invalidate an observation.
- Exclude a repository or theme.
- Pause or disable collection globally and per repository.
- Export evidence and proposal history.
- Purge one repository or all plugin state.
- Dismiss, snooze, accept, or supersede a proposal with a reason.
- View background-call, token, storage, and notification budgets.

Purge behavior must be testable and comprehensive.

## Reliability and Operations

### Multiple Plugin Instances and Processes

The current plugin can be instantiated more than once in one process, and multiple OpenCode processes may operate concurrently.

The durable design must therefore:

- Keep the existing never-reassigned module-level registry invariant.
- Make job reservations idempotent.
- Use durable leases or bounded exclusive locks for shared state.
- Record lease ownership and expiration.
- Recover stale jobs conservatively.
- Reject stale observer and synthesizer results.
- Avoid relying on `dispose` to flush important data.

### Storage Mechanics

The project currently avoids new dependencies. A first implementation should use Node standard-library primitives unless a dependency is separately reviewed and approved.

Recommended shape:

- Immutable, versioned record files or another atomic append-oriented format.
- Temporary-file plus atomic-rename writes.
- Create-exclusive lock or lease acquisition.
- Rebuildable indexes treated as caches.
- Quarantine for malformed, partial, or unsupported-version records.
- Bounded state-directory size and record count.
- Migration functions for supported schema versions.

A single large JSON document rewritten by concurrent processes should be avoided.

### Job Controller

The background controller should enforce:

- One process-local model call at a time by default.
- A durable reservation per episode or candidate.
- Observer and synthesizer timeouts.
- Late-created analyzer-session cleanup.
- Stale-token rejection.
- Exponential failure backoff.
- Daily and weekly call or token ceilings.
- A global circuit breaker after repeated failures.
- Quiet hours or digest-only notification behavior.
- Recovery of abandoned jobs without duplicate evidence.

### Cost Visibility

Autonomous mode changes provider-cost expectations. Status should report at least:

- Observer calls in the current day and week.
- Synthesizer and critic calls.
- Approximate tokens when the host exposes them.
- Suppressed jobs due to budget.
- Calls per accepted proposal.
- Current backoff or circuit-breaker state.

No background call should occur when its relevant budget is exhausted.

## Deterministic and Model-Judged Responsibilities

| Deterministic policy | Model judgment |
| --- | --- |
| Consent, allowlists, pause, disable, and purge | Whether an episode contains reusable friction |
| Event debounce, cursors, lineage, and exact deduplication | Semantic signal category and normalized claim |
| Repository identity and scope isolation | Candidate target hint |
| Independent episode and repository counts | Semantic clustering suggestions |
| Source classes, contradiction blocks, and expiration | Whether several eligible observations suggest one underlying gap |
| Retention, storage quotas, permissions, and migrations | Whether current wording is missing, ambiguous, conflicting, or redundant |
| Allowed roots, canonical paths, and target hashes | The smallest useful wording change |
| Cost, concurrency, notification, and cooldown budgets | Whether no change, deletion, consolidation, rewrite, or addition is best |
| Growth calculation and proposal field bounds | Overfitting and counterexample analysis |
| No-edit and no-implementation-agent boundary | Drafting advisory prose and behavioral scenarios |

Models must not override the deterministic side of this table.

## User Experience Requirements

Exact command names are provisional, but the interface should support these capabilities:

- Show current mode and consent state.
- Show background health, budgets, cooldowns, and last activity.
- List observations by repository, target, age, status, or theme.
- Explain an observation's source class and episode lineage.
- Explain candidate eligibility and which gates remain unmet.
- Run synthesis explicitly during the review rollout stage.
- List and inspect pending proposals.
- Dismiss with a structured reason such as incorrect evidence, duplicate, too narrow, wrong scope, already covered, or not worth token cost.
- Accept a proposal without applying it.
- Mark a separately implemented proposal as applied and record the new hash.
- Exclude a repository or normalized theme.
- Pause, resume, or disable collection globally and per repository.
- Export and purge state.
- Show a concise privacy explanation before enabling autonomous modes.

Observation collection should normally be silent. Only eligible proposals should become visible notifications, preferably through a digest.

## Acceptance Criteria for an Implemented Autonomous Mode

The feature should not be considered complete unless all of the following are demonstrably true:

1. Manual mode remains the default and performs no passive model calls or durable observation writes.
2. Autonomous collection requires explicit consent for each enabled scope.
3. The plugin analyzes no more than one stable cursor for one episode, despite duplicate lifecycle events.
4. Complete transcripts are never persisted.
5. Durable records are schema-versioned, bounded, atomically written, and subject to retention and storage quotas.
6. Retries, child sessions, summaries, and repeated observer passes for one episode contribute at most once to a claim.
7. Model- or assistant-only repetition cannot make a candidate eligible.
8. Contradictory or stale evidence blocks synthesis until resolved or revalidated.
9. Global candidates require deterministic cross-repository support or explicit user global designation.
10. Repository-specific data cannot appear in another repository's evidence view or an unauthorized global proposal.
11. Every proposal cites observation IDs and binds to the exact current skill hash.
12. A changed target hash invalidates a pending draft before it is presented as current.
13. Every proposal reports before/after size and approximate token delta and passes configured growth policy.
14. New-skill proposals pass stricter recurrence, overlap, routing, and token-budget gates.
15. Observer, synthesizer, and critic agents have all tools denied.
16. The plugin never edits a target skill or invokes an implementation agent in autonomous background flow.
17. Self-evolve output, proposal discussions, and implementation sessions cannot corroborate their own source evidence.
18. Daily and weekly cost limits, one-at-a-time concurrency, timeouts, backoff, and circuit breakers are enforced.
19. Users can inspect, correct, export, exclude, and comprehensively purge durable state.
20. Concurrent processes and crash recovery do not duplicate promoted evidence or corrupt the store.
21. Existing single-export and module-level registry invariants remain covered by tests.
22. Adversarial prompt-injection fixtures cannot alter scope, retention, target authorization, or action boundaries.

## Rollout Plan

### Stage 0: API Research and Offline Corpus

**Behavior**

- Verify supported OpenCode lifecycle hooks, event payloads, ancestry, stable message identifiers, async semantics, and cleanup behavior.
- Build synthetic and manually sanitized episode fixtures.
- Exercise receipt extraction, observer schemas, correlation, privacy filters, and injection resistance without durable user state.

**Success criteria**

- Duplicate retry and summary fixtures collapse to one incident at a predeclared target rate.
- Repository identity and scope are deterministic in fixtures.
- Secret canaries do not survive accepted redaction paths.
- Injection fixtures cannot influence policy fields.

**Stop criteria**

- No reliable lifecycle boundary exists.
- Repository or episode identity cannot be bounded safely.
- Passive hooks would materially block or destabilize normal interaction.

### Stage 1: Durable Shadow Observation

**Behavior**

- Explicit opt-in only.
- Persist validated observations under a short retention policy.
- Provide inspect, correct, exclude, export, and purge controls.
- No synthesis and no proposal notifications.

**Success criteria**

- No cross-repository reads in isolation tests.
- All seeded secret canaries are rejected or redacted according to policy.
- TTL deletion and complete purge pass clock-controlled tests.
- Storage remains below configured caps.
- Human review finds an acceptable observation precision on a predeclared sample.

**Automatic rollback criteria**

- Any sensitive canary is durably retained outside the accepted policy.
- Any observation is exposed to the wrong repository scope.
- Purge or retention fails.
- State grows without a bound.

### Stage 2: Automatic Eligibility, Manual Synthesis

**Behavior**

- Compute evidence clusters and eligibility automatically.
- Explain which gates passed or failed.
- Require an explicit synthesis command.
- Store drafts for review; do not notify automatically.

**Success criteria**

- Correlated observations contribute at most once.
- Model-only evidence never changes eligibility.
- Eligible candidates cite the correct independent episodes.
- Stale target hashes suppress synthesis.

**Rollback criteria**

- A candidate is promoted solely through model repetition.
- Correlation inflation exceeds the predeclared tolerance.
- Scope or contradiction gates can be bypassed.

### Stage 3: Silent Automatic Synthesis

**Behavior**

- Automatically synthesize eligible candidates within strict budgets.
- Run deterministic validation and skeptic review.
- Store accepted drafts silently.
- Surface counts in status but do not interrupt the user.

**Success criteria**

- A strong majority of drafts are judged evidence-linked and non-duplicative in blinded review.
- Every draft satisfies target-hash and growth-budget checks.
- Background call and token budgets are respected.
- No model session is orphaned in timeout fixtures.

**Rollback criteria**

- A draft cites unrelated or expired evidence.
- A prompt-injection fixture affects a draft's target or authority.
- Background work breaches cost or concurrency budgets.

### Stage 4: Repository-Scoped Advisory Digest

**Behavior**

- Notify users of infrequent repository-scoped proposals in a digest.
- Support dismissal reasons, snoozing, acceptance, and exclusion.
- Continue to prohibit file mutation.

**Success criteria**

- Proposal usefulness meets a predeclared target over a meaningful sample.
- Duplicate, redundant, privacy-sensitive, and wrong-scope rates remain below their thresholds.
- Notification limits are never exceeded.
- Average accepted proposal has bounded or negative net token growth, or an explicit justified exception.

**Rollback criteria**

- A privacy-sensitive proposal is surfaced.
- Usefulness remains below the rollback threshold for two review windows.
- Notification fatigue or disable rates exceed the configured threshold.

### Stage 5: Global-Skill Advisory Digest

**Behavior**

- Permit global candidates only after cross-repository eligibility.
- Remove repository-identifying details from synthesis inputs and outputs.
- Require explicit user review for every proposal.

**Success criteria**

- Every global candidate has qualifying evidence from the required scopes or explicit global designation.
- No repository-specific data appears in a global proposal.
- Global proposals show stronger acceptance and lower wrong-scope rates than the configured minimum.

**Rollback criteria**

- Any repository-specific detail leaks into an unauthorized global proposal.
- A single-repository pattern is promoted globally without explicit override.
- Scope isolation is ambiguous.

### Stage 6: Explicit Implementation Handoff

**Behavior**

- An accepted proposal can produce a bounded handoff for the normal skill-authoring and Git workflow.
- Implementation occurs only after a separate explicit user request and outside the autonomous background controller.
- Applied hashes and intervention epochs may be recorded afterward.

**Success criteria**

- The handoff identifies exact evidence, target hash, proposed replacement, token delta, validation scenarios, and rollback path.
- No unattended file mutation occurs.
- Post-change evidence cannot reuse the pre-change cluster for another patch.

This plan intentionally stops short of unattended application.

## Evaluation Metrics

Metrics should favor precision, safety, and compression rather than activity.

### Observation quality

- Percentage of sampled observations judged genuinely grounded in their cited receipts.
- Percentage judged reusable rather than task-specific.
- Incorrect scope rate.
- Duplicate or correlated-observation inflation rate.
- Contradiction detection rate on labeled fixtures.

### Proposal quality

- Acceptance, dismissal, expiration, and supersession rates.
- Dismissal reasons.
- Percentage of proposals already covered by the target skill.
- Percentage judged overfit or redundant.
- Average and distribution of net token delta.
- New-skill proposal rate.
- Proposals per eligible evidence cluster.

### Outcome quality

- Qualified incident rate before and after an applied intervention, normalized by relevant exposure when measurable.
- Repeated correction rate after intervention.
- Rollback or supersession rate.
- Time and exposure required before an intervention can be assessed.

### Operational quality

- Observer, synthesizer, and critic calls per accepted proposal.
- Approximate tokens and cost per accepted proposal.
- Background failure, timeout, and orphan-session rate.
- Storage size and retention compliance.
- Purge success rate.
- Cross-scope contamination count, with a target of zero.
- Retained secret-canary count, with a target of zero.

Acceptance is not proof of effectiveness, and absence of later incidents is not proof when exposure is unknown.

## Test Strategy

### Pure unit tests

- Schema validation and field bounds.
- Option resolution and mode defaults.
- Scope fingerprints and target identity.
- Exact deduplication and correlation rules.
- Independent episode counts.
- Eligibility gates and ranking.
- Contradiction and expiration behavior.
- Growth and approximate token calculations.
- Proposal lifecycle and intervention epochs.
- Redaction, control-character stripping, and injection flags.

### Temporary-filesystem tests

- Atomic record writes.
- Lock and lease contention.
- Stale-lock recovery.
- Index rebuild.
- Schema migration.
- Corrupt-record quarantine.
- Retention and complete purge.
- Permissions where the platform supports assertions.
- Storage quota enforcement.
- Concurrent-process simulation.

### Mocked OpenCode integration tests

- Duplicate lifecycle events.
- Idle/completion episode scheduling.
- Parent and child session correlation.
- Background call budgets.
- Pause or disable during in-flight work.
- Timeout followed by late analyzer-session creation.
- Stale result rejection.
- Self-evolve message and implementation-session exclusion.
- Observer, synthesizer, and critic tool denial.
- Target changes between synthesis and review.

### Adversarial fixtures

- Transcript instructions attempting to change schemas or authorize edits.
- Tool output containing fake evidence records.
- Repository content asking for global promotion.
- One task split across many sessions and agents.
- Repeated summaries of one incident.
- Cross-repository names and paths embedded in observations.
- Conflicting observations.
- Old evidence against a new skill hash.
- Self-evolve proposals quoted into later sessions.
- Secret and credential canaries.
- Corrupt and newer-version state.

### Package and runtime checks

Continue to run the repository's existing gates:

```sh
npm test
npm run check
npm run pack:check
npm run smoke:live
```

The live smoke should remain token-free where possible and verify startup loading, hook registration, deterministic controls, and absence of unintended mutation. Provider-backed semantic quality should be evaluated through explicitly approved fixtures or local review rather than silently spending tokens in ordinary tests.

Because plugins load at OpenCode startup, implementation-time runtime verification must use a fresh OpenCode process after each config-time or plugin-load change.

## Implementation Slices

These slices are proposed for later review. They should not be converted into implementation work until the open privacy, storage, lifecycle, and threshold decisions are approved.

### Slice 1: Lifecycle and Identity Research

- Verify supported passive hook and session APIs.
- Define episode, task lineage, repository, worktree, clone, and monorepo identity behavior.
- Produce fixtures for known lifecycle shapes.
- Stop if safe non-blocking observation cannot be supported.

### Slice 2: Pure Evidence Domain

- Add versioned observation, cluster, candidate, proposal, and intervention schemas.
- Implement deterministic source classes, correlation, contradiction, expiration, and eligibility logic.
- Add adversarial and boundary unit tests.
- No runtime hooks or persistence yet.

### Slice 3: Durable Store and Privacy Controls

- Implement atomic records, leases, indexes, migrations, quotas, retention, inspect, export, and purge.
- Add scope isolation and temporary-filesystem tests.
- No provider calls yet.

### Slice 4: Shadow Episode Observer

- Add explicit mode and repository consent.
- Add bounded lifecycle scheduling, receipt extraction, observer calls, and validated persistence.
- Provide status and observation inspection.
- No synthesis.

### Slice 5: Candidate Eligibility and Explanations

- Form clusters and compute deterministic eligibility.
- Expose why each candidate passed or failed.
- Calibrate provisional thresholds from shadow data.

### Slice 6: Manual Synthesis

- Add deterministic skill inventory and content hashes.
- Add deny-all-tools synthesis, local validation, growth budgets, and skeptic review.
- Require an explicit command.
- No automatic notifications or edits.

### Slice 7: Silent Automatic Synthesis

- Add background synthesis reservations, budgets, backoff, and circuit breakers.
- Persist drafts without notifying.
- Measure proposal quality and cost.

### Slice 8: Advisory Digests

- Add bounded repository-scoped notifications and proposal outcomes.
- Add global aggregation only after repository mode meets its gates.
- Keep implementation separate.

### Slice 9: Intervention Monitoring

- Record externally applied hashes.
- Start intervention epochs.
- Add exposure-aware post-change monitoring and regression scenarios.
- Prevent pre-change evidence reuse.

### Slice 10: Public Documentation and Release Hardening

- Update README, configuration, internals, security, privacy, package checks, and live smoke.
- Document exact storage paths, retention, provider usage, costs, and purge behavior.
- Preserve manual-mode compatibility and restart guidance.

## Open Decisions

1. **Evidence excerpts:** Should autonomous mode persist one or two short redacted excerpts for auditability, or only structured claims and hashes?
2. **Storage root:** Which platform state directory is correct for public package users, and should it be configurable?
3. **Lifecycle trigger:** Which supported OpenCode event best represents a stable episode without blocking user activity?
4. **Repository identity:** How should clones, worktrees, monorepos, renamed directories, and remotes affect independence and scope?
5. **Exposure:** Can OpenCode reliably report which skills were loaded or invoked so incident rates have a denominator?
6. **Thresholds:** What recurrence, time-window, and cross-repository counts produce acceptable precision in shadow mode?
7. **Retention:** How long should structured observations, optional excerpts, proposals, and intervention history survive?
8. **Models and budgets:** Should observer, synthesizer, and critic use one configured model or separate cost/quality tiers?
9. **Global consent:** Is cross-repository aggregation a separate opt-in from repository observation?
10. **Large changes:** What growth threshold requires explicit override, and when should the system recommend a reference or split instead?
11. **Implementation handoff:** How should an accepted proposal enter the normal skill-authoring workflow without making the background plugin an executor?
12. **Effectiveness:** What minimum post-change exposure is required before an intervention can be judged?

## Recommended Initial Decisions

For a first implementation proposal, the recommended defaults are:

- Preserve `manual` as the default mode.
- Require repository opt-in for background collection.
- Require a separate opt-in for cross-repository/global aggregation.
- Begin with global and repository-scoped skills only.
- Analyze at stable idle or completion boundaries, never every message.
- Persist no complete transcripts.
- Offer metadata-only and short-lived auditable-excerpt modes, with the latter requiring explicit consent.
- Use deterministic eligibility gates before any score.
- Require at least three independent repo episodes and five cross-repository episodes for global synthesis as shadow-mode starting points.
- Require at least one explicit user or deterministic outcome source.
- Allow one model call at a time and configure hard daily and weekly ceilings.
- Permit one pending proposal per target and use target cooldowns.
- Prefer deletion, consolidation, and replacement over additions.
- Report and cap net token growth.
- Keep automatic synthesis silent before enabling digests.
- Never apply changes in the autonomous background controller.
- Treat every applied skill hash as a new intervention epoch.

## Decision Checkpoint

Before implementation, review and explicitly approve:

1. The consent and privacy model.
2. Whether short evidence excerpts may be stored.
3. The storage location and retention policy.
4. Repository and global identity rules.
5. Provisional eligibility and token-growth thresholds.
6. The staged rollout and rollback criteria.
7. The permanent no-auto-apply boundary.

Only after those decisions are settled should the implementation slices be refined into executable work.
