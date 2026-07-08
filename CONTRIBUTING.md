# Contributing

This plugin is intentionally conservative:

- Manual `/self-evolve` commands are the only analysis trigger.
- The analyzer must remain hidden, isolated, and tool-denied.
- The plugin must not edit files, write to external issue trackers or memory systems, publish, push, or mutate external systems without explicit user approval.
- Session state stays in memory only.

Run the validation commands before proposing changes:

```sh
npm test
npm run check
npm run pack:check
npm run smoke:live
```

See [docs/internals.md](docs/internals.md) for what each of these checks verifies and how the
plugin's hooks and analyzer contract work.

Avoid adding runtime dependencies unless there is a strong reason and the safety tradeoff is documented.

## Repository Surface

`AGENTS.md` and `CLAUDE.md` are public contributor/agent guides. `.claude/` settings are local automation and are not part of the public source or npm package.
