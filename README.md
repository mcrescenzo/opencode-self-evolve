# opencode Self-Evolve Plugin

Long opencode sessions build up small friction that nobody stops to notice: a skill that's missing a case you keep hitting, a command you keep retyping by hand, a convention that only lives in your head. Most of it just accumulates, session after session, because reviewing your own transcript for "what would have made this smoother?" isn't something you have time to do.

`self-evolve` does that review for you. Run `/self-evolve scan` and it reads the recent conversation and, when it finds one concrete, evidence-backed opportunity to improve your local opencode tooling — a skill, command, agent, workflow, plugin, or project convention — it hands you a single advisory proposal: what it noticed, why, and what you could do about it. No proposal at all is a common and expected result; it only speaks up when it has real evidence.

It's deliberately conservative: it's a first-party opencode plugin that only ever runs when you explicitly type `/self-evolve` or `/self-evolve scan`, and it never edits files, calls internal tooling, writes to external issue trackers or memory systems, publishes, pushes, or mutates any external system. It proposes; you decide.

## Quick Start

Install the package in your opencode config environment:

```sh
npm install @mcrescenzo/opencode-self-evolve
```

Then register it in `opencode.json`:

```json
{
  "plugin": ["@mcrescenzo/opencode-self-evolve"]
}
```

Restart opencode after changing plugin registration — a running session keeps whatever plugin list and instructions it loaded at startup.

Working from a source checkout instead? Register the checkout's entrypoint path rather than the package name:

```json
{
  "plugin": ["./self-evolve.js"]
}
```

To confirm it loaded, start a new opencode session and run:

```text
/self-evolve status
```

You should see output starting with `Self-evolve status: active`. If the command instead turns into a normal model prompt, the plugin didn't load, or opencode wasn't restarted after you changed the registration.

## Example

Say you spend a session re-running the same debugging command by hand a few times. Running a scan afterward might surface something like this:

```text
$ /self-evolve scan
```

```text
Self-evolve found a possible improvement: Add a skill for the payments log-tailing routine

You ran `docker logs payments-api | grep ERROR | tail -n 50` by hand four times this
session while tracking down the checkout bug. A small skill would save the retyping
next time this comes up.

Advisory only: no changes will be made unless you explicitly ask.
Options:
- Implement now: ask an agent to make this change.
- Save follow-up: ask to record it as backlog work for later.
- Ignore it: run /self-evolve dismiss se-1.
- Disable self-evolve for this session: run /self-evolve disable.

Proposal ID: se-1
Placement: repo-local
Target: .claude/skills/tail-payment-logs.md
Risk: low. Mitigation: the skill only wraps a read-only log command; review before adding.
Confidence: 0.81
Evidence:
- You ran the same docker logs/grep/tail sequence in 4 separate turns.
- You said "let's not do this by hand again" after the third repeat.

Suggested action: draft a skill that wraps the docker logs/grep/tail sequence with a
parameterized service name.
```

This is an illustrative example, not a canned response — the real analyzer reads your actual transcript, so the title, evidence, and suggested action will reflect your own session (or it may find nothing worth proposing at all, which is fine and expected).

## Commands

- `/self-evolve` or `/self-evolve scan` — run a manual analysis (these are equivalent).
- `/self-evolve status` — show session state: pause/disable state, run and proposal counts, pending proposal.
- `/self-evolve pause` / `/self-evolve resume` — temporarily stop or restart manual scans for this session.
- `/self-evolve disable` — turn self-evolve off for this session.
- `/self-evolve dismiss <proposal-id>` — clear a pending proposal.
- `/self-evolve help` — list the commands.

`status`, `pause`, `resume`, `disable`, and `dismiss` are deterministic — they never invoke a model. Only `/self-evolve` and `/self-evolve scan` call the analyzer.

## Supported Environment

- Node.js `>=20.11.0` is required and declared in `package.json`.
- opencode CLI `>=1.17.7` is the supported host range for plugin loading and live smoke validation.
- `npm run smoke:live` uses `OPENCODE_BIN` when set, otherwise `$HOME/.opencode/bin/opencode` or `opencode` on `PATH`.
- The package uses npm scripts and doesn't pin a `packageManager`; there's no install-time build step.
- `@opencode-ai/plugin` is a runtime dependency, documenting the plugin API convention that portable plugin installs rely on.

## Configuration

Most people never need to touch these, but the two you're most likely to tune are:

```json
{
  "plugin": [
    [
      "@mcrescenzo/opencode-self-evolve",
      {
        "minConfidence": 0.8,
        "maxProposals": 2
      }
    ]
  ]
}
```

- `minConfidence` (default `0.72`) — how confident the analyzer must be before a proposal reaches you. Raise it if you're seeing proposals that feel like a stretch.
- `maxProposals` (default `3`) — how many accepted proposals a session can produce before scans stop offering new ones.
- `minIntervalMs` (default `600000`, i.e. 10 minutes) — the cooldown after a scan result before another scan is allowed.

There are eight more tunables covering transcript bounds, timeouts, and analyzer run caps — see [docs/configuration.md](docs/configuration.md) for the full table.

## Privacy And Token Use

- The deterministic control commands (`status`, `pause`, `resume`, `disable`, `dismiss`) never touch a model — they're free and instant.
- A manual scan (`/self-evolve` or `/self-evolve scan`) reads your recent session messages through the opencode SDK, bounds the transcript by message and character limits, redacts common secret-like values, and sends the analyzer prompt plus that bounded, redacted excerpt to your configured model/provider through a temporary, isolated session.
- That means a scan can consume provider tokens according to your configured model/provider — it's a deliberate action, not a background one.
- The analyzer itself is hidden, runs at temperature `0`, takes one step, and has every tool denied; the plugin validates its output locally before showing you anything.
- The plugin never writes files, persists proposals, publishes packages, pushes git data, writes to external issue trackers or memory systems, or mutates external services.

## Limitations

- Redaction is defensive, not a guarantee — don't run a scan over transcript content that should never reach your configured provider.
- Proposals are advisory only. You (or an agent acting on your behalf) still have to review and apply any suggested change yourself.
- Session state lives in memory only. Restarting opencode clears pause state, counters, and any pending proposal.
- Cleaning up the temporary analyzer session is best-effort; a cleanup failure is only reported when it affects the command result.

## Troubleshooting

- **`/self-evolve status` becomes a normal model turn:** confirm the package is installed in the opencode config environment, the `plugin` entry is present in `opencode.json`, and opencode was restarted after registration changed.
- **The command says no proposal was found:** the analyzer either found no safe actionable local tooling improvement, returned low-confidence output, or proposed a duplicate/unsafe target. This is expected for many sessions.
- **The command reports analyzer failures:** run `/self-evolve status` to check the session state. Repeated malformed analyzer output can disable the session after `maxAnalyzerFailures`.
- **`npm run smoke:live` cannot find opencode:** install opencode locally or set `OPENCODE_BIN` to the opencode binary path.
- **`npm run smoke:live` fails to bind `127.0.0.1`:** run it in an environment that permits local loopback server binding. Some sandboxes deny this even though normal local development and CI allow it.

## For AI Agents

If you're an agent operating in a session where this plugin is installed: it only runs when someone explicitly types `/self-evolve` or `/self-evolve scan` — there's no passive `event` or `chat.message` hook watching the conversation, so it never triggers on its own. Everything it returns is advisory only: it never edits files, calls other tools, or writes to external systems. Treat a proposal as something to relay to the user or act on with their separate approval, not as a standing instruction to execute.

## Development

Run from this directory:

```sh
npm test
npm run check
npm run pack:check
```

Run `npm run smoke:live` when you have a local opencode binary available.

See [docs/internals.md](docs/internals.md) for how the plugin's hooks, analyzer contract, and CI checks work under the hood, and [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and repository layout notes.
