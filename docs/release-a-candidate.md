# Release A Candidate Record

This record identifies the unpublished sidebar-first Release A candidate. It is completed by the candidate-generation checks before independent review. It does not authorize a commit, push, tag, npm publication, or GitHub Release.

## Candidate Identity

- Package: `@mcrescenzo/opencode-self-evolve`
- Candidate version: `0.2.0` (unpublished working-tree candidate)
- Source commit: `6cb32ca05d06fb6f374d3e288aeb5845a4a0b20c`
- Working-tree state: intentionally includes the uncommitted Release A implementation; the packed artifact hash and exact inventory identify the candidate contents beyond the source commit.
- Packed artifact SHA-256: `fa94f41f758d8fcab2a4ef5511809df19352fb3fef04129de4b7813ec2e6d272`
- Packed inventory SHA-256: `d81d31809dabb2c9607d70536f921a871a48f0542eb13a49f52c1c8b3aad7f9c`
- Packed inventory: 34 files:
  - `CHANGELOG.md`
  - `CODE_OF_CONDUCT.md`
  - `CONTRIBUTING.md`
  - `LICENSE`
  - `README.md`
  - `SECURITY.md`
  - `analyzer-prompt.js`
  - `docs/autonomy-contract.md`
  - `docs/configuration.md`
  - `docs/internals.md`
  - `package.json`
  - `self-evolve-applier.js`
  - `self-evolve-bridge.js`
  - `self-evolve-client.js`
  - `self-evolve-commands.js`
  - `self-evolve-core.js`
  - `self-evolve-export.js`
  - `self-evolve-integration.js`
  - `self-evolve-inventory.js`
  - `self-evolve-lock.js`
  - `self-evolve-observation.js`
  - `self-evolve-pipeline.js`
  - `self-evolve-privacy.js`
  - `self-evolve-projection.js`
  - `self-evolve-scheduler.js`
  - `self-evolve-schemas.js`
  - `self-evolve-state-root.js`
  - `self-evolve-store.js`
  - `self-evolve-synthesis.js`
  - `self-evolve-tui-store.js`
  - `self-evolve-tui.js`
  - `self-evolve-tui.tsx`
  - `self-evolve-ui-protocol.js`
  - `self-evolve.js`

## Compatibility Inputs

- Declared OpenCode host range: `>=1.18.3 <1.19.0`
- Optional plugin peer range: `~1.18.3`
- Fixed floor lane: OpenCode and `@opencode-ai/plugin` `1.18.3`
- Fixed adjacent lane: OpenCode and `@opencode-ai/plugin` `1.18.4`
- Latest-supported lane: OpenCode and `@opencode-ai/plugin` `1.18.9`, the latest common stable aligned `1.18.x` pair resolved from the npm registry at `2026-07-30T00:12:32.471Z`
- OpenTUI peers: `@opentui/core`, `@opentui/keymap`, and `@opentui/solid` `0.4.3`
- Solid peer: `solid-js` `1.9.12`

## Validation Record

- `npm test` — passed: 644 tests, 0 failed. One managed-sandbox rerun produced inconsistent child-process failures that did not reproduce in focused runs; the authoritative permitted full-suite rerun passed 644/644.
- `npm run check` — passed: TypeScript check, raw TUI artifact contract, disposable Bun transpilation, and every Node syntax check. The managed sandbox initially denied the nested Bun spawn with `EPERM`; the authoritative permitted rerun passed.
- `npm run pack:check` — passed: 34 exact files; raw TUI target validated; server target imported from a fresh peerless consumer.
- `npm run test:tui-matrix` — passed: aligned packed TUI consumers at exact floor `1.18.3`, fixed adjacent `1.18.4`, and resolved latest-supported `1.18.9`; all observed the exact requested OpenCode/plugin versions and fixed TUI peers.
- `npm run smoke:live` — passed against local OpenCode `1.18.9`: official health/version agreement, both target loads, durable integration, restart-mode behavior, production command route, mailbox lifecycle, and cleanup.
- `git diff --check` — passed.

Exact-host interactive renderer evidence (mouse, focused Enter, narrow/wide layout, route/workspace switches, restart handoff, and visual inspection): **WAIVED, NOT PASSED** by owner direction for this candidate. Deterministic target/store/integration tests do not substitute for that evidence.

## Migration, Disable, And Rollback

Release A makes the conditional sidebar card, mounted native review dialog, and `self-evolve.control-center` palette route the normal TUI workflow. Existing `/self-evolve ...` commands remain supported for headless operation, bootstrap recovery, and migration compatibility. The release does not retire or rewrite stored settings, records, proposals, or snapshots.

After installing or changing package/TUI registration, restart OpenCode; existing sessions retain the already-loaded targets. To disable durable autonomy without deleting state, set `durableAutonomy: false` and restart. To suspend autonomous application while preserving the stored mode preference, use the native kill switch, set `SELF_EVOLVE_KILL=1` before startup, or use `/self-evolve kill-switch on` headlessly.

Rollback is package/configuration rollback followed by an OpenCode restart. The previous server target remains headless-safe, and slash commands remain available during the compatibility window. Do not delete the state root to roll back code. If deletion is explicitly intended, use the scoped native/headless purge controls and treat purge-all as terminal for the current runtime.

## Residual Risks And Release Boundary

- Exact-host mouse, keyboard, narrow-layout, route-switch, restart, and visual interaction evidence is an operator gate; deterministic tests do not substitute for it.
- The latest-supported lane is registry-derived and may resolve to a newer stable `1.18.x` patch on a later run.
- The candidate is built from an intentionally dirty working tree, so the source commit alone does not identify it; use the artifact and inventory hashes in this record.
- Independent verification remains owner review after handoff and was not self-passed.
- Publication authorization, registry readback, tag creation, and GitHub Release creation are outside candidate preparation and were not performed.
