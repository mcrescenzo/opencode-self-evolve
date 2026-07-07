# Self-Evolve Plugin Notes

**Contract version:** `@opencode-ai/plugin@1.17.7` (declared range: `^1.17.7`)
**Verified against runtime:** opencode 1.17.7 (contract-level verification; see tests)

- This repository is the standalone source for `@mcrescenzo/opencode-self-evolve`. It may be checked out directly or nested inside a larger OpenCode config tree; do not assume any parent checkout is a git repository.
- Public package users register the plugin in `opencode.json` as `@mcrescenzo/opencode-self-evolve`. Local development checkouts may register a file path to `self-evolve.js`.
- The plugin is intentionally session-local and in-memory. Do not add persistence, writes to external issue trackers or memory systems, calls to internal tooling, auto-edits, network publication, or external-system mutation without explicit approval.
- Use plain Node ESM and no new npm dependencies. Run `npm test`, `npm run check`, and `npm run pack:check` from this directory; run `npm run smoke:live` when a local OpenCode binary is available.
- Tests import pure helpers from `self-evolve-core.js` and `SelfEvolvePlugin.__test`; keep `self-evolve.js` exporting only the plugin function so OpenCode does not boot test helpers as plugins.
- Runtime directories such as `.opencode/`, `.remember/`, `.beads/`, `.claude/`, `node_modules/`, logs, and live `.env` files are not package fixtures and must not be published. Local tracker state may exist during development, but it is not part of the public release surface.
- After changing this plugin or OpenCode registration/config, restart OpenCode; running sessions keep already-loaded plugins, commands, agents, and instructions.

## Design rationale and key invariants

These are deliberate decisions, not accidents. Preserve them across refactors.

- **Module-level registry, created once and never reassigned.** Session state lives in a single module-scoped `const registry = createRegistry()`. OpenCode calls each exported plugin factory and may instantiate it more than once, so the registry must be one module-level source of truth keyed by session ID rather than per-factory closure state — top-level helpers (`handleCommand`, `runAnalysis`) and the returned hooks all read the same `registry`. It is a `const`, not a reassignable `let`: reassigning it inside the factory (`registry = createRegistry(...)`) would silently discard all existing session state (pause/disable, pending proposal, rate-limit counters) on a second factory call. To re-seed the configured options (so `/self-evolve status` shows the real caps) without discarding state, the factory calls `registry.setOptions(pluginOptions)`, which updates the options used for newly-created session state and the eviction cap in place. The factory also reassigns the separate module-level `let currentPluginOptions`, which hook bodies read at call time.
- **Single-export invariant.** `self-evolve.js` exports only the plugin function (`export default SelfEvolvePlugin`) and nothing else. OpenCode iterates `Object.values(module)` and treats every exported function as a plugin factory, so a second named export would be booted as a second plugin and cause double instantiation. Test seams therefore hang off the function as properties (`SelfEvolvePlugin.__test`) and pure helpers live in `self-evolve-core.js`; neither is a module export. Keep it that way — do not add named exports to the entry file.
- **Manual-only trigger invariant.** The plugin must not register passive `event` or `chat.message` analysis hooks. Analyzer runs happen only through `command.execute.before` for a manual `/self-evolve` or `/self-evolve scan` command invocation; do not reintroduce idle/high-signal auto-analysis without explicit approval.
- **Registry lifetime.** The module-level `registry` is session-local and in-memory. It is populated only by command-driven interactions and cleared in `dispose`; do not add persistence or passive registry population without explicit approval.
