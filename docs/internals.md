# Internals

This page covers how `self-evolve` is wired up under the hood: its opencode hooks, its runtime
behavior, the analyzer contract, and what the CI/release checks verify. It's aimed at
contributors and agents working on the plugin itself — see the [README](../README.md) for the
user-facing quick start, and [docs/configuration.md](configuration.md) for the full options
reference.

## Hooks

The plugin registers exactly three opencode hooks:

- `config` — registers the hidden, deny-all-tools `self-evolve-analyzer` primary agent and captures the configured default model.
- `command.execute.before` — intercepts `/self-evolve` and its subcommands; this is the only entry point that can trigger an analyzer run.
- `dispose` — clears the in-memory session registry when opencode unloads the plugin.

It does not register `event` or `chat.message` hooks; analysis only ever runs from an explicit `/self-evolve` command.

## Behavior

- Maintains plugin-owned in-memory state per active `sessionID` only; opencode may still have transient runtime records/logs for temporary analyzer sessions.
- Registers no passive event or chat hooks for analysis; the analyzer is called only from the `/self-evolve` command hook.
- Uses deterministic gates before hidden analyzer calls: analyzer run cap, proposal cap, failure cap, pause/disable state, and one pending proposal at a time.
- Reads recent active-session messages with opencode SDK compatibility fallbacks, bounds and redacts the transcript, then sends the analyzer prompt, JSON schema, redacted transcript excerpt, and analyzer JSON response through a temporary isolated analyzer session with a timeout.
- Never falls back to active-session analyzer prompting; if temporary session creation or prompting fails, the scan fails closed with human-readable command output.
- Cleans up the temporary analyzer session best-effort through the verified abort/interrupt lifecycle path; cleanup failure does not mask a valid analyzer result.
- Validates strict JSON proposals plugin-side before returning a full human-facing advisory in deterministic command output and showing an optional TUI toast. It does not post advisory text back into the active session with `promptAsync` or rely on `noReply` behavior.

## Analyzer Contract

The config hook registers hidden primary agent `self-evolve-analyzer` with the configured default model, temperature `0`, one step, and all tools denied. The analyzer must return strict JSON matching `analyzer-prompt.js`. The plugin instructs strict JSON but still parses text-mode output with a defensive brace-extraction fallback after the analyzer returns, so do not describe accepted output as raw strict JSON only.

A valid proposal needs concrete evidence, target, placement, risk, mitigation, confidence, and suggested action. Invalid JSON and malformed analyzer output are counted analyzer failures and can disable the session after `maxAnalyzerFailures`. Low-confidence, duplicate, vague, unsafe, or otherwise non-actionable proposals are suppressed without counting as analyzer failures.

## Validation And CI Mechanics

Run from the repository root:

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
