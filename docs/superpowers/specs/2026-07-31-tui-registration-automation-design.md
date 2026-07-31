# Automatic TUI Target Registration — Design

- Date: 2026-07-31
- Status: approved, not implemented
- Scope: `@mcrescenzo/opencode-self-evolve` server target

## Problem

The package ships two targets that OpenCode loads through two different
loaders and two different config files:

| Target | Config file | Resolved entry |
|---|---|---|
| server (`.`) | `opencode.json` → `plugin` | `exports["./server"]`, falling back to `main` |
| TUI (`./tui`) | `tui.json` → `plugin` | `exports["./tui"]`, no fallback |

Registering the server target does not register the TUI target. A user who
follows the README's first code block gets a working headless plugin and no
native UI, with no error anywhere: the durable pipeline, `/self-evolve`
commands, and the inbox all work, while the sidebar indicator and control
center are simply absent. The failure is silent because a missing TUI plugin
is also the normal, correct state for a headless host.

## Background: how OpenCode 1.18.10 handles this

Verified by reading the shipped binary at `~/.opencode/bin/opencode`
(version 1.18.10) and by `opencode plugin --help`.

**A native installer already exists.** `opencode plugin <module>` (alias
`plug`, flags `--global/-g`, `--force/-f`) installs a package, reads its
manifest for targets, and writes *both* config files.

**Target detection reads `package.json`:**

- `server` ← `exports["./server"]`, else a non-empty `main`
- `tui` ← `exports["./tui"]`, else a non-empty `oc-themes` array
- per-target options ← `exports["./<target>"].config`, which the installer
  writes as a `[spec, opts]` tuple

**Runtime entry resolution** looks up `exports["./<target>"]`. For any target
other than `server` there is no fallback; `server` falls back to `main`.
`exports["."]` is never consulted for either target. This package therefore
depends on `main` for server resolution today.

**The installer's writer** performs a JSONC-preserving insert into the
`plugin` array, reporting `add`, `noop` ("Already configured"), or `replace`
(only under `--force`). Its scope rule is: global → the OpenCode config dir;
otherwise `path.join(vcs === "git" && worktree !== "/" ? worktree : directory,
".opencode")`. It writes the **bare package spec** into `tui.json`, not a
`<pkg>/tui` subpath.

**Duplicate registrations are handled by the host.** There is a
`deduplicatePluginOrigins` pass, and the loader rejects a plugin whose ID
collides with one already loaded. A registration written into project scope
while global scope already registers the same package results in a rejected
duplicate, not a double-loaded plugin.

**Config discovery is multi-file and merged** — the global config dir, then a
find-up from cwd over `tui.json` / `tui.jsonc`.

**There is no TUI auto-discovery.** Unlike server plugins, which are globbed
from `{plugin,plugins}/*.{ts,js}` in directory-type config entries, TUI
plugins are only ever loaded from `tui.json`.

**OpenCode writes `tui.json` itself** during config migration, emitting
`JSON.stringify(value, null, 2)` and backing the original up to
`<file>.tui-migration.bak`.

**`OPENCODE_PURE` / `--pure` skips external TUI plugins entirely.**

**The TUI ships palette commands** `plugins.list` ("Plugins") and
`plugins.install` ("Install plugin"), with configurable `plugin_manager` and
`plugin_install` keybinds (both default `none`). `plugins.install` opens a
prompt for a package name, so it cannot be driven with an argument from the
server target.

## Goals

1. A machine with this package's server target loaded ends up with the TUI
   target registered, without the user editing any file by hand.
2. The write is deterministic, idempotent, auditable, and reversible.
3. A config file that cannot be edited safely is left completely untouched.

## Non-goals

- Registering the server target. If we are running, it is already registered.
- Hot-loading the TUI plugin into a running session. The hot-add path
  (`pending` map → `addPlugin`) lives in the TUI process and is unreachable
  from the server target. Registration takes effect on the next start.
- Editing `opencode.json` under any circumstance.
- Any interactive prompt, toast, or transcript message. The operator has
  chosen a silent background write.

## Design

### Trigger and gating

Runs in the server target only, during durable boot, from
`self-evolve-integration.js`. At most once per process, fire-and-forget, and
wrapped so it can never fail or delay boot.

Skipped entirely when any of:

- `OPENCODE_PURE` is set — the host has declared no external TUI plugins, so
  registering would be inert and presumptuous.
- `SELF_EVOLVE_KILL=1` — matches the existing fail-closed posture.
- The `autoRegisterTui` setting is disabled. It defaults to **on**.

### Detection

Read every tui config file OpenCode itself would read: the global config dir
plus a find-up from cwd, over both `tui.json` and `tui.jsonc`. Parse
permissively — detection only reads, so it carries no contract weight and may
tolerate JSONC that the writer refuses.

Normalize each `plugin` entry (string form and `[spec, opts]` tuple form) and
match this package in any of its forms: the bare package name, the
`<pkg>/tui` subpath, or a path ending in `self-evolve-tui.tsx` or
`self-evolve-tui.js`. A match in **any** candidate file means already
registered — no write.

### Target selection

The **global** config dir — `$XDG_CONFIG_HOME/opencode` when set, otherwise
`~/.config/opencode` — resolved through symlinks to its realpath.

Global rather than project scope because the operator's goal is "registered on
every machine". Project scope would scatter a `.opencode/tui.json` into every
unrelated repository opened. This deliberately inverts OpenCode's own
installer default, which is project scope with `-g` for global.

Prefer an existing candidate in that directory (`tui.json`, then `tui.jsonc`);
otherwise create `tui.json`.

### Spec form

Chosen deterministically from how this module itself resolved:

| Load context | Spec written | Rationale |
|---|---|---|
| Inside `node_modules` | `@mcrescenzo/opencode-self-evolve` | Portable; matches what OpenCode's installer emits |
| A checkout under the target file's realpath directory | relative to that directory, e.g. `./plugins/self-evolve/self-evolve-tui.tsx` | Relative specs resolve against the declaring `tui.json`, so the entry survives the repo living at a different absolute path on another machine |
| Anywhere else | absolute path | Machine-specific by nature; last resort |

The relative case matters for git-synced configs: an absolute path written
into a version-controlled `tui.json` breaks on the next machine.

### The writer

The core safety property is that **the edit is verified semantically before
it reaches disk**.

1. Read the target. Require strict `JSON.parse`. This deliberately excludes
   comments and trailing commas, which cannot be preserved without adding a
   dependency.
2. Locate the `plugin` array's bracket span with a string-aware scanner that
   tracks quote state and escapes and counts bracket depth, so nested tuple
   entries are handled correctly.
3. Insert `"<spec>"` before the closing `]`, matching the indentation of the
   last element. No re-serialization: every other byte of the file is
   preserved exactly, including formatting, key order, and spacing.
4. If there is no `plugin` key, insert one before the root object's closing
   `}`. If the file is absent, create it as
   `{"$schema": "https://opencode.ai/tui.json", "plugin": ["<spec>"]}` using
   `JSON.stringify(value, null, 2)` with a trailing newline, mirroring
   OpenCode's own migration writer.
5. Re-parse the edited text and assert deep equality against
   `{...original, plugin: [...originalPlugin, spec]}`. On any mismatch,
   discard the edit and write nothing.

### Refusal cases

Refuse, leave the file untouched, and record the reason when: the content is
not strict JSON; the root is not an object; `plugin` exists but is not an
array; post-edit verification fails; the resolved target escapes the config
dir; the target is a directory; or the file is not writable.

Refusal is a supported outcome, not an error state. The operator keeps a
valid config and the audit record explains what was skipped and why.

### Atomicity, symlinks, permissions

`~/.config/opencode/tui.json` is commonly a symlink into a version-controlled
config repository, as it is on the primary development machine here.

- `realpath` the target before writing. Write the temp file into
  `dirname(realpath)` and `rename()` onto the **realpath**.
- Never `rename()` onto the symlink path — doing so replaces the symlink with
  a regular file and silently detaches the global config from its repository.
- When the file does not exist, realpath the parent directory instead.
- Copy the original file mode onto the temp file before rename, so a `0600`
  config is not widened to `0644`.
- The store's existing "reject symlinks" rule (`SECURITY.md:50`) must **not**
  be reused here; it would refuse to write on exactly this common setup. The
  registration writer's rule is resolve-and-write-through, never replace.

### Locking

Our own cross-process lock keyed by the resolved realpath, in a namespace
separate from the store lock, so two simultaneously booting processes cannot
double-insert.

A residual race with OpenCode's own `opencode plugin` writer is unavoidable —
it uses a different lock namespace. Both sides write atomically, so the worst
case is one write landing and the other becoming a no-op on the next boot.

### Backup and audit

Before any write, copy the original bytes into the state root, where the
existing retention machinery applies. Not a sibling `.bak`, which would drop
an untracked file into a git-tracked config repo.

Append a durable audit record carrying timestamp, realpath, spec written, mode
(`created` | `inserted`), and backup location. `/self-evolve status` reports
it. This is what makes the carve-out defensible: the write is silent in the
moment but never invisible afterward.

### Retry

One attempt per process. Refusals are recorded; later boots retry, and
identical consecutive failures are deduplicated so the audit log stays
bounded.

### Placement

New module `self-evolve-registration.js`, using only `node:fs` and
`node:path`. It imports neither target, satisfying the dual-target invariant
for shared helpers. Called from `self-evolve-integration.js` at boot. Added to
`package.json` `files[]` and to the `check` script's `node --check` list.

## Contract carve-out

The invariant that currently forbids this is one design sentence, not a
security invariant. For the record:

- `SECURITY.md:54-66` lists nine Permanent Prohibitions. **None covers host
  configuration.** Item 7 is "Applier access outside the canonical allowlist",
  scoped to the applier.
- `README.md:127` promises "never writes outside the canonical **skill**
  allowlist. The transactional applier is the only **skill** writer."
- `docs/autonomy-contract.md:69` forbids "Read+write OpenCode **skill files**
  outside allowlist".
- `docs/configuration.md:34` states "This package does not edit external
  configuration." This is the only text that blocks this feature.

The skill-allowlist invariant is a model-output containment boundary: nothing
the model authors may escape into arbitrary files, and the applier is the one
audited chokepoint. This writer contains no model output at all — its input is
a fixed spec string derived from the package's own resolved path. It does not
touch that threat model.

Required edits:

1. `docs/configuration.md` — replace the blanket statement with the scoped
   exception.
2. `CLAUDE.md` — restate precisely: the applier is the only **skill** writer;
   registration bootstrap is a separate deterministic writer with a fixed,
   single-purpose scope.
3. `SECURITY.md` — add the bound: the registration writer may only insert this
   package's own spec into a `plugin` array in a **tui** config file, and may
   never modify other entries, other keys, or `opencode.json`.
4. `docs/autonomy-contract.md` and `README.md` — normative behavior and the
   on-by-default setting.

## Testing

`node:test` under `tests/`, fixtures under `tests/fixtures/`.

**Detection.** Already-registered no-ops for each form: bare name, `<pkg>/tui`
subpath, relative path, absolute path, and `[spec, opts]` tuple. A match in
any candidate file counts.

**Write.** Absent file creates with `$schema` and `plugin`; multi-line array
inserts with matching indentation; single-line array; empty array; file with
no `plugin` key. Every case asserts all other bytes are identical.

**Refusal.** Comments, trailing commas, root-is-array, `plugin`-is-a-string,
unparseable content, injected post-edit verification mismatch,
directory-as-target, unwritable file. Each asserts the original is untouched.

**Symlink regression.** Target is a symlink; after the write the symlink still
exists, still points at the same realpath, and the realpath's content changed.
This is the specific guard against detaching a config repo.

**Also.** Mode preservation (`0600` stays `0600`); no partial file or leftover
temp on failure; idempotency (twice yields one entry); concurrency (two
callers under the lock yield one entry); env gates (`OPENCODE_PURE`,
`SELF_EVOLVE_KILL`, setting disabled); spec-form selection across all three
load contexts; audit record fields surfacing in `/self-evolve status`.

Existing gates continue to apply: `npm test`, `npm run check`,
`npm run pack:check`. `pack:check` catches the new module if it is missing
from `files[]`.

## Rollout

1. **Manifest and docs fixes.** Add explicit `exports["./server"]` while
   keeping `main` for back-compat; correct the documented `tui.json` spec
   form; lead the Quick Start with
   `opencode plugin @mcrescenzo/opencode-self-evolve`. Independent of the rest
   and valuable on its own.
2. **`self-evolve-registration.js` and its tests**, not yet wired in.
3. **Contract and doc updates** from the section above.
4. **Wire into `self-evolve-integration.js` boot**, last, so the writer is
   fully tested before anything calls it.

## Open question and how it is settled

The README documents `@mcrescenzo/opencode-self-evolve/tui` as the `tui.json`
value, while OpenCode's installer writes the bare package name. The subpath
form is passed through npm-package-arg and then to `bun add`, which is not
expected to accept a subpath spec. This is unverified.

`scripts/packed-tui-consumer-matrix.mjs` already packs the tarball and
installs it into temporary consumer projects across OpenCode versions.
Extending it to try both spec forms settles this empirically. Whichever form
loads is what both the documentation and the writer emit.

## Risks

- **Silent host-config mutation.** Accepted deliberately for a single-operator
  package. The on-by-default setting, the audit record, and the state-root
  backup are the mitigations. If the package is ever published broadly, this
  default deserves revisiting.
- **Limited benefit for the current setup.** The operator's config repo is
  version-controlled and already contains the registration, so cloning it onto
  a new machine brings the registration along and detection will no-op. The
  feature earns its keep for a genuinely fresh config and for machines that
  consume the published npm package instead of the checkout.
- **Hand-rolled JSON editing.** Mitigated by requiring strict JSON, verifying
  the edit semantically before writing, and refusing anything unusual.
