# opencode Self-Evolve Plugin

`self-evolve` is a conservative first-party opencode plugin that runs only when the user manually invokes `/self-evolve` or `/self-evolve scan`. It looks at the recent session transcript for evidence-backed opportunities to improve local opencode tooling, skills, commands, workflows, plugins, or project conventions. It never edits files, calls internal tooling, writes to external issue trackers or memory systems, pushes, publishes, or mutates external systems.

## Installation

Install the package in the opencode config environment:

```sh
npm install @mcrescenzo/opencode-self-evolve
```

Then register it in `opencode.json`:

```json
{
  "plugin": ["@mcrescenzo/opencode-self-evolve"]
}
```

Restart opencode after changing plugin registration. Running sessions keep the plugin list and instructions they loaded at startup.

For local development from a source checkout, register the checkout entrypoint path instead of the package name:

```json
{
  "plugin": ["./self-evolve.js"]
}
```

Verify loading in a new opencode session:

```text
/self-evolve status
```

Expected output starts with `Self-evolve status: active`. If the command is treated as a normal model prompt, the plugin did not load or opencode was not restarted after registration changed.

## Supported Environment

- Node.js `>=20.11.0` is required and declared in `package.json`.
- opencode CLI `>1.17.7` is the supported host range for plugin loading and live smoke validation.
- `npm run smoke:live` uses `OPENCODE_BIN` when set, otherwise it uses `$HOME/.opencode/bin/opencode` or `opencode` on `PATH`.
- The package uses npm scripts and does not pin a `packageManager`; there is no install-time build step.
- `@opencode-ai/plugin` remains a runtime dependency for the opencode plugin API convention used by portable plugin installs. Runtime source imports are local modules or Node built-ins; the dependency also documents the supported plugin surface for consumers and future type-aware tooling.

## Hooks

The plugin registers exactly three opencode hooks:

- `config` — registers the hidden, deny-all-tools `self-evolve-analyzer` primary agent and captures the configured default model.
- `command.execute.before` — intercepts `/self-evolve` and its subcommands; this is the only entry point that can trigger an analyzer run.
- `dispose` — clears the in-memory session registry when opencode unloads the plugin.

It does not register `event` or `chat.message` hooks; analysis only ever runs from an explicit `/self-evolve` command.

## Configuration

opencode plugins can be registered as a tuple with options:

```json
{
  "plugin": [
    [
      "@mcrescenzo/opencode-self-evolve",
      {
        "maxAnalyzerRuns": 4,
        "maxProposals": 2,
        "minConfidence": 0.8
      }
    ]
  ]
}
```

Options:

- `minIntervalMs` default `600000`: cooldown recorded after a scan result.
- `maxAnalyzerRuns` default `8`: maximum analyzer runs per session.
- `maxProposals` default `3`: maximum accepted proposals per session.
- `maxAnalyzerFailures` default `3`: disables the session after repeated counted analyzer failures.
- `messageLimit` default `120`: recent messages considered for transcript construction.
- `transcriptMaxChars` default `30000`: maximum transcript characters sent to the analyzer.
- `messageMaxChars` default `2000`: maximum characters retained from each message.
- `minConfidence` default `0.72`: minimum proposal confidence accepted by validation.
- `analyzerTimeoutMs` default `120000`: timeout for the analyzer prompt call.
- `sdkTimeoutMs` default `15000`: timeout for SDK reads and analyzer-session creation.
- `cleanupTimeoutMs` default `5000`: timeout for best-effort analyzer-session cleanup.
- `deliveryTimeoutMs` default `5000`: timeout for optional TUI toast delivery.
- `maxRegistrySessions` default `200`: lazy cap for inactive per-session states kept in memory.

## Behavior

- Maintains plugin-owned in-memory state per active `sessionID` only; opencode may still have transient runtime records/logs for temporary analyzer sessions.
- Registers no passive event or chat hooks for analysis; the analyzer is called only from the `/self-evolve` command hook.
- Uses deterministic gates before hidden analyzer calls: analyzer run cap, proposal cap, failure cap, pause/disable state, and one pending proposal at a time.
- Reads recent active-session messages with opencode SDK compatibility fallbacks, bounds and redacts the transcript, then sends the analyzer prompt, JSON schema, redacted transcript excerpt, and analyzer JSON response through a temporary isolated analyzer session with a timeout.
- Never falls back to active-session analyzer prompting; if temporary session creation or prompting fails, the scan fails closed with human-readable command output.
- Cleans up the temporary analyzer session best-effort through the verified abort/interrupt lifecycle path; cleanup failure does not mask a valid analyzer result.
- Validates strict JSON proposals plugin-side before returning a full human-facing advisory in deterministic command output and showing an optional TUI toast. It does not post advisory text back into the active session with `promptAsync` or rely on `noReply` behavior.

## Privacy And Token Use

- Deterministic control commands such as `/self-evolve status`, `/self-evolve pause`, `/self-evolve resume`, `/self-evolve disable`, and `/self-evolve dismiss <proposal-id>` do not invoke a model.
- `/self-evolve` and `/self-evolve scan` are manual analyzer runs. They read recent active-session messages through the opencode SDK, bound the transcript by message and character limits, redact common secret-like values, and send the analyzer prompt plus the bounded redacted transcript excerpt to the configured model/provider through a temporary analyzer session.
- Manual scans may consume provider tokens according to the configured model/provider.
- The analyzer is hidden, temperature `0`, one step, and tool-denied. The plugin validates the analyzer result locally and returns deterministic command output.
- The plugin does not write files, persist proposals, publish packages, push git data, write to external issue trackers or memory systems, or mutate external services.

## Limitations

- Redaction is defensive but not a substitute for keeping secrets out of chat transcripts. Do not run a manual scan over transcript content that should never be sent to the configured provider.
- Proposals are advisory only. A human or coding agent must review and apply any suggested change separately.
- Session state is in memory. Restarting opencode clears pause state, counters, and pending proposals.
- Temporary analyzer-session cleanup is best-effort; cleanup failures are reported only when they affect the command result.

## Public Repository Surface

`AGENTS.md` and `CLAUDE.md` are public contributor/agent guides. `.claude/` settings are local automation and are not part of the public source or npm package.

## Commands

The plugin intercepts `/self-evolve` through `command.execute.before`; command output is deterministic and does not require a normal model turn.

- `/self-evolve`
- `/self-evolve help`
- `/self-evolve status`
- `/self-evolve pause`
- `/self-evolve resume`
- `/self-evolve disable`
- `/self-evolve scan`
- `/self-evolve dismiss <proposal-id>`

Bare `/self-evolve` and `/self-evolve scan` are equivalent manual scans. Status, pause, resume, disable, and dismiss are deterministic control commands.

## Troubleshooting

- **`/self-evolve status` becomes a normal model turn:** confirm the package is installed in the opencode config environment, the `plugin` entry is present in `opencode.json`, and opencode was restarted after registration changed.
- **The command says no proposal was found:** the analyzer either found no safe actionable local tooling improvement, returned low-confidence output, or proposed a duplicate/unsafe target. This is expected for many sessions.
- **The command reports analyzer failures:** run `/self-evolve status` to check the session state. Repeated malformed analyzer output can disable the session after `maxAnalyzerFailures`.
- **`npm run smoke:live` cannot find opencode:** install opencode locally or set `OPENCODE_BIN` to the opencode binary path.
- **`npm run smoke:live` fails to bind `127.0.0.1`:** run it in an environment that permits local loopback server binding. Some sandboxes deny this even though normal local development and CI allow it.

## Analyzer Contract

The config hook registers hidden primary agent `self-evolve-analyzer` with the configured default model, temperature `0`, one step, and all tools denied. The analyzer must return strict JSON matching `analyzer-prompt.js`. The plugin instructs strict JSON but still parses text-mode output with a defensive brace-extraction fallback after the analyzer returns, so do not describe accepted output as raw strict JSON only.

A valid proposal needs concrete evidence, target, placement, risk, mitigation, confidence, and suggested action. Invalid JSON and malformed analyzer output are counted analyzer failures and can disable the session after `maxAnalyzerFailures`. Low-confidence, duplicate, vague, unsafe, or otherwise non-actionable proposals are suppressed without counting as analyzer failures.

## Validation

Run from this directory:

```sh
npm test
npm run check
npm run pack:check
npm run smoke:live
```

`npm run pack:check` builds the npm tarball in a temporary directory, verifies the intended public file set, excludes repo-only agent/backlog files, extracts the tarball, and imports the packed plugin entrypoint.

`npm run smoke:live` starts a disposable real `opencode serve` process with an isolated temporary config and a fixture plugin. It verifies live plugin loading, absence of passive event/chat hooks, and the `command.execute.before` hook for deterministic control commands without invoking the provider/model-backed `/session/{id}/command` endpoint or spending tokens.

GitHub Actions runs the no-token release gates on push and pull request: `npm test`, `npm run check`, `npm run pack:check`, and `npm pack --dry-run --json --ignore-scripts`. `npm run pack:check` is the CI-safe packed-artifact smoke; `npm run smoke:live` remains a local release check because it needs an installed opencode binary and localhost binding.

After changing this plugin or parent registration/docs, restart opencode. Running sessions keep already-loaded plugin/config state.
