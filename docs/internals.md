# Internals

Version 0.2 is a dual-target Node ESM package built around one durable pipeline:

```text
observe -> persist -> correlate -> synthesize -> validate -> notify | apply
```

Manual, auto, and yolo modes share the same evidence thresholds. Mode changes authority and scheduling, not proposal quality.

## Dual Targets

- `self-evolve.js` is the headless-safe server entry at `.`. It default-exports only `SelfEvolvePlugin`, imports no TUI target or `@opentui/*` runtime, owns durable writes, and exposes commands/events.
- `self-evolve-tui.js` is the native review entry at `./tui`. Its default export has `{ tui }` `TuiPluginModule` shape. It renders consent, proposal, audit, and rollback UI but is not the durable observation/proposal/audit writer.
- Shared modules are pure server-side ESM helpers and import neither package target.

The package checker installs the packed tarball into a fresh consumer, imports both export paths, verifies the server without OpenTUI peers, checks the namespace shapes, enforces the exact public file manifest, and rejects network/process module imports.

## Autonomy Modules

1. `self-evolve-schemas.js` defines immutable records, settings, modes, budgets, decisions, transitions, and authority evaluation.
2. `self-evolve-store.js` owns versioned project-partitioned JSONL state, atomic records, leases, CAS, retention, and corruption handling.
3. `self-evolve-observation.js` extracts deterministic receipts, forms bounded structured observations, and correlates independent incidents.
4. `self-evolve-inventory.js` discovers skill targets, canonicalizes allowlists, hashes content, rejects symlinks/unsafe paths, and enforces growth/canary checks.
5. `self-evolve-privacy.js` enforces project partitions, consent, redaction, quotas, retention, export, and purge.
6. `self-evolve-synthesis.js` runs hidden deny-all-tools synthesizer and critic sessions with strict schemas and current-content hash binding.
7. `self-evolve-applier.js` is the sole skill writer: leased, hash-bound, allowlisted, atomic, audited, readback-verified, and rollback guarded.
8. `self-evolve-commands.js` parses and executes deterministic mode, consent, inbox, decision, export, purge, and kill-switch controls.
9. `self-evolve-pipeline.js` composes observe, correlate, synthesize, critic, notify, approval, application, and rollback stages.
10. `self-evolve-scheduler.js` debounces idle events, enforces durable leases/budgets/quiet periods, rejects stale epochs, and keeps event handling non-blocking.
11. `self-evolve-integration.js` resolves effective authority, coordinates scheduler/pipeline/TUI, boots recovery, and shuts resources down.
12. `self-evolve-tui.js` presents native safe-idle dialogs and durable inbox/audit results.

## Hooks And Boot

The server always registers `config`, `command.execute.before`, and `dispose`. The config hook installs the hidden legacy analyzer agent. With `durableAutonomy: true`, startup constructs the integration and calls `boot()`, which cleans expired leases, invokes transactional apply recovery, enumerates active hidden self-evolve analyzer sessions left by a crashed process, aborts those orphans, records boot health, and synchronizes scheduler mode.

A passive `event` hook is registered only when durable autonomy is enabled and startup mode is not manual. Manual mode has no passive provider call or durable observation write. Auto/yolo idle events are handed to the scheduler, which records the episode and schedules real work after a stable idle boundary.

`dispose` clears the module-level legacy registry and asynchronously shuts down the integration, scheduler, applier, synthesis timers, audit buffers, and store.

## Hidden Analysis

The synthesizer and critic use hidden primary sessions, temperature 0, one step, strict structured output, and deny-all tool permissions. The observer is deterministic and makes no model call. Inputs are typed evidence, inventory, bounded optional excerpts, and current skill content; model output cannot select scope, consent, retention, budgets, or apply authority. Every child session is aborted after success, failure, or timeout, and boot recovers active orphans after a hard crash.

## Decision CAS

TUI and headless decisions carry:

```text
(proposalID, targetHash, proposedContentHash, decisionVersion,
 actor, timestamp, nonce, priorState, newState)
```

The server applies compare-and-swap against `priorState`. A successful transition increments the decision version and burns the nonce. Stale state, target/content hash mismatch, duplicate nonce, cross-project scope, or invalid transition fails closed. Auto requires an exact per-change approval. Yolo may synthesize an internal approval only after allowlist and release gates pass. Rollback is valid only while the current disk hash equals the recorded plugin-applied hash.

## Durable State

Each project uses `<state-root>/self-evolve/<projectFingerprint>/`. Records are append-only JSONL; corrections supersede by ID. Writes use same-directory temporary files and rename, while leases use create-exclusive files. Complete transcripts and raw message bodies are never stored. Retention defaults to 30 days for observations and 90 days for proposals/decisions/audits.

## Validation

Run `npm test`, `npm run check`, and `npm run pack:check`. `npm run smoke:live` is an optional no-token local host smoke. Restart OpenCode after plugin, mode, or skill changes; existing sessions retain loaded plugin and skill content.
