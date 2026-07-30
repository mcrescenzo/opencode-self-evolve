# Changelog

All notable public changes to `@mcrescenzo/opencode-self-evolve` will be
recorded here.

This project follows semantic versioning after the first public release.

## Unreleased

- Made the native sidebar indicator persistent and clickable in startup and healthy-empty states. Its muted mode/status summary opens the control center, while review, audit, failure, and operation states retain their stronger contextual summaries and existing navigation.
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
- Replaced the migration settings surface with a sidebar-first Release A experience: a status/attention card, native review dialog, and `self-evolve.control-center` palette command covering overview, reviews, settings, safety, evidence, health/budgets, maintenance, and help.
- Added native apply/reject, exact-duration snooze, guarded rollback, pause/resume, kill switch, scoped purge, bootstrap retry, sensitive export, and accepted-terminal purge-all operations through target-derived one-use grants. All flows keep status in-dialog and use explicit confirmations for destructive or authority-expanding actions.
- Added bounded read-only evidence inspection and short-lived private export artifacts with exclusive permissions, fixed artifact/temporary quotas, hashes, expiry metadata, cleanup, and no automatic opening.
- Added process-aware apply and synthesis leases. Boot now defers live-owner work without false rollback or failed-closed transitions, reclaims dead owners idempotently, and preserves expiry migration for legacy PID-less leases.
- Restored hard-crash hidden-session cleanup as a bounded asynchronous post-start phase with selective self-evolve-only aborts, timeout/retry/backoff health reporting, idempotence, and disposal cancellation.
- Unified server/TUI state-root precedence around official host paths, moved the potentially self-blocking 1.18.3 path SDK check into bounded post-start validation, prohibited provisional store writes, and bound canonical root identity into the TUI control projection. Official/environment disagreement now suspends authority and requires explicit configuration plus restart.
- Made `passiveCallsPerHour` a hard cross-process rolling-hour ceiling on actual passive hidden provider invocations. Eligible auto/yolo synthesis reserves and audits both synthesizer/critic slots atomically before either session starts; manual scans remain outside this budget.
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
