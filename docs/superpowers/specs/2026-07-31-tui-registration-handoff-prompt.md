# Handoff prompt — apply the TUI self-registration solution to another OpenCode plugin

Copy everything inside the fence below and give it to the target agent.
Replace `<<TARGET_PLUGIN_PATH>>` before sending.

---

```text
<task>
Mode: implementation, with a mandatory verification phase first.
Objective: make the OpenCode plugin at <<TARGET_PLUGIN_PATH>> register its own TUI
target, so a user who installs the plugin gets the native terminal UI without
hand-editing a second config file.
</task>

<context>
You have no access to the conversation that produced this prompt. Everything you
need is stated here. Do not assume any of it is true of YOUR OpenCode version
until you verify it (see <discovery>).

THE PROBLEM

OpenCode loads plugins through two independent loaders with two separate config
files, and registering one does not register the other:

  | Target      | Config file     | Resolved entry                              |
  |-------------|-----------------|---------------------------------------------|
  | server (.)  | opencode.json   | exports["./server"], falling back to `main` |
  | TUI (./tui) | tui.json        | exports["./tui"], NO fallback               |

A user who registers only the server target in opencode.json gets a fully working
headless plugin and no terminal UI, with no error message anywhere. The failure is
silent because "no TUI plugin" is also the correct state for a headless host. This
is the bug to fix.

VERIFIED OPENCODE INTERNALS (read out of the 1.18.10 binary — re-verify locally)

1. OpenCode already ships an installer: `opencode plugin <module>` (alias `plug`,
   flags --global/-g, --force/-f). It installs the package, reads package.json for
   "targets", and writes BOTH config files.
2. Target detection from package.json:
     server ← exports["./server"], else a non-empty `main`
     tui    ← exports["./tui"],    else a non-empty `oc-themes` array
     per-target options ← exports["./<target>"].config, written as a
     [spec, opts] tuple
3. Runtime entry resolution looks up exports["./<target>"]. Only "server" falls
   back to `main`. exports["."] is NEVER consulted for either target. A package
   whose only entry is exports["."] therefore has NO tui target at all.
4. The installer writes the BARE package name into tui.json (e.g. "@scope/pkg"),
   not a "<pkg>/tui" subpath. The loader resolves exports["./tui"] from the bare
   name.
5. Duplicate registrations are safe: there is a deduplicatePluginOrigins pass, and
   the loader rejects a plugin whose ID collides with one already loaded.
6. tui config discovery is multi-file and merged: the global config dir, plus a
   find-up from cwd, over both tui.json and tui.jsonc.
7. There is NO TUI auto-discovery. Server plugins are globbed from
   {plugin,plugins}/*.{ts,js} in directory-type config entries; TUI plugins are
   only ever loaded from tui.json.
8. OPENCODE_PURE / --pure skips external TUI plugins entirely.
9. A file (non-npm) TUI plugin MUST export a non-empty `id`; an npm package may
   omit it and inherit its package name.
10. OpenCode writes tui.json itself during config migration, using
    JSON.stringify(value, null, 2) and backing the original up alongside it.
11. The TUI ships palette commands `plugins.list` ("Plugins") and
    `plugins.install` ("Install plugin"). `plugins.install` prompts for a package
    name, so it cannot be driven with an argument from a server plugin.

THE SOLUTION SHAPE (proven design, adapt it — do not copy blindly)

A server-target-only module that runs once at boot and, if no tui config registers
this package, writes the registration itself:

  DETECTION   Read every tui config OpenCode would read (global config dir plus
              find-up from cwd, tui.json and tui.jsonc). Parse permissively —
              detection only reads. Normalize each `plugin` entry in BOTH string
              and [spec, opts] tuple form. Match the package in any form: bare
              name, "<pkg>/tui" subpath, or a path ending in the TUI entry
              filename. A match in ANY file means already registered → no write.

  SCOPE       Write the GLOBAL config dir ($XDG_CONFIG_HOME/opencode, else
              ~/.config/opencode), resolved through symlinks to its realpath.
              Global, not project, because the goal is "registered on every
              machine"; project scope scatters .opencode/tui.json into every
              unrelated repo the user opens. This deliberately inverts OpenCode's
              own installer default.

  SPEC FORM   Chosen from how the module itself resolved:
                inside node_modules                        → bare package name
                checkout under the target file's realpath  → path RELATIVE to that
                                                             directory
                anywhere else                              → absolute path
              This matters: an absolute path written into a git-synced tui.json
              breaks on the next machine.

  WRITER      The edit must be verified semantically BEFORE it reaches disk:
                1. Require strict JSON.parse (this deliberately excludes JSONC —
                   comments and trailing commas cannot be preserved without a
                   dependency).
                2. Find the `plugin` array's bracket span with a string-aware
                   scanner (track quote state and escapes, count bracket depth so
                   nested tuple entries work).
                3. Insert the spec before the closing ], matching the indentation
                   of the last element. Do NOT re-serialize — every other byte of
                   the file is preserved exactly.
                4. No `plugin` key → insert one before the root's closing }.
                   No file → create {"$schema": "https://opencode.ai/tui.json",
                   "plugin": ["<spec>"]} via JSON.stringify(v, null, 2).
                5. Re-parse the result and assert deep equality against
                   {...original, plugin: [...originalPlugin, spec]}. Any mismatch
                   → discard, write nothing.

  REFUSE      and record the reason (leaving the file byte-for-byte untouched)
              when: content is not strict JSON; root is not an object; `plugin`
              exists but is not an array; post-edit verification fails; the target
              escapes the config dir; the target is a directory; the file is not
              writable. Refusal is a supported outcome, not an error.

  DURABILITY  ** THE CRITICAL FOOTGUN: ** global config files are very often
              SYMLINKS into a user's version-controlled dotfiles repo. realpath
              the target, write the temp file into dirname(realpath), and rename()
              onto the REALPATH. Renaming onto the symlink path replaces the
              symlink with a regular file and silently detaches the user's config
              from their repo. Also: copy the original file mode onto the temp
              file before rename (a 0600 config must not become 0644); take a
              cross-process lock keyed by the resolved realpath; back up the
              original bytes; and record an audit entry (timestamp, realpath, spec
              written, created|inserted, backup location) that some status command
              surfaces.

  GATING      Server target only (the TUI target cannot bootstrap itself). Once
              per process, fire-and-forget, wrapped so it can never fail or delay
              boot. Skip entirely when OPENCODE_PURE is set (the host has declared
              no external TUI plugins), when the plugin's kill switch is set if it
              has one, and when the feature's own setting is disabled. The write
              takes effect on the NEXT OpenCode start — the hot-add path lives in
              the TUI process and is unreachable from the server target.
</context>

<scope>
In scope:
- Determine whether <<TARGET_PLUGIN_PATH>> actually has a TUI target, and whether
  its package.json exposes it in a way OpenCode can detect.
- Fix the manifest if not (exports["./tui"], and explicit exports["./server"] so
  server detection does not rely on the `main` fallback).
- Fix install documentation to lead with `opencode plugin <module>` and to state
  that BOTH registrations are required for the native UI.
- Implement the self-registration bootstrap described above, if the plugin's
  distribution model warrants it (see <stop_conditions>).

Out of scope:
- Editing opencode.json under any circumstance. If the plugin is running, its
  server registration already exists.
- Hot-loading the TUI plugin into a running session. Not reachable from the server
  target; a restart is required.
- Any change to the plugin's existing features, architecture, or public API beyond
  what the above requires.
- Publishing, tagging, releasing, or pushing.
</scope>

<autonomy>
Proceed autonomously on local, reversible work: reading, editing plugin source,
adding tests, running the plugin's own test/lint/build commands.
Ask before: destructive or shared actions, git push, publishing, deleting files
you did not create, or modifying anything outside <<TARGET_PLUGIN_PATH>> — with
one exception: you MAY write to a scratch HOME/config directory you create
yourself for end-to-end testing.
Never modify the user's real ~/.config/opencode during development or testing.
</autonomy>

<discovery>
Do these BEFORE writing any code, and report what you found.

1. `opencode --version`. The findings above came from 1.18.10. If yours differs,
   re-verify the ones you depend on.

2. Verify against the actual binary. It is a Bun single-file executable and its
   JavaScript is greppable. Byte-offset extraction is far faster than regex over
   a ~180MB file:
     grep -a -b -o -F 'kind==="tui"' "$(readlink -f "$(which opencode)")"
     dd if=<binary> bs=1 skip=<offset-2000> count=6000 2>/dev/null
   Useful anchors: `manifest_no_targets`, `"./server"`, `oc-themes`,
   `plugins.install`, `tui.json`.
   Also run `opencode plugin --help` to confirm the installer exists.

3. Inspect <<TARGET_PLUGIN_PATH>>: package.json (exports, main, files, engines),
   the TUI entry file and whether it default-exports { id?, tui }, existing tests,
   and how the plugin is currently registered in the user's configs.

4. Check how the plugin is actually consumed — npm package, or a path spec from a
   version-controlled config repo? This determines whether the bootstrap is worth
   building at all (see <stop_conditions>).

Distinguish inspected facts from inferences in your report. Anything you did not
verify, label "Not verified".
</discovery>

<instructions>
- Make the smallest change that fully satisfies the objective. Do not refactor
  unrelated code or add speculative abstractions.
- Follow the target plugin's existing conventions: module layout, test framework,
  dependency policy. If it forbids new dependencies, hand-rolling the JSON edit as
  described is the intended approach — do NOT add a JSONC library.
- If the plugin is dual-target, respect its target isolation: the registration
  module must import neither target (no TUI runtime imports, no @opentui/*).
- Do not hard-code to tests or fixtures. Implement the general behavior.
- Write the symlink regression test. It is the single most important test here:
  after writing a symlinked target, assert the symlink STILL EXISTS, still points
  at the same realpath, and the realpath's content changed.
- If the plugin has no durable state or audit facility, do not invent one. Fall
  back to a backup file plus whatever logging the plugin already uses, and say so.
</instructions>

<verification>
Done means:
- The plugin's own test/lint/build commands pass. Discover them from package.json
  scripts; run them and report exact commands and results.
- Tests cover: already-registered no-op in every spec form; insertion into
  multi-line, single-line, and empty plugin arrays with all other bytes unchanged;
  missing plugin key; missing file; every refusal case leaving the file untouched;
  the symlink regression; file-mode preservation; idempotency; and each skip gate.
- End-to-end, in a scratch HOME you create: a fresh config with no tui.json gains
  a correct registration on first boot, and OpenCode actually loads the TUI target
  on the next start. If you cannot run OpenCode, say so explicitly rather than
  implying this passed.
</verification>

<output_format>
Return:
- Summary
- Evidence inspected (with the OpenCode version you verified against, and which
  of the 11 numbered findings you confirmed vs. took on trust)
- Files changed
- Commands run, with exact results
- Verification status, including whether the end-to-end run happened
- Risks / not verified / follow-ups
</output_format>

<stop_conditions>
Stop and report instead of proceeding if:
- The plugin has no TUI target at all. Then the fix is a manifest and docs change
  only, not a bootstrap. Say so and stop.
- The plugin is consumed exclusively as a path spec from a version-controlled
  config repo that ALREADY contains the tui.json registration. The bootstrap would
  no-op on every machine and is not worth building; recommend the manifest and
  docs fixes instead and stop.
- The plugin's own contract forbids writing outside a defined allowlist. That is a
  policy decision for the owner, not for you. Report the exact conflicting text
  and the narrowest carve-out that would permit the write, and stop.
- Your OpenCode version's internals contradict the findings above in a way that
  invalidates the design. Report the specific contradiction with evidence.
</stop_conditions>
```
