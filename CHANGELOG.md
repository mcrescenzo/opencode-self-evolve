# Changelog

All notable public changes to `@mcrescenzo/opencode-self-evolve` will be
recorded here.

This project follows semantic versioning after the first public release.

## Unreleased

- Derived production host compatibility after factory return from bounded official global health instead of hardcoding 1.18.3. Startup prefers `client.global.health()` and falls back only to exact-origin GET `/global/health` from official `PluginInput.serverUrl`; every root kind waits for healthy stable `>=1.18.3 <2.0.0` health before integration boot. Provisional persisted-auto/yolo hooks have no authority while pending and remain inert on failure.
- Made ordinary string package registration boot durable v0.2 in fail-closed manual mode; `durableAutonomy: false` is now the explicit legacy v0.1 compatibility switch.
- Startup now awaits durable boot and persisted effective-mode resolution before returning hooks, so options-free restarts register passive events for stored auto/yolo and omit them for manual or failed/corrupt startup. Startup `mode` no longer overrides durable preferences.
- Unified server/TUI identity through one validated resolver using explicit fingerprint, shared plugin `remoteUrl`, and supported OpenCode worktree/directory inputs; conflicting identities fail closed.
- Added the exact one-use auto headless approval command, bound to the current proposal ID, target hash, proposed-content hash, decision version, and server-issued nonce; malformed, stale, mismatched, manual-mode, and replayed approvals fail closed.
- Completed cross-process state, retention, persisted yolo rollout evidence, and production filesystem TUI mailbox remediation.
- Expanded the no-token OpenCode smoke to compare `opencode --version`, official global health, and the plugin-reported running version while covering durable boot, state layout, retention, mode commands, passive-hook registration, mailbox lifecycle, exact temporary-skill application, cleanup, and explicit live-host versus in-process evidence.
- Reconciled package contents, configuration examples, migration/restart guidance, privacy/security claims, and dual-target verification. Native dialog behavior remains mocked rather than presented as live-render proof.
- Replaced split proposal-CAS/decision appends with a hash-bound recoverable store transaction. Boot repairs intent-only, proposal-only, or decision-only crashes idempotently; apply failures become visible critical `failed-closed` records without Apply authority.
- Added exact `must-not-exist` schema support and removed empty new-target reservation. New skills are fully validated in a same-directory temp and atomically published create-exclusively with a hard link, with process-kill and concurrent-collision coverage.
- Added strict `synthesis-attempt` admission before provider calls, non-actionable `critic-pending` drafts, one-outcome boot recovery, and active-only cluster suppression. Real SIGKILL fixtures cover admission, provider return, draft append, critic transition, content persistence, and outcome append.
- Replaced free-form proposal body audits with hash-bound typed content chunks. Active bodies survive retention; terminal transitions and proposal purge compact them under the recoverable decision transaction, and inbox/export readers reject mixed, cross-proposal, duplicate, partial, or hash-invalid chunks.
- Hardened the filesystem bridge to one canonical state-root boundary with component-by-component symlink/containment checks, `O_NOFOLLOW` final reads, inode/link-count validation, create-exclusive publication, and equally strict cleanup/lock recovery.
- Added a separate authenticated control mailbox and strict read-only control-state projection. The server now applies exact mode, consent, repository-exclusion, and elevated allowlist controls through locked settings updaters with settings-hash/`updatedAt` binding and one-use nonce replay protection.
- Bounded concurrent decision/control mailbox publication with a shared project lock, file cap, quota-derived byte budget, response reservation, and store-capacity reserve; `export all` now includes separately classified and bounded metadata for every decision/control request, response, and control-state class.
- Added the native **Self-evolve settings** palette command (`/self-evolve-settings`) with mode, allowlist, all consent, and repository exclusion flows; yolo uses two exact-allowlist confirmations and excerpt/cross-repository controls disclose redaction limits.
- Added process-aware apply and synthesis leases. Boot now defers live-owner work without false rollback or failed-closed transitions, reclaims dead owners idempotently, and preserves expiry migration for legacy PID-less leases.
- Restored hard-crash hidden-session cleanup as a bounded asynchronous post-start phase with selective self-evolve-only aborts, timeout/retry/backoff health reporting, idempotence, and disposal cancellation.
- Unified server/TUI state-root precedence around official host paths, moved the potentially self-blocking 1.18.3 path SDK check into bounded post-start validation, prohibited provisional store writes, and bound canonical root identity into the TUI control projection. Official/environment disagreement now suspends authority and requires explicit configuration plus restart.
- Made `passiveCallsPerHour` a hard cross-process rolling-hour ceiling on actual passive hidden provider invocations. Eligible auto/yolo synthesis reserves and audits both synthesizer/critic slots atomically before either session starts; manual scans remain outside this budget.

## 0.2.0 - 2026-07-22

- Added the shared autonomy pipeline with `manual`, `auto`, and `yolo` modes, identical evidence thresholds, durable structured observations, deterministic correlation, hidden synthesis and critic review, and a conservative scheduler.
- Added a native TUI review target, durable headless inbox, compare-and-swap decisions, privacy/retention/export/purge lifecycle, and a transactional hash-bound skill applier with audit and rollback support.
- Added release gates, budgets, consent controls, canonical allowlists, emergency kill switches, crash recovery, and an adversarial hardening campaign covering concurrency, injection, stale hashes, quota exhaustion, and rollback failure.
- **Breaking:** raised the minimum supported OpenCode and `@opencode-ai/plugin` host contract to `^1.18.3`.
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
