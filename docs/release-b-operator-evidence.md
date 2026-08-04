# Release B Automated Operator Evidence

This record covers the opt-in automated local operator witness for the
unpublished Release B working-tree candidate. It does not claim independent
human review, authorize publication, or replace the final human acceptance
gate in `self-evolve-9s8.8`.

The hashes below describe the recorded 2026-07-30 prebuilt-migration baseline,
whose production entry was still raw TSX. The current runner instead requires
the installed manifest to resolve `./tui` to
`self-evolve-tui.generated.js`; its evidence must be rerun before treating this
historical receipt as current-candidate evidence.

## Candidate and host

- Candidate: `@mcrescenzo/opencode-self-evolve@0.2.0`
- Packed artifact SHA-256:
  `d38dcf55f4a48d56b32b7f2dbc475ffa4c791d477f3482b8f0f648a0d6a87ade`
- Packed inventory SHA-256:
  `9f164276ace973481cafd487a95d1152499eb01a2be1ae5104095477fbbb4d21`
- Packed inventory: 35 files
- Pinned Release A TUI source commit:
  `6a1014a608800b038e8efdf21445b03c161f1a9f`
- Pinned Release A `self-evolve-tui.tsx` SHA-256:
  `fd9ece6921ea6672b7f030d078c451062acfc0db51fec40038fb82d8041ed43e`
- OpenCode: `1.18.9`
- Exact TUI lane: `@opentui/core@0.4.5`,
  `@opentui/keymap@0.4.5`, `@opentui/solid@0.4.5`, and
  `solid-js@1.9.12`
- Evidence date: `2026-07-30`

The runner packs the working tree, installs the tarball in a disposable
consumer, validates the installed package graph, and copies the exact installed
candidate bytes outside `node_modules`. In the recorded baseline OpenCode then
loaded the copied `self-evolve-tui.tsx`; the current runner loads the copied
`self-evolve-tui.generated.js` export instead. Both forms preserve the
package's optional-peer policy while allowing OpenCode to supply its one shared
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
SELF_EVOLVE_RELEASE_B_OUTPUT=/tmp/self-evolve-release-b-evidence.json \
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
| 2 | 80x24 | Space-opened setup Settings; scrolled consent content; waiting/running state; pointer-opened failure Activity route; new-TUI/old-server fail-closed limited view with no enhanced authority. |
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
| 140x40 | `startup-sidebar` | `8080b33549d2e9aaf8dbe5bf68281e1e947f3656481b0a8455da031c742877bb` |
| 140x40 | `wide-home-pointer` | `0ef910afaa72c69bb1018c7f5b8df864f20ddcd3da8c0a5c32fa7eb9fdb5bd20` |
| 140x40 | `wide-recommendations` | `d854bfc91e629c9ea769110c05818fc9596f62745ea75a3642ba2bc12aa42fde` |
| 140x40 | `wide-activity` | `9f317bbb24b27b88c49652cd0f483ba2f4ac0cc16c20c715a2d6c3712dc06fd9` |
| 140x40 | `wide-settings` | `19e0da0dd1bd44bd76534e7de98af1bd663d54694353f71070cc0fa9c6849dab` |
| 140x40 | `wide-ready-sidebar` | `60fea5eeae124b3e1b53dda359dd53aad97244f8e8a8e2bc0541f5763c340077` |
| 140x40 | `wide-recommendation-enter` | `7d95baea3690a6a579af604da4f4704e0b40b48a034674e5b7cb47918ac47092` |
| 140x40 | `wide-recommendation-safety` | `6a5c7db971bc675a894b542b36e43c3cb1b35b9ff018d5f5d6faaa670fb8db10` |
| 140x40 | `wide-recommendation-token` | `7fe18c9755f6c2aa43f08ba50e7e7ef1354a007483243d7d386d8815a4435319` |
| 140x40 | `wide-recommendation-scrolled` | `7498a17d7fcf0d5ec2697c81d0d42ffade221a52533f4beb7e7b3956a3b12cb4` |
| 140x40 | `wide-applied-palette` | `de8542bdce67026c5804b7da928ea0276bf8fd57f8b6495364a6c23751c834e2` |
| 80x24 | `startup-sidebar` | `acf772d5ba995621f8cf59ccafd60356d81c3745c79e3363001d81400f3065cf` |
| 80x24 | `medium-setup-space` | `94d115b3f330cca7bf7f518ba7aa64596775da51789163267c881ace3421e8e7` |
| 80x24 | `medium-setup-consent` | `8de6b852014005825453e9fe7c8f48b7fee86664711323873638219a640ae751` |
| 80x24 | `medium-waiting` | `9f307ead5033fb5b2ab52d6c8bb695e580e96aae983797448c1cc129608a251a` |
| 80x24 | `medium-failure` | `6f6889cd491338185ad3d068245229a114ee5297999fb8d4e4e0ee6bdce23bc8` |
| 80x24 | `medium-new-tui-old-server` | `c570778a7e79e014e6dec446098e8a640afe9fd99e96741bb2955bfce00a7496` |
| 64x20 | `startup-sidebar` | `c1f1b9c6309f09ef5222fd3a070ba6a79dd99c9eb848bd10cbbc9319d980af36` |
| 64x20 | `narrow-home` | `3b4bbd9a253dac38e64ccadd03a5a3e496f2029acbd7c32079dde676974c210c` |
| 64x20 | `narrow-settings` | `f1f7e7a75c5c21fd5503c13ac1f38ddb4a80c8f0547a57554294206f1092c8ad` |
| 140x40 | `legacy-startup-sidebar` | `86d970edec27ba795b942c0df87b79b72c222dd865f34f5af0eb9b51143547ed` |
| 140x40 | `legacy-new-server-sidebar` | `b432db79bb1a11b0c68f40b6e6f63f66d305c55d80c6939df5023969fc840b0c` |
| 140x40 | `legacy-new-server-control-center` | `4c6f503571f678b8f77180a72187e23b01307dd02b63726432dd45d4724f09e1` |

## Remaining acceptance boundary

This is an automated local operator witness authored and run by the
implementer. It is strong exact-host evidence, but it is not independent human
review. The final Release B Beads gate and its parent epic must remain open
unless an independent reviewer supplies the required acceptance evidence or
the owner explicitly waives that independence requirement. No commit, push,
tag, registry publication, or release was performed.
