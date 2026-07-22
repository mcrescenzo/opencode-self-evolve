# Changelog

All notable public changes to `@mcrescenzo/opencode-self-evolve` will be
recorded here.

This project follows semantic versioning after the first public release.

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
