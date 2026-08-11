# v0.3 Automated Operator Evidence

This record covers the opt-in automated local operator witness for the
unpublished v0.3 global-first working-tree candidate. It does not claim
independent human review and does not authorize publication.

The earlier `docs/release-b-operator-evidence.md` remains the historical
Release B record; the run below supersedes it for the v0.3 cutover.

## Candidate and host

- Candidate: `@mcrescenzo/opencode-self-evolve@0.3.0`
- Packed artifact SHA-256:
  `34a8971f64b9aa616c9de2a87f9e8a8966c8e66ee94dbdaa14fb902c0639c94b`
- Packed inventory SHA-256:
  `626cbb2b37d846355fa6d2e5b3fa0cdb7437c040eaa940e9880d5894bff2d299`
- Packed inventory: 36 files
- Pinned Release A TUI source commit:
  `6a1014a608800b038e8efdf21445b03c161f1a9f`
- OpenCode: `1.18.15`
- Durable state generation: `0.3.0`; bridge wire contract: `0.2.1`
- Receipt schema: `1`; status: `passed`; production TUI entry exercised: yes

## How to reproduce

```bash
SELF_EVOLVE_RELEASE_B_OPERATOR_EVIDENCE=1 \
SELF_EVOLVE_RELEASE_B_OPENCODE_BIN=/absolute/path/to/opencode \
npm run operator:evidence
```

The witness packs the working tree, installs the tarball into an isolated
consumer, launches the real OpenCode binary against a scratch state root, and
drives the packed production `./tui` target through four viewport stages.

## What the v0.3 run proves

- No ambient UI before activation; the packed production TUI target activates
  from the installed file path, not a source or bridge injection.
- The four-section control center (Home, Recommendations, Activity, Settings)
  renders, deep-links from the sidebar by pointer and keyboard, and restores the
  exact prior route on Escape.
- Home reports the global readiness card. With only a project projection
  published, the sidebar reports **Limited global view** and global actions stay
  read-only — the intended v0.3 behavior when the global surface is unaligned or
  absent.
- Settings shows **Approved global skill folders** with one canonical folder per
  row, and the long-folder row is rendered only in Settings.
- Setup, waiting, failure, applied, and limited (`dashboard`-absent) states each
  render their exact copy and destinations.
- The narrow viewport stage renders without horizontal overflow.

## Known limitations

- Automated local operator witness only: `independentHumanReview: false` and
  `publicationOrRelease: false`.
- The witness publishes a project projection and no global projection, so the
  cross-project Global Recommendation Index, mailbox, Apply, Reject, and Undo
  paths are proven by the deterministic global bridge, global domain, and
  multi-process suites rather than by this UI witness.
- Frame hashes are viewport- and host-version-specific and change with any
  intentional copy or layout change.
