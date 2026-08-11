# Self-Evolve Plugin Guide

This repository is the standalone dual-target `@mcrescenzo/opencode-self-evolve` package. The normative v0.3 global-first contract is in `docs/autonomy-contract.md`; v0.2 state and protocols are migration or compatibility input only. Use plain Node ESM and no new dependencies. Never add implementation/shell/Git agents, transcript injection, Git or publication behavior, external-tracker mutation, repo-local autonomous writes, unattended global writes, or writes outside exact approved global roots.

## Validation

Run `npm test`, `npm run check`, and `npm run pack:check`. Run `npm run smoke:live` only when a local OpenCode binary is available; it must remain no-token. Restart OpenCode after plugin/config changes and after applied skill changes; existing sessions retain loaded code and skills.

## Autonomy Modules

- `self-evolve-schemas.js`: immutable compatibility records plus exact v0.3 project/global schemas, transitions, identity firewall, and authority.
- `self-evolve-store.js`: durable project evidence and state-root-global records, leases, CAS, retention.
- `self-evolve-observation.js`: deterministic receipts, correlation, eligibility.
- `self-evolve-inventory.js`: skill inventory, canonical paths, hashes, safety.
- `self-evolve-privacy.js`: consent, redaction, quota, export, purge.
- `self-evolve-synthesis.js`: hidden deny-all-tools synthesis and critic.
- `self-evolve-applier.js`: sole transactional allowlisted writer and rollback.
- `self-evolve-commands.js`: deterministic commands and control policy.
- `self-evolve-pipeline.js`: shared autonomy stage orchestration.
- `self-evolve-scheduler.js`: idle dedup, budgets, leases, epochs.
- `self-evolve-integration.js`: effective mode, boot recovery, bridge, shutdown.
- `self-evolve-lock.js`: shared synchronous cross-process store/mailbox lock.
- `self-evolve-state-root.js`: canonical dual-target root precedence and identity.
- `self-evolve-bridge.js`: strict filesystem mailbox/IPC between server and TUI processes.
- `self-evolve-client.js`: bounded OpenCode SDK client adapter and compatibility handling.
- `self-evolve-core.js`: legacy analyzer helpers reused by the durable pipeline.
- `self-evolve-ui-protocol.js`: exact projection, grant, request, and response schemas.
- `self-evolve-projection.js`: bounded server-authored control-center projections.
- `self-evolve-export.js`: private short-lived sensitive export artifacts.
- `self-evolve-tui-store.js`: project-scoped reactive projection and mailbox client runtime.
- `self-evolve-tui.tsx`: typechecked target-exclusive authoring source.
- `self-evolve-tui.generated.js`: deterministic public `./tui` entry built before pack.
- `self-evolve-tui.js`: target-exclusive host registration and lifecycle wiring.
- `self-evolve.js`: single-export server entry, hook wiring, and coordinated module registry.

## Invariants

- Dual target: server `.` must not import `./tui`, `@opencode-ai/plugin/tui`, or `@opentui/*`; TUI is available only from `./tui`; shared helpers import neither target.
- Single export: `self-evolve.js` exports only `default SelfEvolvePlugin`. Test seams stay on `SelfEvolvePlugin.__test`.
- Single registry: preserve the module-scoped `const registry`; factory calls update options in place and never replace session state.
- Trigger gate: durable mode always exposes exactly one lifecycle `event` hook, including configured Manual and preboot validation. Before validated boot and whenever configured project analysis mode is `manual`, return before source-lineage hydration, session/message reads, provider calls, durable observation, contribution, or scheduler admission. Never register passive `chat.message`; Manual analysis remains command-driven through `/self-evolve scan`. Project analysis modes are only `manual` and `auto`; the retired `yolo` command and control request are refused, and a stored v0.2 `yolo` value narrows to `auto` without unattended write authority.
- State split: the legacy registry is in-memory and cleared on dispose. Durable autonomy uses only the OpenCode state-root store.
- Authority: the applier is the only skill writer; global Apply and Undo always require a fresh explicit operator decision, and all model output remains advisory. Models cannot choose roots, consent, project analysis mode, retention/purge authority, or write authority.
- Public helper policy: `AGENTS.md` and this file ship as public guidance and must not contain private paths or internal tooling references.
