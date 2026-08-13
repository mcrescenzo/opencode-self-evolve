# Configuration Reference

Self-Evolve v0.4 has one normal operating preference: **Automatic recommendations** is On or Off. Fresh, supported legacy-migrated, and authenticated-reinitialized installations start On. This preference never authorizes a skill-file write.

The normative authority, migration, protocol, and no-backfill rules are in [autonomy-contract.md](autonomy-contract.md).

## Installation And Registration

Use OpenCode's native installer:

```sh
opencode plugin @mcrescenzo/opencode-self-evolve --global
```

Omit `--global` only when intentionally registering the package for one project. The installer writes the server registration in `opencode.json` and native UI registration in `tui.json`. Restart OpenCode after either registration changes; Self-Evolve never silently rewrites host configuration.

The ordinary package registration is a string:

```json
{
  "plugin": ["@mcrescenzo/opencode-self-evolve"]
}
```

Register the TUI package root, not `/tui`, raw TSX, or the helper file:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["@mcrescenzo/opencode-self-evolve"]
}
```

`self-evolve-tui.js` is target-only host wiring, not a standalone registration. Replace any direct `self-evolve-tui.js` or `self-evolve-tui.tsx` registration with the package root.

The public root/server entry is plain Node ESM. The target-exclusive `./tui` export is deterministic prebuilt `self-evolve-tui.generated.js`, authored in `self-evolve-tui.tsx`. A server-only consumer does not need the optional TUI peers.

Advanced local wrappers may narrow host support or provide matching server/TUI identity inputs such as `stateRoot` and `remoteUrl`. They cannot seed Automatic recommendations, data permissions, project participation, target authority, or write authority. The v0.1 `durableAutonomy: false`, startup mode, analyzer, and analyzer tuning options are removed.

## Host Compatibility And State Root

The supported stable host range is OpenCode `>=1.18.3 <1.19.0`, with `@opencode-ai/plugin ~1.18.3`. Host version and state-root discovery use official bounded host surfaces and fail closed on disagreement, malformed results, unsupported versions, redirects, authentication failures, or timeouts. User options cannot widen host support.

State-root precedence is:

1. validated explicit `stateRoot`;
2. synchronous official server/TUI state;
3. bounded official path API;
4. `XDG_STATE_HOME` or HOME reconstruction only when official APIs are absent.

Before host/root validation completes, the one lifecycle `event` hook is inert. Passive `chat.message` is never registered.

Durable state remains below the OpenCode state root. Important global files include:

```text
<stateRoot>/.self-evolve-root-epoch.json
<stateRoot>/.self-evolve-breaker-epoch.json
<stateRoot>/.self-evolve-automation-epoch.json
<stateRoot>/self-evolve/global/settings.json
<stateRoot>/self-evolve/global/contributions/
<stateRoot>/self-evolve/global/candidates/
<stateRoot>/self-evolve/global/recommendations/
<stateRoot>/self-evolve/global/decisions/
<stateRoot>/self-evolve/<projectFingerprint>/
<stateRoot>/self-evolve/bridge/<projectFingerprint>/
```

The terminal, breaker, and automation epochs are separate authority domains. None substitutes for another.

## Automatic Recommendations

| Setting | Fresh default | Meaning |
|---|---:|---|
| `automaticRecommendationsEnabled` | `true` | On admits future eligible automatic work; Off stops it and advances the automation epoch. |
| `durableObservations` | `true` | Required permission for durable typed evidence. |
| `sanitizedExcerpts` | `true` | Required permission for bounded heuristically scrubbed capsules. |
| `crossRepoAggregation` | `true` | Required permission for identity-free cross-project support. |
| project `excluded` | `false` | Include/Exclude is the only project participation switch. |
| `killSwitchActive` | `false` | Emergency Stop suppresses automatic work and new Apply without rewriting the preference. |

Turning On atomically enables all three required permissions and advances the automation epoch once. Turning Off advances it once but does not purge retained data. Revoking any required permission atomically turns automation Off, advances the epoch, and performs that permission's existing cleanup/invalidation duties. Restoring a permission leaves automation Off; use an explicit On transition to restart future work.

Every valid v0.2/v0.3 Manual, Auto, Yolo, repository-mode, and paused state migrates exactly once to On/all-required-permissions. Existing project exclusions and Emergency Stop survive. Malformed, corrupt, or unsupported authority opens Off. A valid v0.4 Off or revocation is never replaced by replayed migration.

Off is a cross-process generation boundary. It fences late provider results, supersedes only unfinished pre-recommendation work, preserves published recommendations, and seeds future cursors so Off-window activity and pre-Off support are not backfilled after re-enable.

Operational suppressors such as preboot validation, project exclusion, Emergency Stop, circuit breaker, budget/quiet period, host failure, and corrupt state remain separate from the preference. They may prevent work while the stored preference stays On.

## Existing And New Skill Targets

Existing local global skills require no Self-Evolve root setup. Self-Evolve builds a read-only catalog only when OpenCode's global path, global configuration, and resolved-skill projections agree on a canonical local global skill. Standard global config, `OPENCODE_CONFIG_DIR`, global `.agents`/`.claude` compatibility roots, and global local `skills.paths` entries are eligible under the exact rules in the normative contract.

Project `.opencode/.agents/.claude` skills, project-configured paths, remote/URL catalogs, embedded/built-in skills, caches, ambiguous duplicates, malformed frontmatter, symlinks, unsafe ownership/modes, nested collection ambiguity, and drift are excluded. Catalog inspection remains read-only while automation is Off.

New-skill recommendations still require one explicit operator-selected creation root. Compatibility allowlist suggestions never grant authority. A model cannot choose a root, and new publication remains `must-not-exist` and create-exclusive.

## Explicit Recommendation Actions

Automatic recommendations On never creates an Apply or Undo decision. Off does not itself suppress review actions.

- **Apply** requires a fresh operator decision and current recommendation, support, permission, target provenance/path/hash, critic, deterministic, nonce, version, grant, lease, and integrity proofs. Privacy revocation blocks Apply; restoring permission may restore Apply while automation remains Off.
- **Reject** is file-free and remains available while Off or after privacy revocation.
- **Undo** requires exact snapshot, current applied hash, path, transaction, grant, and lease proof. It remains available while Off and after privacy/support revocation, Emergency Stop, or breaker trip when those exact integrity proofs pass.

Existing recommendations remain visible while Off. New Apply is suppressed by Emergency Stop and an open circuit breaker; exact risk-reducing Undo is not stranded by them.

## Headless Commands

The persistent native control center is the normal workflow. Retained headless commands are recovery and compatibility surfaces with their existing names and exact confirmation tuples. Run `/self-evolve help` for the current syntax.

| Surface | v0.4 disposition |
|---|---|
| `/self-evolve on`, `/self-evolve off` | Sole headless preference transitions. |
| bare command, `help`, `status`, `inbox`, `budget`, `health` | Retained. |
| `review`, exact `approve`, `reject`/`dismiss`, `snooze`, `undo` | Retained. |
| `include`, `exclude` | Retained project participation. |
| retained permission controls | Durable observations, sanitized excerpts, cross-project aggregation only. |
| allowlist suggestions, root-policy editor, inspect, export, purge | Retained with existing authority and scopes. |
| `kill-switch`, `reset-breaker`, `reinitialize` | Retained under those names. |
| `scan`, `manual`, `auto`, `yolo`, `repo`, `pause`, `resume`, `disable`, passive consent | Removed; requests return deterministic migration guidance without material reads or effects. |

Purge-all and reinitialize confirmations include version `0.4.0`. Purge-all is accepted-terminal and cannot be reversed by restart alone; authenticated reinitialize establishes a fresh root epoch and On/all-required-permissions baseline.

## Native Control Center And Mixed Versions

The persistent sidebar renders exactly four sections: Home, Recommendations, Activity, and Settings. Activity is bounded semantic history and never a raw-log viewer. Settings shows one Automatic recommendations switch, the three retained data permissions, project Include/Exclude, Emergency Stop, budgets/retention, creation-root policy, and maintenance controls. It does not show Manual/Auto, project mode, Pause, scan, or passive consent.

The dashboard distinguishes stored Off from operational suppression, exclusion, quiet/budget state, Emergency Stop, breaker, unsupported host, and corruption. Existing recommendations and their action-specific reasons remain visible while Off.

Mixed v0.3/v0.4 server/TUI pairs are read-only limited. A new TUI with an old server may show valid core review data but submits no write. An old TUI with a new server may show the unchanged core projection but submits no write. Compatibility uses the exact Release A capability vocabulary, including legacy `dashboard-v1`, only for bounded read-only negotiation. An old peer cannot infer a new capability from package version, and old writable control requests are rejected rather than mapped to On/Off or another retained control.

## Budgets And Retention

Budgets remain hard ceilings for automatic provider calls, synthesis, concurrency, quiet periods, idle debounce, and storage. Budget denial has no effect on the stored preference and grants no write authority.

Default retention remains 30 days for project evidence, capsules, contributions, candidates, and support; 90 days for recommendations, audits, decisions, and rollback authority; 24 hours for retained bridge artifacts; at most 60 seconds for action authority; and at most one hour for global lease safety. Active recommendation/rollback chains retain required material until terminal.

## Restart Rules

On/Off, permissions, project Include/Exclude, Emergency Stop, budgets, retention, recommendation actions, and creation-root policy are observed through durable state and do not need a restart. Restart after plugin registration, `opencode.json`/`tui.json`, startup identity options, or plugin source changes; running sessions keep already-loaded code and skills.
