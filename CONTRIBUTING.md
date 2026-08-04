# Contributing

This plugin is intentionally conservative:

- Manual analysis remains command-driven; validated `auto` and `yolo` modes admit only the documented idle/status/compaction scheduler events.
- The analyzer must remain hidden, isolated, and tool-denied.
- Durable state must remain inside the validated OpenCode state root. Never add external-tracker writes, network publication, Git mutation, implementation/shell agents, or arbitrary external-system mutation.
- The transactional applier is the only skill-file writer and must preserve consent, allowlist, hash, lease, evidence, audit, and rollback gates.
- Keep the server root headless-safe and the deterministic built TUI target-exclusive. The TSX authoring source remains typechecked, while consumers load only the generated JavaScript export. The normal Release B UX is the persistent sidebar plus the Home, Recommendations, Activity, and Settings control center opened by `mcrescenzo.self-evolve.control-center`; slash commands remain a documented headless/compatibility fallback.
- Legacy compatibility state remains session-local and in-memory. Durable autonomy state never enters the legacy registry.

Local validation requires Node.js 22.11 or newer and Bun 1.3.x. Run the
validation commands before proposing changes:

```sh
npm test
npm run check
npm run pack:check
npm run test:tui-matrix
npm run test:tui-coexistence -- --workflows ../opencode-workflows --attempts 10 --witness
npm run smoke:live
```

See [docs/internals.md](docs/internals.md) for what each of these checks verifies and how the
plugin's hooks, native projection protocol, and analyzer contract work. The packed TUI matrix
requires registry access; exact-host interactive evidence is a separate operator gate and must
not be inferred from deterministic tests. The coexistence command delegates to the supplied
OpenCode Workflows checkout's canonical harness; its primary readiness stage contains only the
two product TUI plugins, and its optional witness runs afterward.

Do not add ordinary runtime dependencies. The only approved optional peers are the exact target-exclusive TUI contract recorded in `AGENTS.md`; any other package or range requires maintainer approval.

## Repository Surface

`AGENTS.md` and `CLAUDE.md` are public contributor/agent guides. `.claude/` settings are local automation and are not part of the public source or npm package.
