# Self-Evolve Plugin Notes

**Contract version:** `@opencode-ai/plugin@1.18.3` (declared range: `^1.18.3`)
**Verified against runtime:** opencode 1.18.3 (contract-level verification; see tests)

- This repository is the standalone source for `@mcrescenzo/opencode-self-evolve`. It may be checked out directly or nested inside a larger OpenCode config tree; do not assume any parent checkout is a git repository.
- Public package users register the plugin in `opencode.json` as `@mcrescenzo/opencode-self-evolve`. Local development checkouts may register a file path to `self-evolve.js`.
- Legacy manual state is session-local and in-memory. Durable v0.2 autonomy state is restricted to the OpenCode state root; never add external-tracker writes, network publication, Git mutation, implementation/shell agents, or external-system mutation.
- Use plain Node ESM and no new npm dependencies. Run `npm test`, `npm run check`, and `npm run pack:check` from this directory; run `npm run smoke:live` when a local OpenCode binary is available.
- Tests import pure helpers from `self-evolve-core.js` and `SelfEvolvePlugin.__test`; keep `self-evolve.js` exporting only the plugin function so OpenCode does not boot test helpers as plugins.
- Runtime directories such as `.opencode/`, `.remember/`, `.beads/`, `.claude/`, `node_modules/`, logs, and live `.env` files are not package fixtures and must not be published. Local tracker state may exist during development, but it is not part of the public release surface.
- After changing this plugin or OpenCode registration/config, restart OpenCode; running sessions keep already-loaded plugins, commands, agents, and instructions.

## Design rationale and key invariants

These are deliberate decisions, not accidents. Preserve them across refactors.

- **Module-level registry, created once and never reassigned.** Session state lives in a single module-scoped `const registry = createRegistry()`. OpenCode calls each exported plugin factory and may instantiate it more than once, so the registry must be one module-level source of truth keyed by session ID rather than per-factory closure state — top-level helpers (`handleCommand`, `runAnalysis`) and the returned hooks all read the same `registry`. It is a `const`, not a reassignable `let`: reassigning it inside the factory (`registry = createRegistry(...)`) would silently discard all existing session state (pause/disable, pending proposal, rate-limit counters) on a second factory call. To re-seed the configured options (so `/self-evolve status` shows the real caps) without discarding state, the factory calls `registry.setOptions(pluginOptions)`, which updates the options used for newly-created session state and the eviction cap in place. The factory also reassigns the separate module-level `let currentPluginOptions`, which hook bodies read at call time.
- **Single-export invariant.** `self-evolve.js` exports only the plugin function (`export default SelfEvolvePlugin`) and nothing else. OpenCode iterates `Object.values(module)` and treats every exported function as a plugin factory, so a second named export would be booted as a second plugin and cause double instantiation. Test seams therefore hang off the function as properties (`SelfEvolvePlugin.__test`) and pure helpers live in `self-evolve-core.js`; neither is a module export. Keep it that way — do not add named exports to the entry file.
- **Mode-gated trigger invariant.** The plugin registers a passive `event` hook only when `durableAutonomy: true` and startup mode is not `manual`; it never registers passive `chat.message`. Manual analyzer runs remain command-driven. Auto/yolo events enter the durable scheduler and cannot bypass consent, budgets, evidence, or authority gates.
- **Registry lifetime.** The module-level legacy `registry` remains session-local and in-memory, is populated only by command interactions, and is cleared in `dispose`. Durable autonomy uses its separate state-root store; never mix durable records into the legacy registry.

## Autonomy modules and dual-target invariants

- `self-evolve-schemas.js`: immutable schemas, settings, transitions, and authority evaluation.
- `self-evolve-store.js`: project-partitioned durable records, leases, CAS, retention, and corruption handling.
- `self-evolve-observation.js`: deterministic receipts, observations, correlation, and eligibility.
- `self-evolve-inventory.js`: skill discovery, canonical roots, hashes, path safety, and growth checks.
- `self-evolve-privacy.js`: consent, partitioning, redaction, quota, export, purge, and retention.
- `self-evolve-synthesis.js`: hidden deny-all-tools synthesizer and critic sessions.
- `self-evolve-applier.js`: sole transactional allowlisted skill writer, audit, and rollback.
- `self-evolve-commands.js`: deterministic command parsing and policy controls.
- `self-evolve-pipeline.js`: shared observe-to-notify/apply stage orchestration.
- `self-evolve-scheduler.js`: idle dedup, budgets, leases, epochs, and circuit breaker.
- `self-evolve-integration.js`: mode/authority coordination, boot recovery, TUI bridge, and shutdown.
- `self-evolve-tui.js`: native safe-idle review, consent, audit, and rollback UI.
- **Dual-target invariant.** The server entry is exported only from `.` and must not import `./tui`, `@opencode-ai/plugin/tui`, or `@opentui/*`. The TUI entry is exported only from `./tui`. Shared pure helpers import from neither target.
- **Single-export invariant.** `self-evolve.js` still exports only `default SelfEvolvePlugin`; test seams remain properties on that function.
- **Module-level registry invariant.** Keep the single module-scoped `const registry`; never reassign or duplicate it when adding autonomy wiring.
