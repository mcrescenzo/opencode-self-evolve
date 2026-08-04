# Release B Candidate And Verification Record

This record identifies the unpublished Self-evolve UX Release B working-tree
candidate. It is separate from the historical Release A record and does not
authorize a commit, push, tag, npm publication, or GitHub Release.

## Candidate identity

- Package: `@mcrescenzo/opencode-self-evolve`
- Candidate version: `0.2.0` (unpublished working-tree candidate)
- Source commit: `6a1014a608800b038e8efdf21445b03c161f1a9f`
- Working-tree state: intentionally includes the uncommitted Release B
  implementation. The final packed artifact hash and exact inventory identify
  candidate contents beyond the source commit.
- Node: `v25.6.1`
- npm: `11.9.0`
- Bun: `1.3.8`
- Local OpenCode: `1.18.11`
- Packed artifact SHA-256:
  `0d13b9e03652f53d15bde3820d67dae0d6bdf67ebde09e289bd5cff2b2e8d7f8`
- Packed inventory SHA-256:
  `7a5c82a34f4ac3f07b81d15d7a99c521c091a69a772f947cbe19162f5b3d51d3`
- Packed inventory: 36 exact files:
  - `CHANGELOG.md`
  - `CODE_OF_CONDUCT.md`
  - `CONTRIBUTING.md`
  - `LICENSE`
  - `README.md`
  - `SECURITY.md`
  - `analyzer-prompt.js`
  - `docs/autonomy-contract.md`
  - `docs/configuration.md`
  - `docs/control-center-ux.md`
  - `docs/internals.md`
  - `package.json`
  - `self-evolve-applier.js`
  - `self-evolve-bridge.js`
  - `self-evolve-client.js`
  - `self-evolve-commands.js`
  - `self-evolve-core.js`
  - `self-evolve-export.js`
  - `self-evolve-integration.js`
  - `self-evolve-inventory.js`
  - `self-evolve-lock.js`
  - `self-evolve-observation.js`
  - `self-evolve-pipeline.js`
  - `self-evolve-privacy.js`
  - `self-evolve-projection.js`
  - `self-evolve-scheduler.js`
  - `self-evolve-schemas.js`
  - `self-evolve-state-root.js`
  - `self-evolve-store.js`
  - `self-evolve-synthesis.js`
  - `self-evolve-tui-store.js`
  - `self-evolve-tui.generated.js`
  - `self-evolve-tui.js`
  - `self-evolve-tui.tsx`
  - `self-evolve-ui-protocol.js`
  - `self-evolve.js`

## Implemented compatibility contract

- The package root remains one default server export and imports no TUI target
  or optional TUI peer. `self-evolve.js` retains its module-level `const`
  registry and single default export.
- The deterministic built `./tui` target remains package-root isolated and is
  the only target allowed to reach the five optional peers at their existing
  ranges. The TSX authoring source is typechecked but is not a registration
  target.
- `dashboard-v1` is optional and additive beside the unchanged core review
  index. A new TUI with an old server labels enhanced views limited and emits no
  new authority; an old TUI with a new server ignores the additive artifact.
- The v1 protocol offer and core index retain the exact Release A capability
  vocabulary. Release B feature discovery lives inside the independently
  validated dashboard sidecar, so old strict v1 readers never encounter unknown
  offer or index capabilities.
- Structured rejection feedback and repository-mode override require their
  exact dashboard capabilities. Legacy Reject remains the fallback, and the
  repository-mode editor is absent without `control-repo-mode-v1`.
- Release B derives presentation from existing durable records. It adds no
  durable schema migration and does not change consent, privacy, budget,
  allowlist, apply, rollback, export, purge, or headless authority boundaries.

## Deterministic validation record

Heavyweight gates are run sequentially. Results below are deliberately separate
from live-host and real-operator evidence.

| Gate | Result |
|---|---|
| `npm test` | Passed: 749 tests, 749 passed, 0 failed, 0 skipped. |
| `npm run check` | Passed: TUI TypeScript check, deterministic generated-artifact rebuild, generated JavaScript syntax, and every listed Node syntax check. |
| `npm run pack:check` | Passed: 36 exact files, deterministic built TUI validated, and root plus explicit server exports imported from a fresh peerless consumer; hashes are recorded above. |
| `npm run test:tui-matrix` | Passed: exact aligned OpenCode/plugin 1.18.3 floor, 1.18.4 adjacent, and registry-resolved 1.18.11 latest common stable lanes; OpenTUI 0.4.5 and 0.5.0 loaded the built target, Solid was 1.9.12, and npm rejected OpenTUI 0.6.0 through the declared peer contract. Resolution time: `2026-08-04T00:51:44.684Z`. |
| `npm run bench:perf` | Passed thresholds on Node v25.6.1 with 3,460 audit records / 1,853,453 bytes. Post-drain medians: idle 7.433 ms, lifecycle 2.155 ms, boot 63.171 ms. |
| `git diff --check` | Passed with no output. |
| `npm run smoke:live` | Passed against local OpenCode 1.18.11: official health/CLI/plugin version agreement, both target loads, durable boot and restart modes, plugin-owned production command route, exact headless apply/replay, mailbox/control lifecycle, process stop, and temporary-state cleanup. |

This table is a point-in-time record of the candidate and dependency resolution stated above, not a promise that future unpinned registry resolution will reproduce it. Upstream OpenCode/OpenTUI peer metadata can drift; rerun the current gates for any new candidate and record fresh versions and hashes separately.

Targeted contract evidence covers dashboard protocol validation, projection and
bridge publication, immutable TUI view models, shared operational precedence,
sidebar destinations, recommendation lifecycle actions, structured rejection
fallback, semantic activity privacy, diagnostics, repository-mode
capability/replay/version behavior, canonical allowlist validation, and
four-section renderer source/artifact constraints.

The first live-smoke attempt failed only its direct-child command-hook sentinel:
the fixture had pre-registered a different `self-evolve` command, so production
ownership safeguards correctly treated it as foreign. The fixture registration
was removed, the probe was tightened to inspect both command results and session
history, and the required full smoke rerun passed. This was a verification
fixture defect, not a waived product failure.

## Built-artifact and two-TUI coexistence evidence

The current Self-Evolve `./tui` export is
`self-evolve-tui.generated.js`, SHA-256
`dfe9d60d648e191cd7440450b8545745325f1c5c6c6438d44aa6bd44611ab094`.
The paired OpenCode Workflows 0.6.0 checkout exported
`workflow-tui/index.js`, SHA-256
`2b7223b8a778dc4bbc76bba130a3c8c16c4aa7775be3c944278ea5b1e1a2dc94`.
Its counterpart epic `opencode_workflows-vkdp` had 7 of 8 children closed;
only its final aggregate gate remained open when this evidence was recorded.

On OpenCode 1.18.11, the canonical Workflows harness passed 30 source-checkout
no-witness starts: 10 Workflows-alone baselines and 20 paired starts split
across both registration orders. All reached the input-ready frame with zero
provider prompts and no MCP requirement. Two later witness starts proved both
stable plugin IDs active and both exact palette commands registered. Separate
packed-candidate, symlinked-configuration, and representative two-server-plugin
lanes each passed 3 no-witness and 2 witness starts. The witness never served as
the primary readiness signal. Receipts are local live-host evidence, not
independent human acceptance or publication evidence.

The same source candidates also passed the supported OpenCode 1.18.3 floor in
fresh processes: 3/3 no-witness starts (Workflows alone and both paired
registration orders) reached input readiness, and 2/2 later witness starts
proved both stable IDs and commands. Provider prompts were zero and MCP was not
required. The sanitized receipt is
`/tmp/self-evolve-coexistence-opencode-1.18.3-20260803/receipt.json`.

## Privacy inspection

Home, sidebar, Recommendations, Activity, diagnostics, and errors use only
bounded safe view-model fields. Tests reject transcript/message text, raw host
session or message IDs, proposal/request IDs, nonces, hashes, fingerprints,
state-root identity, arbitrary audit details, provider errors, prompts, and
private paths. Canonical approved-folder paths appear only in their high-risk
Settings editor. A native sensitive export may display only its intentionally
private path plus bounded size, SHA-256, and expiry metadata after explicit
confirmation; no normal surface provides a raw-log viewer.

## Real operator acceptance matrix

This gate is non-substitutable. Deterministic renderer, protocol, store, and
live-command tests do not prove visual or interactive behavior.

| Requirement | Evidence status |
|---|---|
| 140x40, 80x24, and approximately 64x20 layouts | Automated exact-host witness passed; independent human review outstanding. |
| Keyboard navigation, Enter/Space, and exact Escape restoration from every focused child | Automated route witness plus renderer tests passed; independent human review outstanding. |
| Pointer selection and activation parity | Automated pointer navigation, activation, and scrolling passed; independent human review outstanding. |
| Sidebar deep-links and palette Home entry | Automated exact-host witness passed; independent human review outstanding. |
| Long rationale, errors, diffs, and approved-root wrapping/truncation | Automated pointer-scroll witness plus bounded renderer tests passed; independent human review outstanding. |
| Readiness, setup, recommendation, applied, waiting, failure, and degraded states | Automated exact-host witness passed; independent human review outstanding. |
| Workspace/project switch and restart lifecycle | Fresh-process restart into a distinct isolated project passed; independent human review outstanding. |
| New-TUI/old-server and old-TUI/new-server interactive behavior | New-TUI/old-server fail-closed interaction passed. The exact Release A TUI from commit `6a1014a608800b038e8efdf21445b03c161f1a9f` also passed against the candidate server, read the unchanged core projection, ignored `dashboard-v1`, opened its legacy control center, and restored the prior route; independent human review remains outstanding. |
| No ambient toasts, attention notifications, auto-opened dialogs, or raw-log surface | Automated no-ambient assertion and renderer/source tests passed; independent human review outstanding. |
| Screenshots or equivalent exact-host render evidence | Normalized exact-host frames and integrity hashes recorded; independent human review outstanding. |

The full automated receipt, invocation, package lane, and frame hashes are in
[the Release B automated operator evidence record](release-b-operator-evidence.md).
No owner waiver has been assumed. Automated implementer-authored evidence is
not independent human acceptance, so Release B UX is **not complete** and the
final Beads gate remains open.

## Migration, disable, and rollback

Release B changes only the native presentation and additive projections. The
durable inbox, exact headless approval tuple, emergency controls, manual scan,
recovery, export, purge, settings, proposals, and snapshots remain supported.
Restart OpenCode after package or registration changes; running sessions retain
their already-loaded targets.

To disable the native surface, remove `@mcrescenzo/opencode-self-evolve`
from `tui.json`, keep the server entry in `opencode.json`, and restart. To
disable durable autonomy without deleting state, use the documented compatibility
option and restart. Rollback is package/configuration rollback followed by an
OpenCode restart; do not copy, merge, or delete state roots as part of code
rollback.

## Release boundary

- Independent operator evidence remains a human gate and is not self-passed.
- The candidate is intentionally dirty, so the source commit alone is not a
  content identifier.
- Publication authorization, registry readback, tag creation, and GitHub
  Release creation remain outside this work and were not performed.
