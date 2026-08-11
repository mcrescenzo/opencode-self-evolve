# Configuration Reference

`self-evolve` has two configuration layers: durable v0.2 autonomy settings stored under the OpenCode state root, plus 13 options for the explicit v0.1 compatibility analyzer. Durable `manual` is the fail-closed package default.

## Installation And Registration

Use OpenCode's native installer for the normal path:

```sh
opencode plugin @mcrescenzo/opencode-self-evolve --global
```

Omit `--global` for project scope. The installer writes both the server
registration in `opencode.json` and the native UI registration in `tui.json`;
the TUI palette's **Install plugin** command (`plugins.install`) invokes the
same installer. Restart OpenCode after either registration changes. The plugin
does not silently create or rewrite external configuration.

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

The native control center and embedded-host version relay are separate TUI-plugin behavior. Register the TUI export in `tui.json` as well:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["@mcrescenzo/opencode-self-evolve"]
}
```

The supported native target is the deterministic
`self-evolve-tui.generated.js` artifact exported by the package as `./tui`.
Register the bare installed package, not its `/tui` subpath. For this
repository's local checkout, use `"plugin": ["./plugins/self-evolve"]` in the
config root's `tui.json`; the TUI loader resolves the package directory's
`./tui` export. The TSX file remains the typechecked authoring source and is not
a supported registration target. `self-evolve-tui.js` remains a target-only
helper used by the generated wrapper, not a standalone registration. If an
external `tui.json` names `self-evolve-tui.js`, `self-evolve-tui.tsx`, or the
installed `/tui` subpath, replace only that entry with the package root or bare
package and restart OpenCode.

If advanced identity options such as `stateRoot` or `remoteUrl` are supplied to the server wrapper, pass the same values in the supported TUI plugin-options tuple so both targets derive one partition. The stable module ID is `mcrescenzo.self-evolve`; the hidden agents are `mcrescenzo.self-evolve.analyzer`, `mcrescenzo.self-evolve.synthesizer`, and `mcrescenzo.self-evolve.critic`, while the palette entry is `mcrescenzo.self-evolve.control-center`. Restart OpenCode after changing either registration file.

Mixed versions fail closed without gaining new authority. The v1 protocol offer
and core review index retain the exact Release A capability vocabulary. A new
TUI with an old server keeps valid core review behavior, labels current
surfaces limited, and submits no new request shape. An old TUI with a new server
reads that unchanged core projection and ignores the additive dashboard. The
four-section control center requires aligned targets; headless commands
and the durable inbox remain available according to the server version.

TUI bookkeeping uses package-owned `mcrescenzo.self-evolve:*` KV keys. On the first read of each canonical key, one bounded compatibility read may migrate a valid raw value from its former `self-evolve:*` key. Invalid canonical values and corrupt or oversized legacy values are preserved and ignored rather than overwritten; legacy keys are never written. This fallback is a one-release migration window and keeps old/new peers able to read the same raw value.

The `./tui` export alone may reach the optional TUI peer contract: `@opencode-ai/plugin ~1.18.3`, `@opentui/core`, `@opentui/keymap`, and `@opentui/solid` in `>=0.4.5 <0.6.0`, plus `solid-js 1.9.12`. A server-only host may omit them all. The package root remains plain Node ESM and imports neither the generated TUI entry nor any TUI peer. The packed consumer matrix verifies both the 0.4.5 floor and 0.5.0 current line without legacy peer-resolution bypasses; 0.6.x is rejected by the declared peer contract. Coexistence with OpenCode Workflows uses their shared 0.4.5 lane because Workflows currently narrows its OpenTUI peers below 0.5.0.

Durable autonomy is enabled unless `durableAutonomy: false` explicitly selects legacy v0.1 compatibility. Startup `mode` is not authority and does not initialize or override durable preferences. Project analysis modes are exactly `manual` and `auto`; repository overrides are `inherit`, `manual`, or `auto`. The retired `yolo` input is refused by the command and bridge surfaces, and a stored v0.2 value normalizes to Auto with no unattended write authority. After the factory returns, the server bounds host-version resolution: it uses `client.global.health()` when present, then falls back after only a recognized SDK transport/capability failure to GET `/global/health` at the exact HTTP(S) origin from official `PluginInput.serverUrl`; an absent SDK method uses that official HTTP path directly. Authentication and other authoritative SDK failures do not fall back. Transient transport failures and cancellable fallback timeouts retry with exponential backoff inside a fixed five-second startup window.

Durable global mode, consent, budgets, and skill-folder suggestions are shared by every project in the same OpenCode installation, so their setup carries forward to future projects. In v0.3, suggestions do not authorize inventory or writes: authority comes only from the separately validated operator-selected `globalRootPolicy`, including exact root capabilities and `creationRootId`. Repository mode and exclusion remain project-specific overrides. There is intentionally no checked-in wrapper or startup option that seeds authority for a team or machine image; adding one would change the durable precedence and consent contract and requires an explicit contract amendment.

When an embedded TUI exposes neither global-health route, the registered package TUI target may relay official `api.app.version` in `<stateRoot>/self-evolve/bridge/<projectFingerprint>/tui-host-health.json`. This operational report has an exact schema, `0600` publication, project and canonical-root binding, a same-account live publisher PID, a random generation nonce, and at most a 60-second lifetime. Consumption requires effective-UID ownership of the state root, report, and bridge ancestors, exact `0600` report permissions, and no group/other writes on the state root or bridge ancestors; `EPERM` and platforms without effective-UID validation fail closed. The TUI refreshes it every 15 seconds and conditionally removes only its own generation on disposal. The server consults it only after official global health is unavailable and still validates the official state root before opening a store or granting command/event authority. The report is trusted local same-account IPC from this package's TUI target, not cryptographic authentication against other code running as the same OS user.

After exhausted transient-unavailable startup, only the first later `/self-evolve` command performs one fresh bounded version, root-validation, and boot attempt. Health that remains unavailable stops before store creation; if version resolution succeeds but later boot fails, bounded internal boot/recovery state may exist, but the requested command does not change mode, call its provider path, or mutate a skill. A timed-out generated SDK call fails closed without an overlapping request or fallback; invalid official inputs, authoritative SDK/HTTP failures, unhealthy or malformed responses, and unsupported versions do not retry. Autonomous startup accepts only a healthy or current-TUI-reported stable version `>=1.18.3 <1.19.0`; stable build metadata is accepted, prereleases are not. Exhausted, unavailable, timed-out, authoritative-error, unhealthy, malformed, prerelease, older, 1.19+, and 2.x hosts remain manual and report the observed version or `unknown` with a sanitized diagnostic. `hostVersion`, `hostSupported: true`, and user URL options are not production authority; `hostSupported: false` remains a deliberate narrowing control.

`/self-evolve health` reports `source global-health` for the normal SDK/HTTP path and `source tui-app-version` when the embedded-host relay supplied the accepted version.

State-root precedence is: validated explicit `stateRoot`; synchronous official host state (`ctx.path.state` server or `api.state.path.state` TUI); bounded official `client.path.get()`; environment reconstruction from `XDG_STATE_HOME` or HOME only when official APIs are absent. Every durable instance returns one lifecycle `event` hook before validation. That hook is inert before validated boot and in configured Manual, and passive `chat.message` remains absent. Commands report `startup-validation-pending`. Only after health succeeds does the shared deferred task resolve or validate every root kind, open the store, run boot recovery, and grant command/event authority. Exhausted timeout/unavailability or disagreement fails closed without root migration or merge. Manual/Auto changes are observed without restart; startup-only plugin or registration changes still require one.

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
<stateRoot>/self-evolve/global/contributions/<uuid-prefix>/<contributionId>.json
<stateRoot>/self-evolve/global/leases/<key-prefix>/<leaseKeyHash>.json
<stateRoot>/self-evolve/<projectFingerprint>/settings.json
<stateRoot>/self-evolve/<projectFingerprint>/*.jsonl
<stateRoot>/self-evolve/<projectFingerprint>/contribution-intents/<uuid-prefix>/<intentId>.json
<stateRoot>/self-evolve/<projectFingerprint>/contribution-links/<uuid-prefix>/<contributionId>.json
<stateRoot>/self-evolve/bridge/<projectFingerprint>/{requests,responses}/
<stateRoot>/self-evolve/bridge/<projectFingerprint>/{control-requests,control-responses}/
<stateRoot>/self-evolve/bridge/<projectFingerprint>/control-state.json
<stateRoot>/self-evolve/bridge/<projectFingerprint>/tui-host-health.json
```

Global settings are written once in the global namespace and are shared by every project partition. Repository settings and records remain inside the fingerprinted project partition. The TUI host-health file is short-lived operational IPC, participates in project/mailbox quota accounting, is removed when expired, dead, disposed, or purged, and is omitted from exports. Every allowed lifecycle event, command, scheduled cycle, decision, apply authorization, excerpt operation, and contribution publication reads fresh global and repository settings before acting; long-lived processes do not treat startup settings as authority. Before boot, in Manual, or under an operational suppressor, the lifecycle handler returns before source-lineage hydration, session/message reads, provider calls, durable writes, contribution, or scheduler admission. Stream deltas return even earlier without polling settings or the mailbox. All field changes use store updater callbacks whose read and write share one cross-process mutation-lock critical section; the combined updater handles transitions that inspect both scopes. Optional global `updatedAt` CAS returns `stale-settings-version` rather than applying stale state. Restart only after changing startup-only plugin options or registration.

The **Self-evolve control center** opens from the persistent sidebar indicator and from its palette-only command, which has no slash metadata. It has exactly four sections: Home, Recommendations, Activity, and Settings. The sidebar uses the server-authored operational model to deep-link setup to Settings, review to the selected Recommendation, failures to Activity/Errors, and healthy or startup state to Home. Activity is a bounded semantic history and diagnostics surface, never a raw-log viewer.

Settings reads validated `control-state.json` and submits bounded create-exclusive controls for installation Manual/Auto, all four consent keys, repository exclusion, and compatibility collection suggestions. The authoritative global-root editor uses its own dashboard-v2 capability and strict operation envelope to replace exact canonical roots, update/create capabilities, and the sole primary creation root. Capability-advertised repository `inherit|manual|auto` changes use the native operation envelope rather than legacy repository-mode control. Recommendations and the shared shell use separate exact decision or operation envelopes for Apply, Reject with optional structured audit-only feedback, Snooze, Acknowledge, Undo, kill switch, pause/resume, scoped purge, purge-all, sensitive export, and bounded bootstrap retry. Project, canonical state-root identity, projection generation/hash, capability, expiry, settings or proposal version, and one-use nonce are revalidated by the server. Stale, replayed, unsupported, or cross-scope requests fail closed.

Optional additive dashboard sidecars supply enhanced readiness, actual usage, semantic activity, diagnostics, and current feature capabilities beside the unchanged core review index. Current servers publish strict `dashboard-v2` plus a `dashboard-v1` compatibility artifact; current readers prefer v2 and fall back to v1. Dashboard v2 projects operational retention as exactly three times observation retention through the full configured range, while v1 preserves its original independently bounded fields and representable compatibility values. Missing or malformed enhanced data yields a labeled limited view without invalidating valid core review data. Background refresh emits no toast, attention notification, auto-opened dialog, or route change. Manual scan stays an explicit source-session headless fallback.

Project identity is `SHA-256` over the canonical JSON tuple `['self-evolve-project-v1', sourceKind, canonicalSource, canonicalAbsoluteWorktreePath]`. Both targets call one resolver with the same inputs. A valid explicit `projectFingerprint` is preferred only when it matches the identity derivable from the other supplied inputs; invalid or conflicting values fail closed. Otherwise `remoteUrl` comes from the same plugin option in both targets, and the worktree comes from `ctx.worktree` on the server or `api.state.path.worktree` in the TUI, falling back deterministically to each host's directory. OpenCode 1.18.3 documents TUI path/worktree state but no supported remote URL, so the plugin option is the supported way to provide a remote to both targets. Because the worktree path is always included, clones and linked worktrees partition separately, and repository relocation creates a new partition. Monorepo subprojects are scopes within one checkout partition.

Auto headless approval uses `/self-evolve approve <proposal-id> --target-hash <sha256|must-not-exist> --proposed-content-hash <sha256> --decision-version <integer> --nonce <one-use-nonce>`. New-skill proposals use the exact `must-not-exist` target sentinel issued by inbox/review. All values are required and revalidated against the current proposal; a bare ID, stale version, hash mismatch, or replayed nonce fails closed.

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
| Installation analysis default | `manual` | `manual` or `auto`; legacy `yolo` normalizes to `auto`. Unknown/corrupt values fail closed to manual. |
| Repository analysis override | `inherit` | `inherit`, `manual`, or `auto`; legacy `yolo` migration input normalizes to `auto`. |
| Repository exclusion | `false` | Excluded repositories cannot run autonomous work. |
| `allowedSkillRoots` | `[]` | Compatibility/migration suggestions for candidate collection folders. These strings grant no v0.3 catalog or write authority. |
| `globalRootPolicy` | `null` | Exact operator-selected v0.3 global roots, update/create capabilities, and nullable primary `creationRootId`. Catalog discovery is direct-child-only and fails closed on nested parents, duplicates, symlinks, noncanonical roots, or drift. |
| `SELF_EVOLVE_KILL` | unset | `1` or `true` forces a process-local manual downgrade without rewriting stored mode. |

The v0.2 `yolo` command is retired. `/self-evolve yolo ...` and `/self-evolve repo yolo` are refused without changing any setting, and a `yolo` value read from a v0.2 partition or a v0.2 bridge peer narrows to analysis-only Auto. A bridge control request that asks for `yolo` is rejected with `yolo-retired`.

## Consent

All consent keys default to `false` and are independently controlled with `/self-evolve consent ... on|off`.

The compatibility headless allowlist commands inspect and update candidate collection-folder suggestions. `/self-evolve allowlist <add|remove> <canonical-absolute-path> --confirm UPDATE ALLOWLIST` does not create a v0.3 `GlobalRootPolicy`, choose capabilities, select a primary creation root, or authorize catalog access. Exact-root approval remains a separate explicit operator action.

Path-valued headless commands use a strict token grammar for `allowlist add|remove <path> ...`: unquoted whitespace separates tokens; matching single (`'`) or double (`"`) quotes preserve whitespace and are removed; and backslash (`\`) escapes exactly the next character, including whitespace, a quote, or another backslash. Quoted and unquoted segments may be joined within one token. Legacy paths without spaces remain unchanged. An unmatched quote, trailing backslash, unquoted path containing whitespace, or any token after the documented command shape rejects the whole command without changing settings. For example:

```text
/self-evolve allowlist add "/absolute/path/to/team skills" --confirm UPDATE ALLOWLIST
/self-evolve allowlist add /absolute/path/to/team\ skills --confirm UPDATE ALLOWLIST
```

| Stored key | Command key | Meaning |
|---|---|---|
| `passiveCalls` | `passive` | Permit provider calls at stable idle boundaries. |
| `durableObservations` | `observations` | Permit automatic durable structured observations. |
| `sanitizedExcerpts` | `excerpts` | Permit bounded project-local evidence capsules; redaction is heuristic, not a secrecy guarantee. Revocation deletes capsules before the settings transaction completes. |
| `crossRepoAggregation` | `cross-repo` | Permit identity-free global contribution publication; requires excerpt consent. |

Manual invocation can record bounded observations for that invocation without enabling passive work. With excerpt consent, one qualifying incident may also create one exact capsule in the originating project's `evidence-capsules.jsonl`; it never enters `global/`. Complete transcripts, raw message bodies, and raw host session/message IDs are never persisted. Durable scans store only domain-separated SHA-256 session-lineage and last-message cursor hashes. If the prior cursor is no longer present in the bounded 120-message host window, the scan audits the gap and advances without deriving evidence from the unknown overlap. A transient empty host response preserves an established cursor and derives no evidence.

Cross-project learning is disabled unless both `sanitizedExcerpts` and `crossRepoAggregation` are true. A local intent allocates one random UUID before create-exclusive publication to the sharded global contribution tree, then records one local link and commits. Global records contain only the exact schema in `docs/autonomy-contract.md`; no project/scope identity, paths, prose, excerpts, commands, sessions, observations, capsules, clusters, evidence domains, or local incidents are present. Revoking either consent stops new publication. The previous `global/aggregates.jsonl` path is compatibility input only and has no writable privacy/store interface.

Eligible global candidates synthesize only after a fresh state-root-global candidate lease and durable identity-free attempt admission. After hidden-session creation and ownership, each synthesizer or critic call revalidates consent, budgets, support, eligibility, target/root/catalog bindings, suppressors, and lease immediately before reservation and prompt dispatch, then rebuilds its in-memory prompt. The synthesizer receives at most eight domain-diverse capsule summaries, each at most 240 UTF-8 bytes and at most 4 KiB total. Existing targets remain exact catalog/hash bindings. New targets bind the configured primary creation root before dispatch; the model can suggest only a strict logical name and complete content, and the server then enforces must-not-exist and collision checks. A hidden critic and deterministic frontmatter, growth, server-derived exact/substantial-body overlap, injection, privacy, and generality gates must pass before canonical chunked recommendation persistence. A valid no-op durably completes the attempt with candidate state `no-change` and no recommendation. This path never applies a file; Apply and Undo belong to the separately explicit global decision lifecycle.

Every global Apply and Undo is a direct explicit decision transaction independent of project Manual/Auto mode. Writes serialize by approved root ID plus relative target path, so different recommendations or nonces cannot overwrite the same path concurrently. Immediately before mutation, the server rechecks the recommendation/version/nonce edge, support and consent, suppressors, root policy and catalog, duplicate names, path/symlink state, exact current or absent hash, content hash, critic result, and deterministic gates. Existing and new publication are fsync/readback verified and crash recoverable. Undo is allowed only while current bytes equal the recorded applied hash; it restores the exact prior existing bytes or removes only the exact plugin-created new skill. Identical retries return one durable outcome, while altered nonce reuse fails as a replay.

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

`passiveCallsPerHour` is a rolling-hour ceiling on actual hidden provider-call slots used by passive Auto work, not on scheduler cycles. After hidden-session ownership and the synchronous fresh-state boundary, each hidden synthesizer or critic call requires current `passiveCalls` consent and asks the scheduler for one slot immediately before prompt dispatch. The scheduler acquires a project-scoped process-aware reservation lease, re-reads current budgets and durable reservations, writes one durable `scheduler-budget` / `passive` audit, and verifies it before dispatch. A denied synthesizer slot starts no prompt. If exactly one slot remains, synthesis may run but the critic is denied and the attempt fails closed. No-op and pre-critic failure paths therefore consume only the synthesizer slot; explicit manual scans receive no passive reservation callback and neither require nor consume passive slots.

The global `synthesisPerDay` value is the stable aggregate process ceiling across all project stores. A repository override is additionally enforced by that project's durable admission and may further restrict the project, but it cannot raise the process-wide ceiling. One process-global arbiter also permits at most one active synthesis; its ledger contains only admission timestamps and resets on process restart.

Budget exhaustion fails closed. `synthesisPerDay` remains a separate scheduler budget. The legacy `notificationsPerHour` field remains readable for durable-state compatibility but is not projected and has no current scheduling or UI effect. The scheduler accepts `quietHours` as process-startup periods in local time:

`storageQuotaMiB` is one cap over the complete project-associated durable partition: repository settings, all JSONL files, contribution intents/links, indexes, rollback snapshots, leases, quarantine files, and project bridge files. It is not multiplied by the number of files. Contribution publication also enforces a fixed 16,384-file project safety ceiling. Store and TUI mailbox publishers calculate current plus projected replacement bytes under the same cross-process mutation lock and reject symlinks. Decision, control, and operation requests share a 64-file ceiling and a mailbox sub-budget of `min(512 KiB, storageQuotaMiB / 8)`; each pending request reserves the maximum 4 KiB response, and growing mailbox writes preserve up to 64 KiB (or one eighth of a smaller quota) for later store writes. One fixed 64 MiB and 16,384-file cap combines `self-evolve/global/` with `self-evolve/bridge/global/`, including projected replacements and durable lifecycle reservations; project bridge sidecars are counted only by their project quota. Global corruption evidence has a separate fixed 512 KiB fail-closed cap because corrupt global settings cannot safely supply its own budget. Native export artifacts use a separate bounded temporary-export quota. A safety-mandatory settings audit envelope of at most 4 KiB is the only documented project-quota bypass; ordinary records and recursive failure audits remain capped.

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
| Global contributions and their local intents/links | 30 days |

`retentionDays` sets the observation/evidence window and the immutable contribution `expiresAt` assigned at allocation. Proposal, decision, audit, rollback, intervention, circuit, and snapshot retention is three times that value. Existing contributions retain their explicit `expiresAt`; later configuration changes do not rewrite them. Decision/control/operation bridge TTL and the shorter operational TUI-report TTL are fixed. Contribution and synthesis-attempt recovery run before the startup sweep and autonomous scheduling; synthesis recovery completes durable recommendation or no-change crash markers without provider replay and fails invalid partial artifacts consistently. Sweeps then run daily on one unrefed timer, with expired bridge files also eligible for removal during idle polling.

The latest `critic-pending`, `pending`, `approved`, or `applied` proposal and its linked decision/audit records are retained past the nominal window until terminal. Global candidates, support sets, synthesis attempts, recommendations/content, decisions, apply intents, snapshots, outcomes, and audits share the operational window; active Apply/Undo chains and required snapshots remain protected. Rejected, failed-closed, superseded, and rolled-back content compacts immediately in recoverable transactions. Boot and ordinary reads finish interrupted compaction and global lifecycle invalidation before inbox/export access. Sweeps remove expired immutable contributions together with local intents/links, reclaim expired global lifecycle records and leases, and retain read-only cleanup for persisted legacy aggregate/index input.

Project-evidence and project purge remove only linked global contributions and recompute affected support, revoking stale pending recommendation authority without touching another project's evidence. Global recommendation purge can remove one recommendation chain by ID or all global candidate/support/recommendation lifecycle domains while preserving project evidence and protected applied rollback chains. Every scoped purge invalidates native export artifacts. Purge-all removes the complete `self-evolve/` subtree and is terminal for the loaded store/integration. Native purge-all publishes an authenticated `accepted-terminal` acknowledgement before bounded deletion; restart OpenCode to reinitialize.

Native sensitive exports require the exact confirmation `EXPORT SENSITIVE SELF-EVOLVE DATA`. They stream under `<state-root>/self-evolve/exports/<projectFingerprint>/` using private directories, exclusive `0600` files, one active job per project, a separate temporary quota, SHA-256/size/expiry metadata, and expiry/startup cleanup. `all` includes only the acting project's private partition plus identity-free global state; `global-recommendations` excludes project evidence, global settings, contributions, and aggregates. Active skill content and rollback snapshots are sensitive. Exports never open automatically and are removed by every purge.

## Rollout Gates

The integration accepts a `rolloutGates` startup object. These are deployment controls, not user-visible modes:

| Gate | Default | Meaning |
|---|---:|---|
| `offlineCorpus` | `false` | Records whether the offline corpus gate has been completed. |
| `passiveShadowObservation` | `false` | Stops passive work after correlation; no synthesis or apply. |
| `automaticSynthesisApplicationDisabled` | `false` | Forces synthesis/application paths to advisory behavior. |
| `autoReviewRollout` | `true` | Enables automatic proposal review flow in auto mode. |
| `yoloEnablementThreshold.minSynthesesObserved` | `10` | Retired-mode rollout metric retained under its historical key for migration diagnostics; grants no write authority. |
| `yoloEnablementThreshold.minSuccessRate` | `0.8` | Retired-mode success metric retained under its historical key for migration diagnostics; grants no write authority. |

Compatibility rollout history comes only from retained `synthesis-outcome` audit records in the current project partition. Before every production provider call, a strict content-free `synthesis-attempt` admission binds one stable outcome ID to the project, cluster, target hash, proposal ID, and admission time; failed admission means no call. Every admission converges to exactly one terminal outcome. `accepted` requires deterministic validation, critic pass, and complete hash-verified typed proposal content; valid `no-change` outcomes are also successes. Missing, corrupt, mixed, or partial content produces a failed outcome and never counts as accepted. Boot recovers admissions without outcomes before scheduling and never repeats the provider call. Unknown, malformed, cross-project, or duplicate records do not increase the metric. Meeting either legacy threshold never creates Apply authority; every write still requires an explicit decision.

These gates cannot override privacy consent, approved-root policy, deterministic validation, critic approval, budgets, exclusions, circuit breakers, kill switches, or explicit-decision requirements. Outcome audits use the ordinary proposal/audit retention window, three times `retentionDays`. Active proposal-chain protection is independent and remains unchanged.
