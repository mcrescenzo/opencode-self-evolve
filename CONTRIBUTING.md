# Contributing

This plugin is intentionally conservative:

- Automatic recommendations is exactly On or Off. On admits only future eligible idle/status/compaction work with all required permissions and a current automation generation; Off is a cross-process no-backfill boundary. Neither state grants write authority.
- The legacy analyzer, Manual/on-demand scan, project modes, ordinary Pause, separate passive-call consent, `durableAutonomy: false`, and module-level legacy registry remain deleted. The durable synthesizer and critic stay hidden, isolated, and tool-denied.
- Durable state must remain inside the validated OpenCode state root. Never add external-tracker writes, network publication, Git mutation, implementation/shell agents, or arbitrary external-system mutation.
- The transactional applier is the only skill-file writer and must preserve action-specific permissions/support, host-global or explicit-creation target provenance, hash, lease, evidence, audit, and rollback gates.
- Keep the server root headless-safe and the deterministic built TUI target-exclusive. The TSX authoring source remains typechecked, while consumers load only the generated JavaScript export. The normal Release B UX is the persistent sidebar plus the Home, Recommendations, Activity, and Settings control center opened by `mcrescenzo.self-evolve.control-center`; slash commands remain a documented headless/compatibility fallback.
- Legacy v0.2/v0.3 state and protocols are bounded migration or read-only input only; they never regain writable v0.4 authority.

Local validation requires Node.js 22.11.0 or newer and Bun 1.3.8 or newer. Run the
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
plugin's hooks, native projection protocol, and synthesizer/critic contract work. The packed TUI matrix
requires registry access; exact-host interactive evidence is a separate operator gate and must
not be inferred from deterministic tests. The coexistence command delegates to the supplied
OpenCode Workflows checkout's canonical harness; its primary readiness stage contains only the
two product TUI plugins, and its optional witness runs afterward.

Do not add ordinary runtime dependencies. The only approved optional peers are the exact target-exclusive TUI contract recorded in `AGENTS.md`; any other package or range requires maintainer approval.

## Repository Surface

`AGENTS.md` and `CLAUDE.md` are public contributor/agent guides. `.claude/` settings are local automation and are not part of the public source or npm package.
