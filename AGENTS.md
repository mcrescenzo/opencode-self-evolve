# Self-Evolve Plugin Notes

**Contract version:** `@opencode-ai/plugin@1.18.3` (declared range: `~1.18.3`)
**Verified against runtime:** opencode 1.18.3 (contract-level verification; see tests)

- This repository is the standalone source for `@mcrescenzo/opencode-self-evolve`. It may be checked out directly or nested inside a larger OpenCode config tree; do not assume any parent checkout is a git repository.
- Public package users register the plugin in `opencode.json` as `@mcrescenzo/opencode-self-evolve`. Local development checkouts may register a file path to `self-evolve.js`.
- The normative durable v0.4 binary-automation contract is `docs/autonomy-contract.md`; v0.2/v0.3 state and protocols are bounded migration or read-only compatibility input only. The v0.1 manual analyzer, `durableAutonomy: false`, and its session-local registry are removed in v0.4. Durable state is restricted to the OpenCode state root; never add external-tracker writes, network publication, Git mutation, implementation/shell agents, or external-system mutation.
- Use plain Node ESM for server and shared modules and add no ordinary runtime dependencies. The target-exclusive `./tui` export is deterministic prebuilt JavaScript authored in TSX and may declare only these optional peer dependencies: `@opencode-ai/plugin ~1.18.3`, `@opentui/core >=0.4.5 <0.6.0`, `@opentui/keymap >=0.4.5 <0.6.0`, `@opentui/solid >=0.4.5 <0.6.0`, and `solid-js 1.9.12`; they must remain unreachable from the package root. Any other dependency or range change requires maintainer approval. Run `npm test`, `npm run check`, and `npm run pack:check` from this directory; run `npm run smoke:live` when a local OpenCode binary is available.
- Tests import pure helpers from `self-evolve-core.js` and `SelfEvolvePlugin.__test`; keep `self-evolve.js` exporting only the plugin function so OpenCode does not boot test helpers as plugins.
- Runtime directories such as `.opencode/`, `.remember/`, `.beads/`, `.claude/`, `node_modules/`, logs, and live `.env` files are not package fixtures and must not be published. Local tracker state may exist during development, but it is not part of the public release surface.
- After changing this plugin or OpenCode registration/config, restart OpenCode; running sessions keep already-loaded plugins, commands, agents, and instructions.

## Design rationale and key invariants

These are deliberate decisions, not accidents. Preserve them across refactors.

- **No legacy analyzer registry in v0.4.** Remove the module-scoped legacy `registry`, owner refcount, `handleCommand`/`runAnalysis`, analyzer reservations/notifications, and `durableAutonomy: false` factory branch. Do not repurpose that registry for durable state. Duplicate factory instances share only the bounded durable integration coordinator; durable authority remains in the state-root store and its cross-process epochs.
- **Single-export invariant.** `self-evolve.js` exports only the plugin function (`export default SelfEvolvePlugin`) and nothing else. OpenCode iterates `Object.values(module)` and treats every exported function as a plugin factory, so a second named export would be booted as a second plugin and cause double instantiation. Test seams therefore hang off the function as properties (`SelfEvolvePlugin.__test`) and pure helpers live in `self-evolve-core.js`; neither is a module export. Keep it that way — do not add named exports to the entry file.
- **Stable v0.4 trigger invariant.** The plugin always returns exactly one lifecycle `event` hook, including Automatic recommendations Off and preboot validation; passive `chat.message` remains prohibited. Before validated boot, while Off, without all three required data permissions, or under an operational suppressor, the handler returns before source-lineage hydration, session/message reads, provider calls, durable observation, contribution, or scheduler admission. Manual/on-demand analysis, project modes, Pause/Resume, separate `passiveCalls`, and `/self-evolve scan` do not exist in v0.4.

## Autonomy modules and dual-target invariants

- `self-evolve-schemas.js`: bounded v0.2/v0.3 migration readers and exact v0.4 binary settings, project participation, global schemas, transitions, identity firewall, and action-specific authority evaluation.
- `self-evolve-store.js`: project-partitioned evidence plus state-root-global records, leases, CAS, retention, and corruption handling.
- `self-evolve-observation.js`: deterministic receipts, observations, correlation, and eligibility.
- `self-evolve-inventory.js`: host-authoritative global existing-skill discovery, explicit creation-root policy, immutable receipts, hashes, path safety, and growth checks.
- `self-evolve-privacy.js`: consent, partitioning, redaction, quota, export, purge, and retention.
- `self-evolve-synthesis.js`: hidden deny-all-tools synthesizer and critic sessions.
- `self-evolve-applier.js`: sole transactional allowlisted skill writer, audit, and rollback.
- `self-evolve-commands.js`: deterministic command parsing and policy controls.
- `self-evolve-pipeline.js`: shared observe-to-notify/apply stage orchestration.
- `self-evolve-scheduler.js`: idle dedup, budgets, leases, epochs, and circuit breaker.
- `self-evolve-integration.js`: mode/authority coordination, boot recovery, TUI bridge, and shutdown.
- `self-evolve-lock.js`: shared synchronous cross-process mutation lock used by stores and mailbox publishers.
- `self-evolve-epoch.js`: separate root-global durable terminal, breaker, and automation epoch primitives; each persists outside or alongside the deletable subtree according to `docs/autonomy-contract.md` and never substitutes for another authority domain.
- `self-evolve-state-root.js`: shared canonical state-root precedence, bounded host validation, and root identity.
- `self-evolve-ui-protocol.js`: strict bounded projection, grant, operation, and compatibility schemas shared by both targets.
- `self-evolve-projection.js`: server-authored project projection and target-derived operation grants.
- `self-evolve-export.js`: private short-lived native export artifact writer and metadata reader.
- `self-evolve-tui.tsx`: typechecked target-exclusive TUI source; `self-evolve-tui.generated.js` is the deterministic public TUI entry and `self-evolve-tui.js` owns target-exclusive host registration and lifecycle wiring.
- `self-evolve-tui-store.js`: target-exclusive project-scoped reactive projection store and lifecycle owner.
- **TUI authority invariant.** The TUI is a read-only projection consumer and can publish only strict create-exclusive decision, control, and operation envelopes. The server freshly revalidates root/project identity, projection/grant generation, domain versions, nonce, consent, and authority immediately before any effect. Native purge-all is accepted-terminal: publish the terminal response and stop authority before deleting its mailbox subtree.
- **Native UX invariant.** Normal interaction is the persistent clickable sidebar entry point and the four-section Home, Recommendations, Activity, and Settings control center defined by `docs/control-center-ux.md`. Settings has one normal operating switch, Automatic recommendations On/Off. Sidebar state chooses an exact deep link: setup to Settings, review to the selected Recommendation, failures to Activity/Errors, and healthy/startup states to Home. The full-screen control center owns a mode-scoped Escape binding so every focused child can return to the exact prior route. Keep outcomes mounted; do not reintroduce proposal/status/settings toasts, attention notifications, polling-triggered dialogs, auto-opened routes, Manual/on-demand scan, project modes, ordinary Pause, or slash-dependent normal workflows. Retained slash commands remain headless/recovery compatibility only.
- **Dual-target invariant.** The server entry is exported only from `.` and must not import `./tui`, `@opencode-ai/plugin/tui`, or `@opentui/*`. The TUI entry is exported only from `./tui`. Shared pure helpers import from neither target.
- **Single-export invariant.** `self-evolve.js` still exports only `default SelfEvolvePlugin`; test seams remain properties on that function.
