# Changelog

All notable public changes to `@mcrescenzo/opencode-self-evolve` will be
recorded here.

This project follows semantic versioning after the first public release.

## 0.3.0 — global-first cross-project recommendations

- **Breaking:** autonomous targets are global only. Project analysis produces
  privacy-safe global contributions, candidates, and recommendations against
  operator-approved global skill collections; repository-local `.opencode/skills`
  are never autonomous targets, and the durable cycle no longer creates project
  proposals. Existing project proposals stay readable, exportable, rejectable,
  and purgeable.
- **Breaking:** the `yolo` mode is retired. Project analysis is exactly `manual`
  or `auto`, neither carries write authority, `/self-evolve yolo ...` and
  `repo yolo` are refused, a bridge peer that requests `yolo` is rejected with
  `yolo-retired`, and a stored v0.2 `yolo` preference narrows to `auto`.
- **Breaking:** the durable state generation is `0.3.0`. Partitions written by
  `0.2.0`, `0.2.1`, and `0.2.2` are migration input only: they are read,
  re-stamped once, and never written again. Migration carries forward consent,
  budgets, retention, pause, kill switch, and allowlist suggestions, and never
  promotes legacy claims or proposals into global authority.
- Bridge, projection, dashboard, operation, feedback, and transaction protocols
  are versioned independently of the state generation. The control state now
  publishes the bridge wire version rather than the state generation.
- Added the state-root-wide Global Recommendation Index, its mailbox, and
  cross-project Apply/Reject/Undo with fresh nonce-, version-, and hash-bound
  operator decisions plus state-root-wide target leases.
- Added project-local evidence capsules, identity-free global contributions,
  support-set eligibility (single-domain and distributed routes with
  unknown-lineage anti-inflation), and bounded ephemeral synthesis packets.
- Added the complete consent, retention, purge, quota, and export lifecycle for
  global state, including scoped global-recommendation purge, quota reclamation,
  and idempotent crash recovery at every durable boundary.
- Hardened multi-process behavior: canonical contribution counts, one synthesis
  per support set, one mailbox outcome, serialized target writes, budget and
  storage-quota races, dead-owner lease recovery, and fault injection across
  contribution, candidate, attempt, content, decision, temp-write, rename/link,
  readback, response, purge, and projection boundaries.
- Native control center is global-first: one state-root-wide recommendation
  runtime with project-scoped status, participation, and Manual/Auto controls.

## Unreleased

- **Breaking v0.4:** replaced Manual/Auto, project/repository modes, ordinary Pause/Resume, separate passive-call consent, manual scan, the v0.1 analyzer, and `durableAutonomy: false` with one state-root-global Automatic recommendations On/Off preference. Fresh, valid legacy-migrated, and authenticated-reinitialized installations start On with the three required data permissions enabled; malformed authority opens Off.
- Added a separate cross-process automation epoch. Every accepted On/Off transition and required-permission revocation advances it exactly once; Off fences late work, supersedes only unfinished pre-recommendation state, preserves published recommendations, and establishes a future-only no-backfill boundary.
- Existing global skills are discovered without Self-Evolve root setup from agreeing OpenCode global path/config/resolved-skill projections. Project, remote, embedded, cache, ambiguous, malformed, symlinked, unsafe, or drifted targets fail closed. New-skill placement still requires one explicit creation root.
- Kept Apply, Reject, and exact Undo operator-initiated and independent of the automation preference. Privacy revocation blocks Apply but preserves Reject/Undo; restored privacy may restore Apply while automation remains Off; Emergency Stop and breaker state cannot strand exact risk-reducing Undo.
- Advanced writable state/package/TUI generation to `0.4.0`. Retained global recommendation/action and project-participation version-1 tuples remain exact, while the breaking settings/dashboard plane negotiates its own v0.4 capability; mixed v0.3/v0.4 peers are read-only limited and old writable requests are rejected rather than reinterpreted.
- Made `npm run audit:dependencies` a mandatory publication gate: `npm run pack:check` and the release-artifact script both run it before any pack or publication-capable operation, and a failing audit fails the pack/release closed.
- Fixed dependency-audit exception handling so a `reviewDate` after the evaluation date (today) is rejected. The `reviewDate` is the calendar date the owner actually reviewed the live advisory, dependency path, and applicability; a future `reviewDate` defeated mandatory periodic review. Existing and new exceptions must keep `reviewDate` on or before today and `expiresOn` on or after `reviewDate`. The evaluation date remains injectable through `evaluateAudit({ today })` and `validateException(record, disposition, today)` for tests.
- Aligned public documentation with v0.3 Manual/Auto project-analysis semantics, the `24576` `tokensPerSynthesis` default (matching `DEFAULT_BUDGETS` and `MIN_TOKENS_PER_SYNTHESIS`), and the correct restart rule: Manual/Auto mode switches are runtime and do not require restart, while plugin registration and `opencode.json`/`tui.json` configuration edits still do.
- Fixed native control-center crashes when optional dashboard fields such as the last-cycle outcome are absent. The deterministic prebuilt target now uses OpenTUI's supported Solid transform, guards nullable branches, and is exercised as a real reactive render in both local regression coverage and every supported packed-consumer lane.
- Replaced the public raw-TSX TUI export with a deterministic prebuilt JavaScript artifact generated before pack. Host-owned OpenTUI, Solid, and OpenCode TUI modules remain external; repeated builds are byte-identical; stale or bundled artifacts fail package checks; consumer install hooks remain absent.
- Led installation guidance with OpenCode's native `opencode plugin` installer and corrected manual TUI registration to use the bare package or source package root. Legacy `/tui`, raw TSX, and helper-file registrations require an explicit one-entry migration; Self-Evolve does not silently edit external configuration.
- Added a packed compatibility matrix for OpenCode 1.18.3, 1.18.4, and the latest common 1.18.x host across OpenTUI 0.4.5 and 0.5.0, with an explicit 0.6.x peer rejection, plus a wrapper for the no-witness two-plugin OpenCode Workflows coexistence gate.
- **Breaking:** raised the supported Node.js runtime floor from `>=20.11.0` to `>=22.11.0`; CI now validates the supported Node.js 22 and 24 lines.
- Rebuilt the native control center around exactly four sections—Home, Recommendations, Activity, and Settings—with one server-derived operational model shared by the header, persistent sidebar entry point, and Home. Sidebar activation now deep-links setup, recommendation, failure, and healthy/startup states to their exact mounted destinations without a separate review dialog.
- Added optional additive `dashboard-v1` readiness, actual-usage, privacy-safe semantic activity, and diagnostics projections beside the unchanged core review index. Missing, malformed, and mixed-version enhanced data degrades to an explicit limited view without granting authority or hiding valid core reviews.
- Turned Recommendations into the complete queue/detail/action workspace, including lifecycle filters, inline outcomes, acknowledge/undo, and capability-gated structured rejection feedback that remains audit-only.
- Made Settings self-explanatory with human mode cards, global/project/effective scope, capability-gated repository mode overrides, consent dependencies, a canonical one-folder-per-row approved-root editor, actual-versus-configured limits, and scoped maintenance with existing exact-confirmation and accepted-terminal purge safety.
- Added the bounded Activity history and diagnostics surface. It maps only allowlisted semantic events, excludes diagnostic entries from the default filter, and provides no raw-log or arbitrary-audit-detail view.
- Fixed Escape from the full-screen control center by registering it as a mode-scoped key binding, so focused tabs, buttons, inputs, and the scroll view cannot strand the user outside the agent session.
- Derived production host compatibility after factory return instead of hardcoding 1.18.3. Startup prefers `client.global.health()`, falls back only on recognized transport/capability failures to exact-origin GET `/global/health` from official `PluginInput.serverUrl`, and can consume a separately registered package TUI target's short-lived effective-UID-owned, exact-mode, same-account-live-publisher/root/project-bound relay of official `api.app.version` when embedded hosts expose neither route. Redirects and every other responding HTTP failure remain authoritative. Every root kind still waits for official root validation and stable `>=1.18.3 <1.19.0` compatibility before integration boot. Provisional persisted-auto/yolo hooks have no authority while pending and remain inert on failure.
- Made ordinary string package registration boot durable v0.2 in fail-closed manual mode; `durableAutonomy: false` is now the explicit legacy v0.1 compatibility switch.
- Startup now awaits durable boot and persisted effective-mode resolution before returning hooks, so options-free restarts register passive events for stored auto/yolo and omit them for manual or failed/corrupt startup. Startup `mode` no longer overrides durable preferences.
- Unified server/TUI identity through one validated resolver using explicit fingerprint, shared plugin `remoteUrl`, and supported OpenCode worktree/directory inputs; conflicting identities fail closed.
- Added the exact one-use auto headless approval command, bound to the current proposal ID, target hash, proposed-content hash, decision version, and server-issued nonce; malformed, stale, mismatched, manual-mode, and replayed approvals fail closed.
- Completed cross-process state, retention, persisted yolo rollout evidence, and production filesystem TUI mailbox remediation.
- Expanded the no-external-token OpenCode smoke to compare `opencode --version`, official global health, and the plugin-reported running version while covering durable boot, state layout, retention, mode commands, passive-hook registration, mailbox lifecycle, exact temporary-skill application, cleanup, and explicit live-host versus in-process evidence. A fresh direct-registration child now executes `/self-evolve health` through the production session-command endpoint with a loopback mock provider instead of treating registry presence as execution proof.
- Reconciled package contents, configuration examples, migration/restart guidance, privacy/security claims, and dual-target verification. Deterministic target/store/integration coverage is kept distinct from exact-host interactive evidence.
- Replaced split proposal-CAS/decision appends with a hash-bound recoverable store transaction. Boot repairs intent-only, proposal-only, or decision-only crashes idempotently; apply failures become visible critical `failed-closed` records without Apply authority.
- Added exact `must-not-exist` schema support and removed empty new-target reservation. New skills are fully validated in a same-directory temp and atomically published create-exclusively with a hard link, with process-kill and concurrent-collision coverage.
- Added strict `synthesis-attempt` admission before provider calls, non-actionable `critic-pending` drafts, one-outcome boot recovery, and active-only cluster suppression. Real SIGKILL fixtures cover admission, provider return, draft append, critic transition, content persistence, and outcome append.
- Replaced free-form proposal body audits with hash-bound typed content chunks. Active bodies survive retention; terminal transitions and proposal purge compact them under the recoverable decision transaction, and inbox/export readers reject mixed, cross-proposal, duplicate, partial, or hash-invalid chunks.
- Hardened the filesystem bridge to one canonical state-root boundary with component-by-component symlink/containment checks, `O_NOFOLLOW` final reads, inode/link-count validation, create-exclusive publication, and equally strict cleanup/lock recovery.
- Added a separate authenticated control mailbox and strict read-only control-state projection. The server now applies exact mode, consent, repository-exclusion, and elevated allowlist controls through locked settings updaters with settings-hash/`updatedAt` binding and one-use nonce replay protection.
- Bounded concurrent decision/control/operation mailbox publication with a shared project lock, file cap, quota-derived byte budget, response reservation, and store-capacity reserve; `export all` now includes separately classified and bounded metadata for every request/response/control-state class.
- Replaced the migration settings surface with a sidebar-first native control center; Release B consolidates the initially introduced Release A destinations and review dialog into the current four-section mounted workflow.
- Added native apply/reject, exact-duration snooze, guarded rollback, pause/resume, kill switch, scoped purge, bootstrap retry, sensitive export, and accepted-terminal purge-all operations through target-derived one-use grants. All flows keep status in-dialog and use explicit confirmations for destructive or authority-expanding actions.
- Added bounded read-only evidence inspection and short-lived private export artifacts with exclusive permissions, fixed artifact/temporary quotas, hashes, expiry metadata, cleanup, and no automatic opening.
- Added process-aware apply and synthesis leases. Boot now defers live-owner work without false rollback or failed-closed transitions, reclaims dead owners idempotently, and preserves expiry migration for legacy PID-less leases.
- Restored hard-crash hidden-session cleanup as a bounded asynchronous post-start phase with selective self-evolve-only aborts, timeout/retry/backoff health reporting, idempotence, and disposal cancellation.
- Unified server/TUI state-root precedence around official host paths, moved the potentially self-blocking 1.18.3 path SDK check into bounded post-start validation, prohibited provisional store writes, and bound canonical root identity into the TUI control projection. Official/environment disagreement now suspends authority and requires explicit configuration plus restart.
- Made `passiveCallsPerHour` a hard cross-process rolling-hour ceiling on actual passive hidden provider invocations. Eligible auto/yolo synthesizer and critic calls each reserve and audit one slot at their own dispatch boundary; deterministic no-call paths and manual scans remain outside this budget.
- Made the scheduler the sole normal owner of fulfilled/rejected work settlement, keyed by session and lease identity, so rejection, late completion, and downgrade races cannot double failure accounting or release newer work.
- Made terminal post-approval yolo application failures durably `failed-closed`, while live-owner lease contention remains an explicit approved deferral and pre-approval authority denial remains pending review.
- Bound decision/control completion audits to the complete normalized mailbox envelope. An identical retry after response-publication failure now republishes the original accepted or rejected outcome without repeating side effects; altered envelopes and nonce reuse still fail closed.
- Removed content-free scheduler `session-status`/`busy` audit writes and made the first startup retention sweep drain that exact historical backlog. Retry, compaction, cleanup, decision, apply, rollback, nonce, and CAS audits retain their normal window.
- Reduced durable-store and idle-mailbox stalls with exact-source-byte JSONL parse caching, source-reusing atomic appends, no-op retention write elision, legacy-migration memoization, bounded request peeking, and one settings snapshot per mailbox pass.

## 0.2.0 - 2026-07-22

- Added the shared autonomy pipeline with `manual`, `auto`, and `yolo` modes, identical evidence thresholds, durable structured observations, deterministic correlation, hidden synthesis and critic review, and a conservative scheduler.
- Added a native TUI review target, durable headless inbox, compare-and-swap decisions, privacy/retention/export/purge lifecycle, and a transactional hash-bound skill applier with audit and rollback support.
- Added release gates, budgets, consent controls, canonical allowlists, emergency kill switches, crash recovery, and an adversarial hardening campaign covering concurrency, injection, stale hashes, quota exhaustion, and rollback failure.
- **Breaking:** raised the supported OpenCode host range to `>=1.18.3 <1.19.0` and the optional `@opencode-ai/plugin` peer contract to `~1.18.3`.
- **Breaking:** the package is now dual-target, exporting the headless-safe server plugin at `.` and the native review module at `./tui`.

## 0.1.2 - 2026-07-08

- Fixed the documented supported opencode CLI range to `>=1.17.7` (was
  `>1.17.7`, which wrongly excluded the verified 1.17.7 floor itself).
- Documentation-only release otherwise: README rewritten to lead with the use
  case, adds a worked `/self-evolve scan` proposal example and a "For AI
  agents" note; configuration trimmed to the common tunables with the full
  table in `docs/configuration.md`; internals moved to `docs/internals.md`.
  No runtime changes.

## 0.1.1 - 2026-07-07

- Added automated npm releases: pushing a version bump to `main` now publishes
  to npm via GitHub Actions using npm trusted publishing (OIDC) with provenance,
  then tags the commit and creates a GitHub Release.

## 0.1.0 - 2026-07-07

- Initial public package metadata for the manual self-evolve opencode plugin.
- Manual scan command with hidden analyzer session, transcript redaction, proposal validation, deterministic advisory output, and optional TUI toast.
- Session-local in-memory controls for status, pause, resume, disable, and dismiss.
- Fixed a module-level registry reassignment bug where a second plugin factory instantiation (opencode's documented double-instantiation) would silently discard all in-memory session state; the registry is now created once and never reassigned.
