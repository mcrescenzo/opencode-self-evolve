# Self-Evolve Plugin Guide

This repository contains the standalone `@mcrescenzo/opencode-self-evolve` OpenCode plugin. The plugin is conservative by design: it runs analysis only after an explicit `/self-evolve` or `/self-evolve scan` command, keeps session state in memory, and never edits files, writes to external issue trackers or memory systems, publishes, pushes, or mutates external systems without explicit user approval.

## Validation

Run from this repository root:

```bash
npm test
npm run check
npm run pack:check
```

Run `npm run smoke:live` when a local OpenCode binary is available. The live smoke is no-token: it starts an isolated temporary OpenCode config, verifies plugin loading and command-hook behavior, and avoids provider/model-backed command execution.

## Architecture

- `self-evolve.js` is the plugin entrypoint and must keep a single default export. Do not add named exports; OpenCode treats exported functions as plugin factories.
- Test-only entrypoint seams hang off `SelfEvolvePlugin.__test`. Pure helpers live in `self-evolve-core.js`.
- `self-evolve-core.js` owns deterministic parsing, transcript bounding/redaction, registry state, analyzer result validation, and command text.
- `analyzer-prompt.js` defines the analyzer contract and JSON schema expectations.
- `tests/*.test.mjs` cover pure helper behavior and plugin hook behavior.
- `scripts/live-command-hook-smoke.mjs` runs the live OpenCode command-hook smoke.
- `scripts/pack-artifact-check.mjs` verifies the public npm tarball contents and imports the packed plugin entrypoint.

## Invariants

- Manual-only trigger: do not add passive `event` or `chat.message` analyzer hooks.
- Session-local state: keep registry state in memory; do not add persistence, writes to external issue trackers or memory systems, calls to internal tooling, auto-edits, or network publication.
- Single shared registry: `self-evolve.js` creates the module-level registry exactly once (`const registry = createRegistry()`) and never reassigns it. The plugin factory re-seeds resolved options via `registry.setOptions(...)`, which updates option-driven behavior (like the eviction cap and new-session defaults) without discarding any existing registry entries. Keep top-level helpers and returned hooks reading the same registry.
- Single export: keep `self-evolve.js` exporting only the plugin function.
- Plain Node ESM: do not add npm dependencies unless the safety tradeoff is explicit and justified.
- Public helper policy: `AGENTS.md` and this file are public; keep them free of private paths and internal tool references.
