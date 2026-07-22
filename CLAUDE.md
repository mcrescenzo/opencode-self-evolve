# Self-Evolve Plugin Guide

This repository is the standalone dual-target `@mcrescenzo/opencode-self-evolve` package. The normative v0.2 behavior is in `docs/autonomy-contract.md`. Use plain Node ESM and no new dependencies. Never add implementation/shell/Git agents, transcript injection, Git or publication behavior, external-tracker mutation, or writes outside canonical skill allowlists.

## Validation

Run `npm test`, `npm run check`, and `npm run pack:check`. Run `npm run smoke:live` only when a local OpenCode binary is available; it must remain no-token. Restart OpenCode after plugin/config changes and after applied skill changes; existing sessions retain loaded code and skills.

## Autonomy Modules

- `self-evolve-schemas.js`: immutable records, settings, transitions, authority.
- `self-evolve-store.js`: durable project partitions, leases, CAS, retention.
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
- `self-evolve-tui.js`: native safe-idle review and consent UI.

## Invariants

- Dual target: server `.` must not import `./tui`, `@opencode-ai/plugin/tui`, or `@opentui/*`; TUI is available only from `./tui`; shared helpers import neither target.
- Single export: `self-evolve.js` exports only `default SelfEvolvePlugin`. Test seams stay on `SelfEvolvePlugin.__test`.
- Single registry: preserve the module-scoped `const registry`; factory calls update options in place and never replace session state.
- Trigger gate: durable v0.2 is the default; `durableAutonomy: false` is explicit legacy compatibility. Passive `event` exists only after successful durable boot with persisted effective auto/yolo mode. Never register passive `chat.message`. Manual analysis remains command-driven.
- State split: the legacy registry is in-memory and cleared on dispose. Durable autonomy uses only the OpenCode state-root store.
- Authority: the applier is the only skill writer and all model output remains advisory until deterministic policy authorizes it.
- Public helper policy: `AGENTS.md` and this file ship as public guidance and must not contain private paths or internal tooling references.
