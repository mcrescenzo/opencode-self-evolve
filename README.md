# OpenCode Self-Evolve Plugin

`@mcrescenzo/opencode-self-evolve` turns repeated friction in OpenCode sessions into evidence-backed skill improvements. Version 0.2 is a dual-target package: a headless-safe server plugin observes and validates opportunities, while an optional native TUI target provides a persistent clickable sidebar status/attention indicator and a control center that is also available from the command palette. The same evidence thresholds apply in every mode, and finding no worthwhile change is a normal result.

## Quick Start

Install and register both plugin targets with OpenCode's native installer:

```sh
opencode plugin @mcrescenzo/opencode-self-evolve --global
```

`--global` updates the global OpenCode configuration. Omit it to install at
project scope under `.opencode/`. The installer reads the package exports and
writes the server registration to `opencode.json` and the native UI
registration to `tui.json`. The TUI command palette exposes the same operation
as **Install plugin** (`plugins.install`). Restart OpenCode after installation.

For a manual installation, both files are required for the native UI. Register
the package in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@mcrescenzo/opencode-self-evolve"]
}
```

The standard `plugin` entry loads the server (`.`) target. Register the same
bare package in `tui.json`; OpenCode resolves its `./tui` export for that config
kind:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["@mcrescenzo/opencode-self-evolve"]
}
```

The package TUI entry has the stable ID `mcrescenzo.self-evolve`. The published
`./tui` export is the deterministic `self-evolve-tui.generated.js` artifact;
the package builds it before packing, never in a consumer install hook. For a
source checkout, register `./plugins/self-evolve/self-evolve.js` in
`opencode.json` and the package directory `./plugins/self-evolve` in `tui.json`.
Do not register the authoring TSX file directly. Server-only/headless hosts need
only the server target and may omit every optional TUI peer. This plugin never
edits external OpenCode configuration itself.

The plain package entry boots durable v0.2 in fail-closed `manual` mode. No wrapper or startup mode is required. The v0.1 session-local analyzer remains available only through the explicit `durableAutonomy: false` compatibility option documented in [docs/configuration.md](docs/configuration.md).

Restart OpenCode after changing registration. In an interactive TUI, activate the persistent **Self-evolve** sidebar indicator by click or focused Enter to open the control center; **Self-evolve control center** also remains in the command palette. Healthy state renders a muted mode/status summary, while setup, review, audit, failure, and operation states replace it with the relevant attention summary. Server-only hosts can confirm loading with `/self-evolve status`.

Restart OpenCode after changing the durable mode so the plugin can shape its passive hooks from the persisted effective preference. Already-autonomous processes re-read durable mode and authority settings before each cycle. Applied skill changes require a new session or restart to load.

## Modes

`manual` is the fail-closed default. Project analysis is exactly `manual` or `auto`, and both use the same `observe -> persist -> correlate -> contribute -> synthesize -> validate -> recommend` pipeline and evidence gates. Neither mode carries write authority.

| Behavior | `manual` | `auto` |
|---|---|---|
| Passive provider calls | Never | At stable idle boundaries |
| Durable observations | Only on `/self-evolve` or `scan` | Automatic at idle |
| Correlate, contribute, synthesize, validate | On invocation | Automatic |
| Eligible evidence | Durable headless result | Recommendation deep-link from the sidebar |
| Apply | Never; advisory only | Never automatically; each global write needs a fresh explicit decision |
| Headless | Commands and durable inbox | Apply only from an exact one-use hash/version-bound approval command |

Select project analysis with `/self-evolve manual` or `/self-evolve auto`. Changes take effect at the next eligible lifecycle event without a restart. The v0.2 `yolo` command is retired: it is refused by the command surface and by the TUI bridge, and a stored `yolo` preference read from a v0.2 partition narrows to analysis-only `auto` with no unattended write authority.

In the native TUI, open **Self-evolve control center** from the command palette or the persistent sidebar entry. It has no slash metadata and provides exactly four sections: Home, Recommendations, Activity, and Settings. Settings contains Manual/Auto project-analysis cards, installation/project/configured scope, the separate operational state, consent dependencies, one approved skill folder per row, actual-versus-configured limits, and scoped export/delete maintenance. Every action is advertised by a fresh server projection and revalidated against project, state root, generation, hashes or settings version, capability, expiry, and a one-use nonce. Allowlist replacement, sensitive export, and delete flows require their displayed exact phrase. Excerpt and cross-project controls warn that redaction reduces exposure but is not a secrecy guarantee.

Background refresh only updates persistent state. The normal TUI path emits no toast, attention notification, or automatically opened dialog. Click the sidebar indicator, or focus it and press Enter or Space: neutral and startup states open Home, setup opens Settings, review opens the selected Recommendation, and audit/failure states open Activity.

Unknown scopes and non-allowlisted targets always downgrade to pending review. Every Apply and Undo requires a fresh explicit operator decision; project analysis mode never grants write authority. Use narrow approved roots, inspect audit results, and stop autonomous work immediately with `SELF_EVOLVE_KILL=1` or `/self-evolve kill-switch on`.

## Example

```text
$ /self-evolve scan
Self-evolve recorded bounded observations and found an eligible skill improvement.
Proposal: clarify the payments log-triage procedure
Evidence: the same read-only diagnostic sequence occurred in independent incidents.
Target: payments-debug/SKILL.md
State: pending review
```

The real proposal is based on structured receipts from your sessions. It may return no proposal when the evidence is insufficient.

## Commands

v0.3 keeps the complete `/self-evolve` surface as a compatibility and deterministic headless fallback. Normal interactive use is sidebar-first and does not require slash input. Manual **Scan now** remains headless because OpenCode 1.18.3 does not expose a safe native binding from the palette route to one exact source session.

- `/self-evolve` opens status and the durable inbox; `/self-evolve scan` runs the shared pipeline explicitly.
- `/self-evolve status`, `health`, and `budget` inspect state without a self-evolve analyzer or synthesis call. OpenCode 1.18.3 still completes its configured slash-command model turn after command hooks, so these are not zero-model-turn host commands.
- `/self-evolve pause` and `resume` control autonomous work.
- `/self-evolve inbox` and `review [id]` inspect pending proposals.
- `/self-evolve approve <proposal-id> --target-hash <sha256|must-not-exist> --proposed-content-hash <sha256> --decision-version <integer> --nonce <one-use-nonce>` is the canonical auto headless approval command. New-skill proposals use the exact `must-not-exist` target sentinel issued by inbox/review. `reject <id>`, `snooze <id> [duration]`, and `undo <id>` manage other review decisions. A bare proposal ID is never apply authority.

Approval is persisted as one recoverable proposal-plus-decision transaction. A restart completes an interrupted transaction before exposing authority. If application cannot be verified, the inbox shows a critical `failed-closed` record and offers no Apply action.

Apply and synthesis work hold process-aware durable leases from admission through their terminal audit/state transition. A restart defers while the recorded PID is still live, even if the wall-clock expiry has passed; dead owners are reclaimed under the store mutation lock. PID-less leases from earlier v0.2 builds retain expiry-based compatibility.

Existing skills remain bound to an exact lowercase SHA-256 current hash. New skills use the exact `must-not-exist` sentinel, are completely written and validated in a same-directory temporary file, and are published create-exclusively with an atomic hard link. Readers see either no target or complete content. Filesystems without atomic hard-link support fail closed; the plugin does not fall back to an overwrite-capable rename.
- `/self-evolve manual`, `auto`, and `repo <manual|auto|inherit>` manage project analysis. The retired `yolo` command is refused; a stored v0.2 `yolo` preference reads back as Auto.
- `/self-evolve exclude` and `include` control the current repository.
- `/self-evolve consent <passive|observations|excerpts|cross-repo> <on|off>` controls privacy consent.
- `/self-evolve allowlist list` shows approved skill folders. Add or remove one without changing mode or consent using `/self-evolve allowlist <add|remove> <canonical-absolute-path> --confirm UPDATE ALLOWLIST`; the server freshly canonicalizes the complete result.
- `/self-evolve export [observations|proposals|global-recommendations|project|all]` exports state. Global recommendation export excludes project evidence, global settings, contributions, and aggregates.
- `/self-evolve purge <observations|project-evidence|proposals|global-recommendations|project>` and `/self-evolve purge global-recommendation <recommendation-id>` remove state by scope. Complete deletion requires `/self-evolve purge --all --confirm PURGE ALL SELF-EVOLVE 0.3.0`.
- `/self-evolve kill-switch <on|off>` controls the durable emergency stop.

## Configuration

Manual mode requires no approved root or passive consent. Auto configuration covers installation and repository analysis settings, approved global skill roots, four separate consent keys, provider/token/concurrency/storage budgets, retention, and quiet periods. Passive synthesis and critic calls each reserve one rolling-hour provider slot immediately before their own dispatch. Deterministic no-call paths charge zero; with one slot remaining, synthesis can run but critic dispatch fails closed. Explicit manual scans do not consume this passive budget. See [docs/configuration.md](docs/configuration.md) for defaults and exact controls. The legacy `notificationsPerHour` setting remains readable for state compatibility but has no current scheduling or UI effect.

## Storage And Privacy

Global settings and per-checkout state are separated:

```text
<state-root>/self-evolve/global/settings.json
<state-root>/self-evolve/global/contributions/<uuid-prefix>/<contributionId>.json
<state-root>/self-evolve/global/leases/<key-prefix>/<leaseKeyHash>.json
<state-root>/self-evolve/<projectFingerprint>/
<state-root>/self-evolve/bridge/<projectFingerprint>/
<state-root>/self-evolve/exports/<projectFingerprint>/
```

The server and TUI use one shared identity resolver. An explicit `projectFingerprint` must match the identity derived from the supplied inputs; otherwise both targets fail closed. Without an explicit fingerprint, both use the same plugin `remoteUrl` when configured and the OpenCode worktree path (`ctx.worktree` on the server and `api.state.path.worktree` in the TUI), with the corresponding directory as a deterministic fallback. The fingerprint includes both the canonical remote (or canonical repository root) and canonical absolute worktree path, so clones and worktrees are isolated and relocation creates a new partition. OpenCode 1.18.3 exposes worktree/path state to the TUI but no supported remote URL, so plugin options are the supported remote input for both targets. Global settings are re-read with repository settings before each cycle and apply authorization. Settings commands use locked field updaters, so concurrent mode, consent, pause, allowlist, kill-switch, repository-mode, and exclusion changes preserve unrelated fields.

After the plugin factory returns, the server runs bounded host-version resolution before opening a store or creating an integration. It prefers `client.global.health()` and, only when that generated method is absent or has a recognized transport/capability failure, derives exact GET `<PluginInput.serverUrl origin>/global/health` from official `PluginInput.serverUrl`. Credential/authentication and other authoritative SDK failures do not fall back. Transient transport failures and cancellable exact-origin fallback timeouts retry with bounded exponential backoff for at most five seconds. Some embedded TUI hosts expose neither global-health path; when the separately registered package TUI target is live, it relays official `api.app.version` through a strict project/root-bound `0600` runtime report. The server accepts that report only after both global paths are unavailable, while its same-account publisher PID is live, before its 60-second expiry, and still requires official state-root validation before durable boot. The state root, report file, and bridge ancestors must be owned by the server's effective UID; the state root and bridge ancestors may not be group/other writable; and the file must remain exactly `0600`. Hosts that cannot establish effective-UID ownership fail this relay closed. The TUI refreshes it every 15 seconds and conditionally removes its own generation on disposal. The report is local same-account IPC, not a cryptographic claim against other code running as the same OS user.

After exhausted transient-unavailable startup, the first later `/self-evolve` command may perform one fresh bounded version/root/boot attempt; later commands do not repeatedly probe. No requested mode, provider, or skill-file action gains authority unless the complete recovery succeeds. A generated SDK call that itself times out fails closed without launching an overlapping call or fallback; invalid official inputs and authoritative errors, unhealthy/malformed results, and unsupported versions fail immediately. The HTTP fallback accepts only credential-free HTTP(S) root URLs without query or fragment, rejects redirects, and never reads a user-configured URL. Only a healthy or current-TUI-reported stable version in the declared `~1.18.3` host range (`>=1.18.3 <1.19.0`, including build metadata) may proceed. Exhausted, missing, timed-out, authoritative-error, unhealthy, malformed, prerelease, older, 1.19+, and 2.x results remain manual and report the observed version (or `unknown`) with a bounded sanitized diagnostic. `hostSupported: false` may narrow this result; no option can supply or widen production host authority.

State-root precedence is shared by both targets: a validated explicit `stateRoot`, then a synchronous official host path (`ctx.path.state` or `api.state.path.state`), then `client.path.get()`, and only then standard XDG/HOME reconstruction when no official API exists. A synchronous candidate may be read before validation only to select the persisted manual/auto hook shape. The handler has no integration or authority while commands report `startup-validation-pending`. After official health succeeds, the same deferred startup task validates/resolves every explicit, host, or provisional root, opens the store, and boots the integration. Timeout, unavailability, or mismatch suspends durable operation; roots are never merged or migrated automatically.

Observations and observation-like evidence are retained for 30 days by default. Proposal, decision, audit, rollback/intervention/circuit records, rollback snapshots, and global candidate/support/recommendation/decision lifecycle records use a 90-day default; filesystem decision/control/operation requests and responses use a fixed 24 hours. The operational TUI host-version report lives for at most 60 seconds and is revoked on clean disposal. Immutable global contributions and their local intent/link pair receive a 30-day default `expiresAt` and expire by that stored value. Active critic-pending/pending/approved/applied chains, global Apply/Undo chains, typed content chunks, and required snapshots survive the nominal TTL. Rejected or purged content is compacted immediately; contribution, synthesis-attempt, and global lifecycle recovery run before startup retention and autonomous scheduling.

Complete transcripts and raw message bodies are never stored. Deterministic receipts and typed observations are stored without raw text. Short sanitized excerpts require separate explicit consent. Cross-project learning is disabled by default and requires both excerpt and cross-repository consent. One local intent allocates a random contribution UUID; the global record contains only strict identity-free metadata, counts, coarse dates, and expiry, never project/scope identity, paths, prose, excerpts, commands, sessions, observations, capsules, clusters, evidence domains, or local incidents. Redaction is defensive and is not a secrecy guarantee: model-backed synthesis still sends bounded inputs to the configured provider in manual scans or consented autonomous modes.

`storageQuotaMiB` is one total cap for the project partition, not a per-record-file allowance. The store counts repository settings, every JSONL record file, contribution intents/links, indexes, snapshots, leases, quarantine artifacts, and project bridge files, rejects symlinks, and checks projected replacement bytes while holding the cross-process mutation lock. The fixed 64 MiB/16,384-file global caps combine the complete `self-evolve/global/` lifecycle tree with `self-evolve/bridge/global/`; store reservations and bridge replacement plans are checked against that one footprint while project sidecars remain only in their project quota. TUI decision/control/operation requests use the same lock, share a 64-file ceiling and a conservative one-eighth-quota mailbox budget capped at 512 KiB, reserve bounded responses, and leave store-write capacity available. Global corruption evidence has a separate fixed 512 KiB fail-closed cap. Only a bounded mandatory audit event of at most 4 KiB may cross an exhausted project quota.

Settings maintenance exports or deletes Observations, global Recommendations, This project, or Everything only after the exact displayed confirmation. Export streams a private `0600` artifact under the state root, reports its path, byte size, SHA-256, and short expiry, never opens it automatically, and warns that active skill content and rollback snapshots may be sensitive. These temporary artifacts have a separate bounded quota, are excluded from ordinary archive recursion, and are removed by expiry or any purge.

The retained `/self-evolve export all` fallback returns the same bounded sensitive archive data directly. `/self-evolve purge --all --confirm PURGE ALL SELF-EVOLVE 0.3.0` and native **Purge all** are terminal for the loaded plugin instance. Purge-all first returns an authenticated `accepted-terminal` acknowledgement, then stops scheduling, retention, projections, mailbox work, TUI watchers, and host-health publication before deleting the subtree. Disappearance alone is not reported as proof of completion; restart OpenCode and verify health.

The hidden synthesizer and critic use deny-all-tools sessions. The plugin never spawns implementation, shell, or Git agents; never commits, pushes, publishes, or mutates external trackers; never injects proposal turns into the working session; and never writes outside the canonical skill allowlist. The transactional applier is the only skill writer.

Ordinary factory initialization performs no host HTTP/SDK request. After the factory returns, one bounded asynchronous phase resolves the host version, validates the selected state root, boots durable integration, then lists sessions with timeout, retry, and backoff. Duplicate matching factories share that phase: disposing one factory does not abort work needed by another, while final coordinated disposal aborts and settles pending startup before closing any created integration.

Headless hosts load the server target without `@opentui/*`. Pending reviews remain in the durable inbox and deterministic inspection/control commands remain available. Auto can apply headlessly only from the complete one-use approval tuple; no mode applies without one. The separate TUI target coordinates through distinct `0600` decision, control, and operation mailbox namespaces plus the replaceable short-lived runtime report above. Requests bind the project, actor, time, root identity, exact projection/grant generation and domain versions, action-specific payload, and a server-issued one-use nonce; only the server revalidates authority and performs effects. The TUI never relies on an undocumented client extension, mutates durable settings or decisions directly, or injects session prompts. Runtime reports are operational files: cleanup and purge remove them, and exports omit them.

## Supported Environment

- Node.js `>=22.11.0`.
- OpenCode `>=1.18.3 <1.19.0` and `@opencode-ai/plugin ~1.18.3`; package gates keep exact 1.18.3 and 1.18.4 lanes and resolve the latest common stable aligned 1.18.x pair when the compatibility matrix runs.
- Plain Node ESM for the server/shared target plus one deterministic prebuilt JavaScript TUI artifact; there is no preinstall, install, postinstall, or consumer build.
- The TUI-only optional peers are `@opencode-ai/plugin ~1.18.3`, `@opentui/core >=0.4.5 <0.6.0`, `@opentui/keymap >=0.4.5 <0.6.0`, `@opentui/solid >=0.4.5 <0.6.0`, and `solid-js 1.9.12`. The package root reaches none of them. The packed-artifact check imports only the server root from a fresh consumer with all optional peers omitted; the separate packed-TUI matrix loads and reactively renders `./tui` through Bun against both the 0.4.5 floor and 0.5.0 current peers without bypassing npm peer resolution.

## Native UX Migration And Rollback

The native UX changes are additive. Existing `/self-evolve` commands, the durable inbox, exact headless approval tuple, emergency controls, manual scan, recovery, export, and purge remain supported. The normal TUI uses the sidebar and four-section control center; no legacy state migration is required. The v1 offer and review index retain the Release A capability vocabulary. Current servers publish `dashboard-v2` and a `dashboard-v1` compatibility sidecar; current readers prefer v2 and fall back to v1, while older dashboard readers continue to consume v1. A TUI hides repository-mode editing without dashboard capability `control-repo-mode-v1`.

To disable the native surface, remove the package from `tui.json`, keep the server registration in `opencode.json`, and restart OpenCode. To disable all plugin behavior, remove both registrations and restart. To roll back, install the prior package version, retain the state-root backup, restore the prior registrations, and restart; do not copy or merge state roots. This repository change does not authorize a publish, tag, push, or GitHub Release.

## Troubleshooting

- If `/self-evolve status` becomes a normal model turn, verify registration and restart OpenCode.
- If autonomous work does not run, inspect `/self-evolve health`, consent, mode, exclusion, budget, circuit-breaker, and kill-switch state.
- In an embedded TUI without global-health routes, successful `/self-evolve health` reports `source tui-app-version`; `source global-health` identifies the normal server path.
- If no proposal appears, evidence or deterministic validation gates were not met; this is expected.
- If state is corrupt or from a newer schema, autonomous work fails closed to manual and purge remains available.
- If health reports `state-root-validation-mismatch`, `official-state-path-timeout`, or `official-state-path-unavailable`, configure the official canonical root explicitly as `stateRoot` in a wrapper and restart. Do not copy or merge roots automatically.
- After `/self-evolve purge --all --confirm PURGE ALL SELF-EVOLVE 0.3.0`, restart OpenCode before issuing another self-evolve command.
- Applied skill changes do not alter already-loaded sessions; restart OpenCode or open a new session.

## Development

```sh
npm test
npm run check
npm run pack:check
```

The heavier deterministic lanes are `npm run test:tui-matrix` for packed peer-version compatibility and `npm run bench:perf` for the bounded performance budgets. `npm run operator:evidence` drives the isolated operator fixture against the packed production TUI target; its generated receipt is operator evidence, not independent human acceptance, and the current v0.3 result is recorded in `docs/v03-operator-evidence.md`.

OpenCode Workflows owns the canonical two-TUI coexistence harness. Run it from
this checkout through the bounded wrapper:

```sh
npm run test:tui-coexistence -- --workflows ../opencode-workflows --attempts 10 --witness
```

Each attempt first starts the product plugins without a witness, server plugin,
MCP dependency, or provider request in both registration orders. The witness is
added only after readiness to assert both stable plugin IDs and palette
commands. Packed candidates are accepted with `--self-evolve` and
`--workflows`; when the Workflows candidate is packed, also pass `--runner
<workflows-checkout>` so the repository-owned harness remains the orchestrator.
Separate `--symlinked-config` and `--server-stack` runs cover those release
cases without changing the real OpenCode configuration.

`npm run smoke:live` is an isolated no-external-token OpenCode process check. It compares `opencode --version` with the fresh server's GET `/global/health` response and the version reported by the plugin, then live-loads both targets and the durable server integration. It also starts a separate child server with `self-evolve.js` registered directly, creates a real child session, executes `/self-evolve health` through the production session-command endpoint using a local loopback mock provider, verifies the hook-generated user part and durable boot against official health, stops every child/provider process, and removes its isolated state root. Deterministic target/store/integration coverage is distinct from exact-host interactive rendering evidence. See [docs/internals.md](docs/internals.md), [SECURITY.md](SECURITY.md), and [CONTRIBUTING.md](CONTRIBUTING.md).
