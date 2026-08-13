# Self-Evolve Plugin Guide

This repository is the standalone dual-target `@mcrescenzo/opencode-self-evolve` package. The normative v0.4 binary-automation contract is in `docs/autonomy-contract.md`; v0.2/v0.3 state and protocols are bounded migration or read-only compatibility input only. Use plain Node ESM and no new dependencies. Never add implementation/shell/Git agents, transcript injection, Git or publication behavior, external-tracker mutation, project-local automatic writes, unattended global writes, or writes outside a current host-global existing target or exact explicit creation root.

## Validation

Run `npm test`, `npm run check`, and `npm run pack:check`. Run `npm run smoke:live` only when a local OpenCode binary is available; it must remain no-token. Restart OpenCode after plugin/config changes and after applied skill changes; existing sessions retain loaded code and skills.

## Autonomy Modules

- `self-evolve-schemas.js`: bounded compatibility readers plus exact v0.4 binary/project/global schemas, transitions, identity firewall, and action-specific authority.
- `self-evolve-store.js`: durable project evidence and state-root-global records, leases, CAS, retention.
- `self-evolve-observation.js`: deterministic receipts, correlation, eligibility.
- `self-evolve-inventory.js`: host-global existing-skill inventory, explicit creation roots, canonical paths, hashes, safety.
- `self-evolve-privacy.js`: consent, redaction, quota, export, purge.
- `self-evolve-synthesis.js`: hidden deny-all-tools synthesis and critic.
- `self-evolve-applier.js`: sole transactional allowlisted writer and rollback.
- `self-evolve-commands.js`: deterministic commands and control policy.
- `self-evolve-pipeline.js`: shared autonomy stage orchestration.
- `self-evolve-scheduler.js`: idle dedup, budgets, leases, epochs.
- `self-evolve-integration.js`: binary preference/permission/epoch coordination, boot recovery, bridge, shutdown.
- `self-evolve-lock.js`: shared synchronous cross-process store/mailbox lock.
- `self-evolve-state-root.js`: canonical dual-target root precedence and identity.
- `self-evolve-bridge.js`: strict filesystem mailbox/IPC between server and TUI processes.
- `self-evolve-client.js`: bounded OpenCode SDK client adapter and compatibility handling.
- `self-evolve-core.js`: target-neutral pure helpers retained by durable modules during the v0.4 analyzer-removal migration.
- `self-evolve-ui-protocol.js`: exact projection, grant, request, and response schemas.
- `self-evolve-projection.js`: bounded server-authored control-center projections.
- `self-evolve-export.js`: private short-lived sensitive export artifacts.
- `self-evolve-tui-store.js`: project-scoped reactive projection and mailbox client runtime.
- `self-evolve-tui.tsx`: typechecked target-exclusive authoring source.
- `self-evolve-tui.generated.js`: deterministic public `./tui` entry built before pack.
- `self-evolve-tui.js`: target-exclusive host registration and lifecycle wiring.
- `self-evolve.js`: single-export server entry and durable lifecycle hook wiring.

## Invariants

- Dual target: server `.` must not import `./tui`, `@opencode-ai/plugin/tui`, or `@opentui/*`; TUI is available only from `./tui`; shared helpers import neither target.
- Single export: `self-evolve.js` exports only `default SelfEvolvePlugin`. Test seams stay on `SelfEvolvePlugin.__test`.
- No legacy analyzer registry: remove the module-scoped analyzer registry, owner refcount, reservations, notifications, and `durableAutonomy: false` factory branch rather than repurposing them for durable state.
- Trigger gate: durable v0.4 always exposes exactly one lifecycle `event` hook, including Automatic recommendations Off and preboot validation. Before validated boot, while Off, without the three required data permissions, or under an operational suppressor, return before source-lineage hydration, session/message reads, provider calls, durable observation, contribution, or scheduler admission. Never register passive `chat.message`; Manual/on-demand, scan, project modes, Pause, and separate `passiveCalls` are removed.
- State split: durable authority uses only the OpenCode state-root store and separate terminal, breaker, and automation epochs. The legacy analyzer registry and `durableAutonomy: false` branch are removed rather than repurposed.
- Authority: the applier is the only skill writer; global Apply and Undo always require a fresh explicit operator decision, and all model output remains advisory. Models cannot choose host sources, creation roots, permissions, Automatic recommendations state, project participation, retention/purge authority, or write authority.
- Public helper policy: `AGENTS.md` and this file ship as public guidance and must not contain private paths or internal tooling references.
