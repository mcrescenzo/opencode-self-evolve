# Configuration Reference

`self-evolve` has two configuration layers: durable v0.2 autonomy settings stored under the OpenCode state root, plus 13 options for the explicit v0.1 compatibility analyzer. Durable `manual` is the fail-closed package default.

## Plugin Options

OpenCode 1.18.3 documents package plugin entries as strings; it does not document a `[package, options]` tuple. The ordinary package registration therefore uses:

```json
{
  "plugin": ["@mcrescenzo/opencode-self-evolve"]
}
```

No wrapper is needed for normal v0.2 use. To supply advanced startup identity or compatibility options, create a project-local `.opencode/plugins/self-evolve.mjs` wrapper and do not also list the npm package in `plugin`:

```js
import SelfEvolvePlugin from "@mcrescenzo/opencode-self-evolve";

export default (input) => SelfEvolvePlugin(input, {
  remoteUrl: "https://github.com/example/project",
});
```

Native review and the embedded-host version relay are separate TUI-plugin behavior. Register the package in `tui.json` as well:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["@mcrescenzo/opencode-self-evolve"]
}
```

For this repository's local checkout, use `"plugin": ["./plugins/self-evolve/self-evolve-tui.tsx"]` in the config root's `tui.json`. The raw TSX entry is loaded directly by OpenCode’s Bun TUI runtime; the package has no install-time build. If advanced identity options such as `stateRoot` or `remoteUrl` are supplied to the server wrapper, pass the same values in the supported TUI plugin-options tuple so both targets derive one partition. The TUI module ID is `mcrescenzo.self-evolve`. Restart OpenCode after changing either registration file.

The `./tui` export alone may reach the optional TUI peer contract: `@opencode-ai/plugin ~1.18.3`, `@opentui/core`, `@opentui/keymap`, and `@opentui/solid` in `>=0.4.3 <0.5.0`, plus `solid-js 1.9.12`. A server-only host may omit them all. The package root remains plain Node ESM and imports neither the raw TSX entry nor any TUI peer.

Durable v0.2 is enabled unless `durableAutonomy: false` explicitly selects legacy v0.1 compatibility. Startup `mode` is not authority and does not initialize or override durable preferences. `/self-evolve manual|auto|yolo` and `/self-evolve repo ...` are authoritative. After the factory returns, the server bounds host-version resolution: it uses `client.global.health()` when present, then falls back after only a recognized SDK transport/capability failure to GET `/global/health` at the exact HTTP(S) origin from official `PluginInput.serverUrl`; an absent SDK method uses that official HTTP path directly. Authentication and other authoritative SDK failures do not fall back. Transient transport failures and cancellable fallback timeouts retry with exponential backoff inside a fixed five-second startup window.

When an embedded TUI exposes neither global-health route, the registered package TUI target may relay official `api.app.version` in `<stateRoot>/self-evolve/bridge/<projectFingerprint>/tui-host-health.json`. This operational report has an exact schema, `0600` publication, project and canonical-root binding, a same-account live publisher PID, a random generation nonce, and at most a 60-second lifetime. Consumption requires effective-UID ownership of the state root, report, and bridge ancestors, exact `0600` report permissions, and no group/other writes on the state root or bridge ancestors; `EPERM` and platforms without effective-UID validation fail closed. The TUI refreshes it every 15 seconds and conditionally removes only its own generation on disposal. The server consults it only after official global health is unavailable and still validates the official state root before opening a store or granting command/event authority. The report is trusted local same-account IPC from this package's TUI target, not cryptographic authentication against other code running as the same OS user.

After exhausted transient-unavailable startup, only the first later `/self-evolve` command performs one fresh bounded version, root-validation, and boot attempt. Health that remains unavailable stops before store creation; if version resolution succeeds but later boot fails, bounded internal boot/recovery state may exist, but the requested command does not change mode, call its provider path, or mutate a skill. A timed-out generated SDK call fails closed without an overlapping request or fallback; invalid official inputs, authoritative SDK/HTTP failures, unhealthy or malformed responses, and unsupported versions do not retry. Autonomous startup accepts only a healthy or current-TUI-reported stable version `>=1.18.3 <1.19.0`; stable build metadata is accepted, prereleases are not. Exhausted, unavailable, timed-out, authoritative-error, unhealthy, malformed, prerelease, older, 1.19+, and 2.x hosts remain manual and report the observed version or `unknown` with a sanitized diagnostic. `hostVersion`, `hostSupported: true`, and user URL options are not production authority; `hostSupported: false` remains a deliberate narrowing control.

`/self-evolve health` reports `source global-health` for the normal SDK/HTTP path and `source tui-app-version` when the embedded-host relay supplied the accepted version.

State-root precedence is: validated explicit `stateRoot`; synchronous official host state (`ctx.path.state` server or `api.state.path.state` TUI); bounded official `client.path.get()`; environment reconstruction from `XDG_STATE_HOME` or HOME only when official APIs are absent. A synchronous candidate may be read before validation only to select persisted hook shape. Persisted manual has no passive `event`; persisted auto/yolo may expose a provisional hook whose handler returns immediately while no validated runtime is installed and has no integration or authority. Commands report `startup-validation-pending`. Only after health succeeds does the shared deferred task resolve or validate every root kind, open the store, run boot recovery, and grant command/event authority. Exhausted timeout/unavailability or disagreement fails closed without root migration or merge. Restart after a mode command so hook shape reflects the persisted preference.

Legacy compatibility is deliberate and explicit:

```js
import SelfEvolvePlugin from "@mcrescenzo/opencode-self-evolve";

export default (input) => SelfEvolvePlugin(input, {
  durableAutonomy: false,
  minConfidence: 0.8,
  maxProposals: 2,
});
```

## Durable Layout And Reload

```text
<stateRoot>/self-evolve/global/settings.json
<stateRoot>/self-evolve/global/aggregates.jsonl
<stateRoot>/self-evolve/<projectFingerprint>/settings.json
<stateRoot>/self-evolve/<projectFingerprint>/*.jsonl
<stateRoot>/self-evolve/bridge/<projectFingerprint>/{requests,responses}/
<stateRoot>/self-evolve/bridge/<projectFingerprint>/{control-requests,control-responses}/
<stateRoot>/self-evolve/bridge/<projectFingerprint>/control-state.json
<stateRoot>/self-evolve/bridge/<projectFingerprint>/tui-host-health.json
```

Global settings are written once in the global namespace and are shared by every project partition. Repository settings and records remain inside the fingerprinted project partition. The TUI host-health file is short-lived operational IPC, participates in project/mailbox quota accounting, is removed when expired, dead, disposed, or purged, and is omitted from exports. Every command, scheduled cycle, decision, apply authorization, excerpt operation, and aggregate contribution/read must read fresh global and repository settings before acting; long-lived processes must not treat startup settings as authority. Thus an auto/yolo process observes pauses, consent revocation, mode downgrades, allowlist changes, and kill switches before its next cycle/apply. Event routing is the narrow exception: only idle/status/compaction lifecycle events are admitted, and active auto/yolo bursts may reuse a non-authoritative settings snapshot for at most 250 milliseconds. Manual routing results are not cached; local command/control/kill-switch writes invalidate immediately; cross-process changes become visible at expiry; and the scheduled cycle still rereads settings before any durable or provider action. Stream deltas never poll settings or the mailbox. All field changes use store updater callbacks whose read and write share one cross-process mutation-lock critical section; the combined updater handles transitions that inspect both scopes. Optional global `updatedAt` CAS returns `stale-settings-version` rather than applying stale state. Restart after changing mode or startup-only plugin options.

The **Self-evolve control center** opens from the persistent sidebar indicator and from its palette-only command, which has no slash metadata. Its mounted Settings section reads validated `control-state.json` and submits bounded create-exclusive controls for global manual/auto/yolo mode, all four consent keys, repository exclusion, and canonical allowlist replacement. Review, Safety, and Maintenance use separate exact operation envelopes for Snooze, Undo, kill switch, pause/resume, scoped purge, purge-all, sensitive export, and bounded bootstrap retry. Project, canonical state-root identity, projection generation/hash, capability, expiry, settings or proposal version, and one-use nonce are revalidated by the server. Stale, replayed, unsupported, or cross-scope requests fail closed.

Project identity is `SHA-256` over the canonical JSON tuple `['self-evolve-project-v1', sourceKind, canonicalSource, canonicalAbsoluteWorktreePath]`. Both targets call one resolver with the same inputs. A valid explicit `projectFingerprint` is preferred only when it matches the identity derivable from the other supplied inputs; invalid or conflicting values fail closed. Otherwise `remoteUrl` comes from the same plugin option in both targets, and the worktree comes from `ctx.worktree` on the server or `api.state.path.worktree` in the TUI, falling back deterministically to each host's directory. OpenCode 1.18.3 documents TUI path/worktree state but no supported remote URL, so the plugin option is the supported way to provide a remote to both targets. Because the worktree path is always included, clones and linked worktrees partition separately, and repository relocation creates a new partition. Monorepo subprojects are scopes within one checkout partition.

Auto headless approval uses `/self-evolve approve <proposal-id> --target-hash <sha256> --proposed-content-hash <sha256> --decision-version <integer> --nonce <one-use-nonce>`. All values are required and revalidated against the current proposal; a bare ID, stale version, hash mismatch, or replayed nonce fails closed.

The 13 `DEFAULT_OPTIONS` entries are:

| Option | Default | Meaning |
|---|---|---|
| `minIntervalMs` | `600000` | Display-only cooldown timestamp after a legacy scan result. `reserveAnalysis` does not enforce this value, so it must not be relied on as a rate limit. |
| `maxAnalyzerRuns` | `8` | Maximum legacy analyzer runs per session. |
| `maxProposals` | `3` | Maximum accepted legacy proposals per session. |
| `maxAnalyzerFailures` | `3` | Disables the legacy session after repeated counted failures. |
| `messageLimit` | `120` | Recent messages considered for bounded transcript construction. |
| `transcriptMaxChars` | `30000` | Maximum transcript characters sent to the legacy analyzer. |
| `messageMaxChars` | `2000` | Maximum characters retained from each message. |
| `minConfidence` | `0.72` | Minimum confidence accepted by legacy proposal validation. |
| `analyzerTimeoutMs` | `120000` | Analyzer prompt timeout. |
| `sdkTimeoutMs` | `15000` | SDK read and analyzer-session creation timeout. |
| `cleanupTimeoutMs` | `5000` | Best-effort analyzer-session cleanup timeout. |
| `deliveryTimeoutMs` | `5000` | Legacy compatibility delivery timeout; the normal native TUI emits no toast. |
| `maxRegistrySessions` | `200` | Lazy cap for inactive in-memory legacy session states. |

The cooldown behavior above is intentionally documented rather than changed in v0.2: enforcing it would alter the shipped v0.1.2 manual behavior. Durable autonomy has separate scheduler budgets and debounce controls.

## Modes And Scope

| Setting | Default | Meaning |
|---|---|---|
| Global mode | `manual` | `manual`, `auto`, or `yolo`; unknown/corrupt values fail closed to manual. |
| Repository mode | `inherit` | `inherit`, `manual`, `auto`, or `yolo`. |
| Repository exclusion | `false` | Excluded repositories cannot run autonomous work. |
| `allowedSkillRoots` | `[]` | Canonical absolute skill roots. Required for yolo application; no globbing and no symlink expansion. |
| `SELF_EVOLVE_KILL` | unset | `1` or `true` forces a process-local manual downgrade without rewriting stored mode. |

Yolo activation requires explicit confirmation and an allowlist:

```text
/self-evolve yolo confirm --allowlist /absolute/path/to/skills
```

## Consent

All consent keys default to `false` and are independently controlled with `/self-evolve consent ... on|off`.

| Stored key | Command key | Meaning |
|---|---|---|
| `passiveCalls` | `passive` | Permit provider calls at stable idle boundaries. |
| `durableObservations` | `observations` | Permit automatic durable structured observations. |
| `sanitizedExcerpts` | `excerpts` | Permit bounded sanitized evidence excerpts; redaction is not a secrecy guarantee. |
| `crossRepoAggregation` | `cross-repo` | Permit strict normalized global-skill claims; requires excerpt consent. |

Manual invocation can record bounded observations for that invocation without enabling passive work. Complete transcripts, raw message bodies, and raw host session/message IDs are never persisted. Durable scans store only domain-separated SHA-256 session-lineage and last-message cursor hashes. If the prior cursor is no longer present in the bounded 120-message host window, the scan audits the gap and advances without deriving evidence from the unknown overlap. A transient empty host response preserves an established cursor and derives no evidence.

Cross-project aggregation is disabled unless both `sanitizedExcerpts` and `crossRepoAggregation` are true. Only the exact normalized claim schema in `docs/autonomy-contract.md` may be appended to `global/aggregates.jsonl`; no paths, names, customer details, commands, or text are allowed. Revoking either consent stops new aggregation. Project purge removes that project's indexed contributions; purge-all removes all aggregates.

## Budgets

| Budget | Default |
|---|---:|
| `passiveCallsPerHour` | `6` |
| `synthesisPerDay` | `24` |
| `tokensPerSynthesis` | `8000` |
| `concurrentObservationsPerProject` | `1` |
| `concurrentSynthesesGlobal` | `1` |
| `idleDebounceMs` | `1500` |
| `storageQuotaMiB` | `8` |

`passiveCallsPerHour` is a rolling-hour ceiling on actual hidden provider-call slots used by passive auto/yolo work, not on scheduler cycles. Once evidence is eligible, the scheduler acquires a project-scoped process-aware reservation lease, re-reads current budgets and durable reservations, and writes one durable `scheduler-budget` / `passive` audit per slot before either provider call starts. Synthesis and critic require two slots as one operation; if fewer than two remain, neither hidden session starts. Both slots remain conservatively charged when the later synthesis no-ops or either call fails. Explicit manual scans neither reserve nor consume passive slots.

Budget exhaustion fails closed. `synthesisPerDay` remains a separate scheduler budget. The legacy `notificationsPerHour` field remains readable for durable-state compatibility but is not projected and has no Release A scheduling or UI effect. The scheduler accepts `quietHours` as process-startup periods in local time:

`storageQuotaMiB` is one cap over the complete project-associated durable partition: repository settings, all JSONL files, indexes, rollback snapshots, leases, quarantine files, and project bridge files. It is not multiplied by the number of files. Store and TUI mailbox publishers calculate current plus projected replacement bytes under the same cross-process mutation lock and reject symlinks. Decision, control, and operation requests share a 64-file ceiling and a mailbox sub-budget of `min(512 KiB, storageQuotaMiB / 8)`; each pending request reserves the maximum 4 KiB response, and growing mailbox writes preserve up to 64 KiB (or one eighth of a smaller quota) for later store writes. Native export artifacts use a separate bounded temporary-export quota. A safety-mandatory settings audit envelope of at most 4 KiB is the only documented quota bypass; ordinary records and recursive failure audits remain capped.

```json
{
  "quietHours": [
    { "from": "22:00", "to": "07:00" }
  ]
}
```

Quiet periods suppress autonomous scheduling. Equal endpoints disable a period, and an overnight period wraps across midnight. `quietHours` is currently a scheduler-only rollout option, not part of the persisted `Budgets` schema.

## Retention

| Data class | Default |
|---|---:|
| Observations, receipts, episode cursors, evidence clusters, and eligibility records | 30 days |
| Proposals, decisions, audits, rollback/intervention/circuit records, and rollback snapshots | 90 days |
| Bridge request/response envelopes | 24 hours |
| TUI host-version runtime report | At most 60 seconds; revoked on clean disposal |
| Global aggregate claims | 30 days |

`retentionDays` sets the observation/evidence window and the default aggregate `expiresAt` when a claim is created. Proposal, decision, audit, rollback, intervention, circuit, and snapshot retention is three times that value. Existing aggregate claims retain their explicit `expiresAt`; later configuration changes do not rewrite them. Decision/control/operation bridge TTL and the shorter operational TUI-report TTL are fixed. Synthesis-attempt and proposal-content recovery runs before the startup sweep and autonomous scheduling; sweeps then run daily on one unrefed timer, with expired bridge files also eligible for removal during idle polling.

The latest `critic-pending`, `pending`, `approved`, or `applied` proposal and its linked decision/audit records are retained past the nominal window until terminal. Typed proposal-content chunks receive the same protection, so an old pending proposal remains review/apply capable. Rejected, failed-closed, superseded, and rolled-back transitions compact those chunks immediately in the recoverable decision transaction; proposal purge removes chunks for every removed draft/pending record. Boot and ordinary reads finish interrupted compaction before inbox/export access. Required applied snapshots remain protected; unlinked snapshots have a 90-day default grace period. Sweeps reclaim dead process-aware leases and expired legacy PID-less leases, compact aggregate claims, repair all project contribution indexes, and remove empty indexes without following symlinks. A live PID remains authoritative even if a synthetic or wall clock passes `expiresAt`.

Project purge includes records, snapshots, projection/mailbox data, native export artifacts, and indexed aggregate contributions but preserves global settings and reinitializes only that project. Purge-all removes the complete `self-evolve/` subtree and is terminal for the loaded store/integration. Native purge-all publishes an authenticated `accepted-terminal` acknowledgement before bounded deletion; the TUI never infers completion only from disappearance. Restart OpenCode to reinitialize.

Native sensitive exports require the exact confirmation `EXPORT SENSITIVE SELF-EVOLVE DATA`. They stream under `<state-root>/self-evolve/exports/<projectFingerprint>/` using private directories, exclusive `0600` files, one active job per project, a separate temporary quota, SHA-256/size/expiry metadata, and expiry/startup cleanup. They never open automatically and are removed by every purge. Active skill content and rollback snapshots are sensitive. The retained headless export commands remain available during Release A.

## Rollout Gates

The integration accepts a `rolloutGates` startup object. These are deployment controls, not user-visible modes:

| Gate | Default | Meaning |
|---|---:|---|
| `offlineCorpus` | `false` | Records whether the offline corpus gate has been completed. |
| `passiveShadowObservation` | `false` | Stops passive work after correlation; no synthesis or apply. |
| `automaticSynthesisApplicationDisabled` | `false` | Forces synthesis/application paths to advisory behavior. |
| `autoReviewRollout` | `true` | Enables automatic proposal review flow in auto mode. |
| `yoloEnablementThreshold.minSynthesesObserved` | `10` | Minimum observed synthesis count before yolo release. |
| `yoloEnablementThreshold.minSuccessRate` | `0.8` | Minimum synthesis success rate before yolo release. |

Yolo rollout history comes only from retained `synthesis-outcome` audit records in the current project partition. Before every production provider call, a strict content-free `synthesis-attempt` admission binds one stable outcome ID to the project, cluster, target hash, proposal ID, and admission time; failed admission means no call. Every admission converges to exactly one terminal outcome. `accepted` requires deterministic validation, critic pass, and complete hash-verified typed proposal content; valid `no-change` outcomes are also successes. Missing, corrupt, mixed, or partial content produces a failed outcome and never counts as accepted. Boot recovers admissions without outcomes before scheduling and never repeats the provider call. `critic-rejected` and `failed` outcomes are failures. Both the minimum observed count and success rate must pass. Unknown, malformed, cross-project, or duplicate records do not increase authority, and legacy diagnostic audits never count. Startup options or test callbacks named `rolloutMetrics` or `getRolloutMetrics` are not authority inputs.

These gates cannot override privacy consent, canonical allowlists, deterministic validation, critic approval, budgets, exclusions, circuit breakers, or kill switches. Outcome audits use the ordinary proposal/audit retention window, three times `retentionDays`; history can therefore age below the threshold and block yolo again. Active proposal-chain protection is independent and remains unchanged.
