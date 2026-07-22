# OpenCode Self-Evolve Plugin

`@mcrescenzo/opencode-self-evolve` turns repeated friction in OpenCode sessions into evidence-backed skill improvements. Version 0.2 is a dual-target package: a headless-safe server plugin observes and validates opportunities, while an optional native TUI target can present review and consent dialogs in a capable TUI host. The same evidence thresholds apply in every mode, and finding no worthwhile change is a normal result.

## Quick Start

Register the package in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@mcrescenzo/opencode-self-evolve"]
}
```

OpenCode uses Bun to install the package at startup. The standard `plugin` entry loads the server (`.`) target. The separate `./tui` export is available to TUI hosts that support loading `TuiPluginModule`; server-only/headless hosts do not install OpenTUI peers. A source checkout can instead register `./self-evolve.js`.

The plain package entry boots durable v0.2 in fail-closed `manual` mode. No wrapper or startup mode is required. The v0.1 session-local analyzer remains available only through the explicit `durableAutonomy: false` compatibility option documented in [docs/configuration.md](docs/configuration.md).

Restart OpenCode after changing registration. Confirm the plugin loaded in a new session:

```text
/self-evolve status
```

Restart OpenCode after changing the durable mode so the plugin can shape its passive hooks from the persisted effective preference. Already-autonomous processes re-read durable mode and authority settings before each cycle. Applied skill changes require a new session or restart to load.

## Modes

`manual` is the fail-closed default. All three modes use the same `observe -> persist -> correlate -> synthesize -> validate -> notify | apply` pipeline and evidence gates.

| Behavior | `manual` | `auto` | `yolo` |
|---|---|---|---|
| Passive provider calls | Never | At stable idle boundaries | At stable idle boundaries |
| Durable observations | Only on `/self-evolve` or `scan` | Automatic at idle | Automatic at idle |
| Correlate, synthesize, validate | On invocation | Automatic | Automatic |
| Eligible proposal | Command result and toast | Native TUI review at safe idle | Native TUI audit/review at safe idle |
| Apply | Never; advisory only | Explicit approval for each change | Automatic only in canonical allowlisted skill roots after release gates pass |
| Headless | Commands and durable inbox | Apply only from an exact one-use hash/version-bound approval command | Apply only in an explicit allowlist after all gates pass |

Select a mode with `/self-evolve manual`, `/self-evolve auto`, or the deliberately explicit yolo command:

```text
/self-evolve yolo confirm --allowlist /absolute/path/to/skills
```

In the native TUI, open **Self-evolve settings** from the command palette or run `/self-evolve-settings`. This server-mediated flow manages mode, the canonical allowlist, all four consent keys, and repository exclusion. Yolo displays the exact allowlist twice before it submits a request; changing the allowlist has its own elevated confirmation. Excerpt and cross-repository controls warn that redaction reduces exposure but is not a secrecy guarantee.

Unknown scopes and non-allowlisted targets always downgrade to pending review. Yolo is high authority: it can change skill files without per-change confirmation. Use narrow allowlisted roots, inspect audit results, and stop autonomous work immediately with `SELF_EVOLVE_KILL=1` or `/self-evolve kill-switch on`.

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

- `/self-evolve` opens status and the durable inbox; `/self-evolve scan` runs the shared pipeline explicitly.
- `/self-evolve status`, `health`, and `budget` inspect state without a provider call.
- `/self-evolve pause` and `resume` control autonomous work.
- `/self-evolve inbox` and `review [id]` inspect pending proposals.
- `/self-evolve approve <proposal-id> --target-hash <sha256> --proposed-content-hash <sha256> --decision-version <integer> --nonce <one-use-nonce>` is the canonical auto headless approval command. `reject <id>`, `snooze <id> [duration]`, and `undo <id>` manage other review decisions. A bare proposal ID is never apply authority.

Approval is persisted as one recoverable proposal-plus-decision transaction. A restart completes an interrupted transaction before exposing authority. If application cannot be verified, the inbox shows a critical `failed-closed` record and offers no Apply action.

Apply and synthesis work hold process-aware durable leases from admission through their terminal audit/state transition. A restart defers while the recorded PID is still live, even if the wall-clock expiry has passed; dead owners are reclaimed under the store mutation lock. PID-less leases from earlier v0.2 builds retain expiry-based compatibility.

Existing skills remain bound to an exact lowercase SHA-256 current hash. New skills use the exact `must-not-exist` sentinel, are completely written and validated in a same-directory temporary file, and are published create-exclusively with an atomic hard link. Readers see either no target or complete content. Filesystems without atomic hard-link support fail closed; the plugin does not fall back to an overwrite-capable rename.
- `/self-evolve manual`, `auto`, `yolo`, and `repo <manual|auto|yolo|inherit>` manage modes.
- `/self-evolve exclude` and `include` control the current repository.
- `/self-evolve consent <passive|observations|excerpts|cross-repo> <on|off>` controls privacy consent.
- `/self-evolve export [observations|proposals|project|all]` exports state.
- `/self-evolve purge <observations|proposals|project|all>` and `/self-evolve purge --all` remove state by scope.
- `/self-evolve kill-switch <on|off>` controls the durable emergency stop.

## Configuration

Manual mode requires no allowlist or passive consent. Auto and yolo configuration covers mode and repository overrides, canonical skill-root allowlists, four separate consent keys, provider/token/concurrency/storage/notification budgets, retention, quiet periods, and rollout gates. Passive synthesis reserves two rolling-hour provider slots durably before starting the synthesizer/critic pair; if both slots are unavailable, neither hidden session starts. The two slots are conservatively charged if the later operation no-ops or fails, while explicit manual scans do not consume this passive budget. See [docs/configuration.md](docs/configuration.md) for defaults and exact controls.

## Storage And Privacy

Global settings and per-checkout state are separated:

```text
<state-root>/self-evolve/global/settings.json
<state-root>/self-evolve/global/aggregates.jsonl
<state-root>/self-evolve/<projectFingerprint>/
<state-root>/self-evolve/bridge/<projectFingerprint>/
```

The server and TUI use one shared identity resolver. An explicit `projectFingerprint` must match the identity derived from the supplied inputs; otherwise both targets fail closed. Without an explicit fingerprint, both use the same plugin `remoteUrl` when configured and the OpenCode worktree path (`ctx.worktree` on the server and `api.state.path.worktree` in the TUI), with the corresponding directory as a deterministic fallback. The fingerprint includes both the canonical remote (or canonical repository root) and canonical absolute worktree path, so clones and worktrees are isolated and relocation creates a new partition. OpenCode 1.18.3 exposes worktree/path state to the TUI but no supported remote URL, so plugin options are the supported remote input for both targets. Global settings are re-read with repository settings before each cycle and apply authorization. Settings commands use locked field updaters, so concurrent mode, consent, pause, allowlist, kill-switch, repository-mode, and exclusion changes preserve unrelated fields.

After the plugin factory returns, the server makes one bounded official health probe before opening a store or creating an integration. It prefers `client.global.health()` and, when that generated SDK method is absent, derives the exact GET `<PluginInput.serverUrl origin>/global/health` endpoint from the official host input. The fallback accepts only credential-free HTTP(S) root URLs without query or fragment, rejects redirects, and never reads a user-configured URL. Only `healthy: true` with a stable version in the declared `^1.18.3` host range (`>=1.18.3 <2.0.0`) may proceed to root validation and durable boot. Missing, timed-out, unhealthy, malformed, prerelease, older, or 2.x health fails autonomous authority closed and reports the observed version (or `unknown`) and compatibility reason. `hostSupported: false` may narrow this result; no option can supply or widen production host authority.

State-root precedence is shared by both targets: a validated explicit `stateRoot`, then a synchronous official host path (`ctx.path.state` or `api.state.path.state`), then `client.path.get()`, and only then standard XDG/HOME reconstruction when no official API exists. A synchronous candidate may be read before validation only to select the persisted manual/auto/yolo hook shape. The handler has no integration or authority while commands report `startup-validation-pending`. After official health succeeds, the same deferred startup task validates/resolves every explicit, host, or provisional root, opens the store, and boots the integration. Timeout, unavailability, or mismatch suspends durable operation; roots are never merged or migrated automatically.

Observations and observation-like evidence are retained for 30 days by default. Proposal, decision, audit, rollback/intervention/circuit records, and rollback snapshots use a 90-day default; filesystem bridge requests/responses use a fixed 24 hours. Aggregate claims receive a 30-day default `expiresAt` when created and always expire by that stored value. Active critic-pending/pending/approved/applied chains, typed proposal-content chunks, and required snapshots survive the nominal TTL. Terminal or purged proposal content is compacted immediately; boot/read recovery completes interrupted compaction before inbox or export access. Synthesis-attempt recovery runs before startup retention and autonomous scheduling.

Complete transcripts and raw message bodies are never stored. Deterministic receipts and typed observations are stored without raw text. Short sanitized excerpts require separate explicit consent. Cross-project global-skill aggregation is separately disabled by default and requires both excerpt and cross-repository consent; its strict normalized claims contain no paths, project names, customer details, commands, or text. Redaction is defensive and is not a secrecy guarantee: model-backed synthesis still sends bounded inputs to the configured provider in manual scans or consented autonomous modes.

`storageQuotaMiB` is one total cap for the project partition, not a per-record-file allowance. The store counts repository settings, every JSONL record file, indexes, snapshots, leases, quarantine artifacts, and project bridge files, rejects symlinks, and checks projected replacement bytes while holding the cross-process mutation lock. TUI decision/control requests use that same lock, share a 64-file ceiling and a conservative one-eighth-quota mailbox budget capped at 512 KiB, reserve their bounded responses, and leave store-write capacity available. Only a bounded mandatory audit event of at most 4 KiB may cross an exhausted quota so a safety-relevant settings outcome is not silently lost; ordinary failure logging cannot recursively bypass the cap.

`/self-evolve export all` returns a bounded JSON archive containing global settings and aggregates, every project partition and its records/indexes, explicitly classified decision/control request and response metadata, classified control-state metadata, active proposal-content chunks, and rollback snapshots. Snapshot bodies are Base64 encoded and labeled `sensitive-skill-snapshot`; the archive itself is sensitive and may reconstruct current or prior skill content. It rejects symlinks, hard links, replaced files, unknown bridge fields, and filename/project binding mismatches. It contains no terminal/purged proposal body and excludes locks, temporary files, raw quarantine corruption, unrelated OpenCode state, complete transcripts, and raw messages. `/self-evolve purge --all` is terminal for the loaded plugin instance: it stops scheduling, retention, and mailbox work, removes the subtree, rejects later self-evolve operations, and requires an OpenCode restart before reinitialization.

The hidden synthesizer and critic use deny-all-tools sessions. The plugin never spawns implementation, shell, or Git agents; never commits, pushes, publishes, or mutates external trackers; never injects proposal turns into the working session; and never writes outside the canonical skill allowlist. The transactional applier is the only skill writer.

Ordinary factory initialization performs no host HTTP/SDK request. After the factory returns, one bounded asynchronous phase resolves official health, validates the selected state root, boots durable integration, then lists sessions with timeout, retry, and backoff. Disposal aborts and settles pending startup before closing any created integration.

Headless hosts load the server target without `@opentui/*`. Pending reviews remain in the durable inbox and deterministic inspection/control commands remain available. Auto can apply headlessly only from the complete one-use approval tuple; yolo can do so only inside its explicit allowlist after release gates pass. The separate TUI target coordinates through distinct `0600` decision and control mailbox namespaces. Control requests bind the project, actor, time, full settings version, global `updatedAt`, action-specific payload, and a server-issued one-use nonce; only the server uses locked settings updaters. The TUI never relies on an undocumented client extension, mutates durable settings or decisions directly, or injects session prompts.

## Supported Environment

- Node.js `>=20.11.0`.
- OpenCode and `@opencode-ai/plugin` `^1.18.3`; the release contract is verified against 1.18.3.
- Plain Node ESM with no install-time build.
- `@opencode-ai/plugin` is both a runtime dependency for portable installation and a peer contract for host compatibility.

## Troubleshooting

- If `/self-evolve status` becomes a normal model turn, verify registration and restart OpenCode.
- If autonomous work does not run, inspect `/self-evolve health`, consent, mode, exclusion, budget, circuit-breaker, and kill-switch state.
- If no proposal appears, evidence or deterministic validation gates were not met; this is expected.
- If state is corrupt or from a newer schema, autonomous work fails closed to manual and purge remains available.
- If health reports `state-root-validation-mismatch`, `official-state-path-timeout`, or `official-state-path-unavailable`, configure the official canonical root explicitly as `stateRoot` in a wrapper and restart. Do not copy or merge roots automatically.
- After `/self-evolve purge --all`, restart OpenCode before issuing another self-evolve command.
- Applied skill changes do not alter already-loaded sessions; restart OpenCode or open a new session.

## Development

```sh
npm test
npm run check
npm run pack:check
```

`npm run smoke:live` is a no-token isolated OpenCode process check. It compares `opencode --version` with the fresh server's GET `/global/health` response and the version reported by the plugin, then live-loads both targets and the durable server integration. Native dialog rendering remains covered by mocked TUI API tests, not claimed as live-host evidence. See [docs/internals.md](docs/internals.md), [SECURITY.md](SECURITY.md), and [CONTRIBUTING.md](CONTRIBUTING.md).
