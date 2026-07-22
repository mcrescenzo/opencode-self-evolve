# OpenCode Self-Evolve Plugin

`@mcrescenzo/opencode-self-evolve` turns repeated friction in OpenCode sessions into evidence-backed skill improvements. Version 0.2 is a dual-target package: a headless-safe server plugin observes and validates opportunities, while an optional native TUI target presents review and consent dialogs. The same evidence thresholds apply in every mode, and finding no worthwhile change is a normal result.

## Quick Start

Register the package in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@mcrescenzo/opencode-self-evolve"]
}
```

OpenCode uses Bun to install the package at startup and resolves both the server (`.`) and TUI (`./tui`) targets where supported. Installing through the `opencode plugin` CLI is an alternative on hosts that expose that command. A source checkout can instead register `./self-evolve.js`.

Restart OpenCode after changing registration. Confirm the plugin loaded in a new session:

```text
/self-evolve status
```

OpenCode must be restarted for mode changes and applied skill changes to take full effect; new sessions pick up changes automatically.

## Modes

`manual` is the fail-closed default. All three modes use the same `observe -> persist -> correlate -> synthesize -> validate -> notify | apply` pipeline and evidence gates.

| Behavior | `manual` | `auto` | `yolo` |
|---|---|---|---|
| Passive provider calls | Never | At stable idle boundaries | At stable idle boundaries |
| Durable observations | Only on `/self-evolve` or `scan` | Automatic at idle | Automatic at idle |
| Correlate, synthesize, validate | On invocation | Automatic | Automatic |
| Eligible proposal | Command result and toast | Native TUI review at safe idle | Native TUI audit/review at safe idle |
| Apply | Never; advisory only | Explicit approval for each change | Automatic only in canonical allowlisted skill roots after release gates pass |
| Headless | Commands and durable inbox | Draft only; approval waits in inbox | Apply only in an explicit allowlist after all gates pass |

Select a mode with `/self-evolve manual`, `/self-evolve auto`, or the deliberately explicit yolo command:

```text
/self-evolve yolo confirm --allowlist /absolute/path/to/skills
```

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
- `/self-evolve approve <id>`, `reject <id>`, `snooze <id> [duration]`, and `undo <id>` manage review decisions.
- `/self-evolve manual`, `auto`, `yolo`, and `repo <manual|auto|yolo|inherit>` manage modes.
- `/self-evolve exclude` and `include` control the current repository.
- `/self-evolve consent <passive|observations|excerpts|cross-repo> <on|off>` controls privacy consent.
- `/self-evolve export [observations|proposals|project|all]` exports state.
- `/self-evolve purge <observations|proposals|project|all>` and `/self-evolve purge --all` remove state by scope.
- `/self-evolve kill-switch <on|off>` controls the durable emergency stop.

## Configuration

Manual mode requires no allowlist or passive consent. Auto and yolo configuration covers mode and repository overrides, canonical skill-root allowlists, four separate consent keys, provider/token/concurrency/storage/notification budgets, retention, quiet periods, and rollout gates. See [docs/configuration.md](docs/configuration.md) for defaults and exact controls.

## Storage And Privacy

Durable state lives under:

```text
<state-root>/self-evolve/<projectFingerprint>/
```

Observations are retained for 30 days by default. Proposal, decision, and audit records are retained for 90 days. Startup and daily retention sweeps enforce those windows; the export and purge commands provide user-controlled lifecycle management.

Complete transcripts and raw message bodies are never stored. Deterministic receipts and typed observations are stored without raw text. Short sanitized excerpts require separate explicit consent. Redaction is defensive and is not a secrecy guarantee: model-backed synthesis still sends bounded inputs to the configured provider in manual scans or consented autonomous modes.

The hidden synthesizer and critic use deny-all-tools sessions. The plugin never spawns implementation, shell, or Git agents; never commits, pushes, publishes, or mutates external trackers; never injects proposal turns into the working session; and never writes outside the canonical skill allowlist. The transactional applier is the only skill writer.

Headless hosts load the server target without `@opentui/*`. Pending reviews remain in the durable inbox and all deterministic `/self-evolve` inspection, export, purge, pause, and kill-switch commands remain available. Auto mode does not apply headlessly; yolo can do so only inside its explicit allowlist after release gates pass.

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
- Applied skill changes do not alter already-loaded sessions; restart OpenCode or open a new session.

## Development

```sh
npm test
npm run check
npm run pack:check
```

`npm run smoke:live` is an optional no-token local OpenCode load check. See [docs/internals.md](docs/internals.md), [SECURITY.md](SECURITY.md), and [CONTRIBUTING.md](CONTRIBUTING.md).
