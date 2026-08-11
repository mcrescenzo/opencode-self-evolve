# Release B Automated Operator Evidence (historical)

Superseded by `docs/v03-operator-evidence.md` for the v0.3 global-first
candidate. This record is retained as the Release B history.

This record covers the opt-in automated local operator witness for the
unpublished Release B working-tree candidate. It does not claim independent
human review, authorize publication, or replace the final human acceptance
gate in `self-evolve-9s8.8`.

The hashes below describe the unmodified current-candidate run recorded on
2026-08-06. The installed manifest resolved `./tui` to
`self-evolve-tui.generated.js`, and the witness exercised that production
target.

## Candidate and host

- Candidate: `@mcrescenzo/opencode-self-evolve@0.2.0`
- Receipt: `/tmp/opencode/self-evolve-rcdu42-verifier-pass2-20260806.json`
- Packed artifact SHA-256:
  `296713192583c94e49585c2508c38e247430ae26580f2a116494b7a911520ebe`
- Packed inventory SHA-256:
  `68658ce79b993904333ef172bcdb7b740ae537c3e1f38b1eaa74bb79021b7ae2`
- Packed inventory: 36 files
- Pinned Release A TUI source commit:
  `6a1014a608800b038e8efdf21445b03c161f1a9f`
- Pinned Release A `self-evolve-tui.tsx` SHA-256:
  `fd9ece6921ea6672b7f030d078c451062acfc0db51fec40038fb82d8041ed43e`
- OpenCode: `1.18.14`
- Exact TUI lane: `@opentui/core@0.4.5`,
  `@opentui/keymap@0.4.5`, `@opentui/solid@0.4.5`, and
  `solid-js@1.9.12`
- Evidence date: `2026-08-06`

The runner packs the working tree, installs the tarball in a disposable
consumer, validates the installed package graph, and copies the exact installed
candidate bytes outside `node_modules`. OpenCode then loads the copied
`self-evolve-tui.generated.js` export. This preserves the package's
optional-peer policy while allowing OpenCode to supply its one shared
Solid/OpenTUI runtime, as it does for external TUI targets. The package root is
never imported by the TUI host. The mixed-version stage independently extracts
the fixed Release A package files from the recorded Git commit, loads that
historical TUI entry against the candidate server, and verifies that it reads
the unchanged core v1 projection while ignoring `dashboard-v1`.

## Invocation

The gate is inert unless explicitly enabled:

```sh
SELF_EVOLVE_RELEASE_B_OPERATOR_EVIDENCE=1 \
SELF_EVOLVE_RELEASE_B_OPENCODE_BIN="$(command -v opencode)" \
SELF_EVOLVE_RELEASE_B_OUTPUT=/tmp/opencode/self-evolve-release-b-evidence.json \
SELF_EVOLVE_RELEASE_B_TIMEOUT_MS=300000 \
npm run operator:evidence
```

The final run returned `status: passed`,
`productionTuiEntryExercised: true`, stopped every tracked TUI process group,
removed its private scratch tree, and confirmed that `package.json`,
`bun.lock`, and `AGENTS.md` were unchanged by the run. Its public report
contains normalized frames only: session identities, hashes, absolute paths,
file URLs, temporary project labels, and machine-local roots are rejected or
redacted before publication.

## Matrix result

| Stage | Viewport | Production-path evidence |
|---|---:|---|
| 1 | 140x40 | Neutral startup without ambient UI; pointer-opened sidebar Home; pointer navigation across Home, Recommendations, Activity, and Settings; long approved-root rendering only in Settings; exact Escape restoration; automatic-ready sidebar; Enter recommendation deep-link; pointer scrolling through rationale, diff, evidence, safety, token, and rollback sections; palette Home entry; applied state. |
| 2 | 80x24 | Space-opened setup Settings focused the exact first missing consent control; scrolled consent content; waiting/running state; pointer-opened failure Activity/Errors route; new-TUI/old-server fail-closed limited view with no enhanced authority. |
| 3 | 64x20 | Fresh OpenCode process in a distinct isolated project; narrow Home and Settings routes; exact Escape restoration; no physical line wider than 64 columns. |
| 4 | 140x40 | Pinned Release A TUI with the candidate server; legacy startup and ready sidebar; additive `dashboard-v1` ignored; legacy eight-section control center opened through the palette command; exact Escape restoration. |

The witness uses OpenTUI's renderer-level pointer and key helpers against the
real host renderer. It does not call component handlers directly. Each
publication is read back through the bridge and refreshed until the production
shared TUI store matches the exact projection and dashboard hashes. The pinned
Release A store is instead bound to the exact core projection hash and is
asserted not to consume the additive dashboard.

## Final frame integrity hashes

These hashes bind the normalized frames from the final passing run. They are
receipt integrity evidence, not golden snapshots: real pointer scrolling may
settle one row apart while preserving all required visible content.

| Viewport | Frame | SHA-256 |
|---:|---|---|
| 140x40 | `startup-sidebar` | `179688941dda2623d0f11c53f596c9ebc6bfedfe97dcfa20ec58bc244734a5f9` |
| 140x40 | `wide-home-pointer` | `8f15be335e96523cfd03de900929b5a8864591f82935e80504872cd97a6e60b6` |
| 140x40 | `wide-recommendations` | `d229429a9caea968d787b51da4c9825f28f2192648ee65443a70d0fd090988fd` |
| 140x40 | `wide-activity` | `9df88ac6c9bcc87c98a8e907571862d30b8c08665562ed69fbe5bfc0b2ffdbf8` |
| 140x40 | `wide-settings` | `a7bd43355460d713190af40935520e4769af4a9e43fb17e7bbed6b925573bd17` |
| 140x40 | `wide-ready-sidebar` | `f0721eba4ca3f6bc3ee7d38a04b06bc41f9b3ec1b5ac671dba971f4b61b92faf` |
| 140x40 | `wide-recommendation-enter` | `095662c517fedbc4ae0b009a2ec97d15e3db6fa17d332d0bbac9cabe4cc15c5f` |
| 140x40 | `wide-recommendation-safety` | `eb8da8fbaa308dbe830148c694f77ecfeb3df47994b04f68a7e787eea1ab3e43` |
| 140x40 | `wide-recommendation-token` | `8254d939601e9e6ac3b79dbe1248da4b70416e92321293e1285c149caa05ae9a` |
| 140x40 | `wide-recommendation-scrolled` | `96af6416873ae5fa3da998533aee943bc9336c8814b13fc0aff92d3154178359` |
| 140x40 | `wide-applied-palette` | `88a12c2e6665ca9c449d33800657af500f779e17d74ab0855fd249bc070f5627` |
| 80x24 | `startup-sidebar` | `723c4824a817100e9c248b137bf89223f622c7f259faf93da90e52a143c3f46f` |
| 80x24 | `medium-setup-space` | `2e0b4c1be44035d06be399e03cb4191572ddce8435a38e0fd08a2f7362c78a57` |
| 80x24 | `medium-setup-consent` | `818b00bef1fe331de22baea7904171d69ebf941df99cd44745fcd23a6e4c04f3` |
| 80x24 | `medium-waiting` | `1b970a2e20908796c8eec11da36d881e08d10ee71f1785fd7ca66a733395a223` |
| 80x24 | `medium-failure` | `d7bd9e6fc134ff3e128bd9a50b58d836f1b0b60978ddf6833e7777ec67892fe9` |
| 80x24 | `medium-new-tui-old-server` | `9d949eb5319321f56f9dee4280a7328de6024ab8550dec4b498125f9426ba221` |
| 64x20 | `startup-sidebar` | `f0f4db15335fda7e0932a1005ab6ec842cb32ccb665b459eae2373f645cda211` |
| 64x20 | `narrow-home` | `a6036dde64649f38789727bc6b72f456603b991d46e199215c710e9700cb337a` |
| 64x20 | `narrow-settings` | `60f2d88313de545d6eb4015429b3d5a2c62994b072ca11a46b5f2b46c66ffa83` |
| 140x40 | `legacy-startup-sidebar` | `93ece53b5a1724abe00b8218300deca8b08a36f616444d082f5228a73c68d078` |
| 140x40 | `legacy-new-server-sidebar` | `7faafba4bd4983462be0b62fac14ddca9c2294f1511529822567761e90dc5c3d` |
| 140x40 | `legacy-new-server-control-center` | `4c6f503571f678b8f77180a72187e23b01307dd02b63726432dd45d4724f09e1` |

## Remaining acceptance boundary

This is an automated local operator witness authored in the repository and run
by the controller. It is strong exact-host evidence, but
it is not independent human review. The final Release B Beads gate and its
parent epic must remain open
unless an independent reviewer supplies the required acceptance evidence or
the owner explicitly waives that independence requirement. No commit, push,
tag, registry publication, or release was performed.
