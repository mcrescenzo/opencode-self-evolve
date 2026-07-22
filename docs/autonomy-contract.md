# Self-Evolve Autonomy Contract (Normative)

**Status:** Normative. Supersedes conflicting text in `docs/autonomous-evolution-plan.md`.
**Locked scope:** `@mcrescenzo/opencode-self-evolve` v0.2.x.
**Verified runtime basis:** OpenCode host 1.18.3 + `@opencode-ai/plugin` 1.18.3 (see `self-evolve-0so.1` closeout notes).

---

## 0. Authority of this document

This document is the single source of truth for product, authority, privacy,
lifecycle, migration, and failure semantics for the autonomy pipeline. Where
`docs/autonomous-evolution-plan.md` conflicts with this document, **this document
wins**. Specifically, the plan's

- "permanent no-auto-apply boundary",
- four rollout modes (`manual`/`shadow`/`review`/`advisory`),
- "manual mode performs no passive model calls or durable observation writes",

are **superseded** by the manual/auto/yolo contract below. The plan remains a
useful evidence-architecture reference; nothing in it is normative for v0.2.

## 1. Three user-visible modes

Exactly three user-visible modes exist: **`manual`**, **`auto`**, **`yolo`**.
Internal gates (dedup, eligibility, validation, critic) are not user-visible
modes.

All three modes share one pipeline:

```
observe -> persist -> correlate -> synthesize -> validate -> notify | apply
```

All three modes share identical evidence thresholds. `manual` does not lower
quality gates.

### 1.1 Mode behavior matrix

| Stage / responsibility                          | `manual`                          | `auto`                                | `yolo`                                            |
|-------------------------------------------------|-----------------------------------|---------------------------------------|---------------------------------------------------|
| Passive provider calls                          | **Never**                         | Yes, at idle boundaries               | Yes, at idle boundaries                           |
| Durable structured observations                 | Only when `/self-evolve` invoked  | Automatic at idle boundaries          | Automatic at idle boundaries                      |
| Correlation + eligibility                       | On invocation                     | Automatic                             | Automatic                                         |
| Synthesis + deterministic validation + critic   | On invocation                     | Automatic                             | Automatic                                         |
| Notify on eligible proposal                      | Toast on invocation               | Native TUI dialog at safe idle        | Native TUI dialog at safe idle                    |
| Apply a skill change                             | **Never** (advisory only)         | Only after explicit per-change TUI approval | Automatically, **only** in allowlisted scopes |
| Apply in non-allowlisted scope                   | n/a                               | Downgrade to pending proposal         | Downgrade to pending proposal                     |
| Headless apply                                   | n/a                               | Not permitted; durable inbox fallback | Permitted in explicit allowlist after release gates pass |

`manual` is the fail-closed default for missing, corrupt, unsupported, or
newer-than-known state.

### 1.2 Authority matrix

| Action                                            | `manual` | `auto` | `yolo` | Implementer            |
|---------------------------------------------------|----------|--------|--------|------------------------|
| Read session messages via SDK                      | ✓        | ✓      | ✓      | Server plugin          |
| Write structured observation to state root         | invoke  | ✓      | ✓      | Server plugin          |
| Spawn hidden deny-all-tools analyzer session       | invoke  | ✓      | ✓      | Server plugin          |
| `client.tui.showToast` (toast)                     | ✓        | ✓      | ✓      | Server plugin          |
| `client.tui.publish` (TUI inbox refresh)           | ✓        | ✓      | ✓      | Server plugin          |
| `api.ui.DialogConfirm` / `DialogSelect` (consent)  | -        | ✓      | ✓      | TUI plugin             |
| `api.attention.notify` (system notification)       | -        | ✓      | ✓      | TUI plugin             |
| Read+write OpenCode skill files in allowlist       | -        | -      | ✓      | Server applier only    |
| Read+write OpenCode skill files outside allowlist  | -        | -      | -      | Never                  |
| Spawn implementation/shell/Git agent               | -        | -      | -      | Never                  |
| `client.session.promptAsync` / `client.tui.appendPrompt` | -  | -      | -      | **Prohibited**         |
| Push, publish, external-tracker mutation           | -        | -      | -      | Never                  |

### 1.3 Override precedence (highest to lowest)

1. **Runtime kill switch** (`SELF_EVOLVE_KILL` env var, process-local; also a
   runtime toggle able to force-downgrade yolo application without rewriting
   the stored user preference).
2. **Emergency pause / circuit breaker** (per-process and durable global).
3. **Per-process exclusion** (repository excluded explicitly via command or config).
4. **Repository opt-out** (`.opencode/self-evolve.json` or matching config).
5. **Repository opt-in / override** (per-repo mode override).
6. **Durable global default mode** (stored under `client.path.state`).
7. **Package default** (`manual`).

Pause/circuit-break and exclusions always override the durable mode. Manual is
the fail-closed default whenever resolution is ambiguous, the on-disk state is
corrupt, or the host version is unsupported.

## 2. Pipeline stages (shared)

### 2.1 Observe

- Source: `EventSessionStatus.idle` or `EventSessionIdle` (both treated as live;
  the prior "session.idle is deprecated" characterization is **refuted** by
  `self-evolve-0so.1`).
- Handler: server plugin `Hooks.event`. **Must not block**: the handler records
  the episode ID + epoch and returns immediately. All real work happens in a
  scheduled task that re-enters at a stable idle boundary.
- Dedup: idle events carry no monotonic seq/timestamp. Dedup per sessionID with
  an in-process debounce + durable lease; never trust a single idle event to
  start work twice for the same session.
- Receipt extraction: deterministic patterns only (commands repeated,
  identical tool errors, manual procedure re-issued, etc.). No model call in
  the observe stage.

### 2.2 Persist

- Store: append-only JSONL records under `<state-root>/self-evolve/<project-fingerprint>/`
  with sibling lock and lease files.
- Records are immutable; corrections are new records that supersede by ID.
- Atomic write = temp-file + `fs.rename`. Create-exclusive lease files (`O_EXCL`).
- `manual` writes only when `/self-evolve` is invoked. `auto`/`yolo` write at
  idle boundaries subject to consent.

### 2.3 Correlate

- Independent incidents are correlated by deterministic receipt type + scope
  fingerprint + repository partition.
- One incident contributes at most once per eligibility window (`incident-id`
  nonce).

### 2.4 Synthesize

- Hidden primary analyzer session, mode `primary`, `hidden: true`, `steps: 1`,
  `temperature: 0`, **deny-all tools**, strict structured-output schema,
  bound to current skill content hash.
- Synthesizer is the **only** model call in the pipeline (other than the
  optional critic). No model call in observe/persist/correlate/validate/apply.

### 2.5 Validate

Two independent gates, both mandatory:

1. **Deterministic validation**: schema, scope, allowlist, content-hash,
   growth budget, symlink/path containment, secret-canary scan, prompt-injection
   classifier output, size limits.
2. **Critic review**: second hidden deny-all-tools pass that scores the proposal
   against the evidence. Failure or low score fails closed to a pending review
   item.

### 2.6 Notify / Apply

- **Notify**: native TUI dialog at safe idle boundary (`api.ui.DialogConfirm`
   or `api.ui.DialogSelect`); fall back to durable command-accessible inbox for
   headless operation. **Never** inject a turn into the working session, never
   call `client.session.promptAsync`, never call `client.tui.appendPrompt`,
   never add a synthetic proposal message to the task transcript, never invoke
   the working agent's question tool.
- **Apply**: see §4. Allowed only under explicit approval (auto) or allowlist
  + release gates (yolo).

## 3. Mode-specific contracts

### 3.1 `manual` (default)

- No passive provider calls. No passive durable writes.
- `/self-evolve` (or `/self-evolve scan`) processes unseen activity from the
  current session, writes bounded structured observations for that activity,
  correlates with prior durable evidence, and presents any newly eligible
  proposal.
- `/self-evolve status`, `/self-evolve pause`, `/self-evolve resume`,
  `/self-evolve exclude ...`, `/self-evolve inbox`, `/self-evolve export ...`,
  `/self-evolve purge ...` remain available for inspection/control.
- A `manual` proposal is advisory; `manual` never applies a skill change.

### 3.2 `auto`

- The full pipeline runs automatically at stable idle boundaries.
- Eligible proposals are drafted automatically.
- Applying a skill change requires **explicit per-change approval** in the
  native TUI dialog (`DialogConfirm` with the full proposal summary), or an
  equivalent deterministic headless command explicitly authorized for that
  proposal ID by nonce.
- Headless operation may **draft** proposals but may not **apply** them in
  `auto`. The durable inbox surfaces pending approvals on next TUI session.

### 3.3 `yolo`

- The full pipeline runs automatically.
- Validated changes may be applied **without per-change approval** only when:
  1. The target skill root is on the explicit canonical allowlist.
  2. Release gates pass (allowlist fresh, hash-bound, no kill switch active,
     no privacy/injection flag, audit record writeable).
  3. The applier successfully acquires the per-target lease.
- Unknown or unapproved scopes **downgrade** to a pending proposal in the
  review inbox (same as `auto`).
- Yolo may operate headlessly, but the **next TUI session must surface the
  audit result and a rollback option**. Rollback is allowed only while the
  current on-disk hash still equals the plugin-applied hash recorded in the
  audit record.
- A runtime kill switch can downgrade yolo application **without rewriting**
  the stored user preference. The downgrade is recorded as an audit event.

## 4. Skill applier contract

The applier is the **only** code path that writes to skill files. It must:

- **Scope**: OpenCode skills only (existing or new). No agents, shell commands,
  arbitrary file targets, Git commits, pushes, publication, external trackers,
  or remote-system mutation.
- **Canonical allowlist**: explicit list of canonical absolute skill roots,
  configured by the user. No globbing, no symlink expansion at config time.
- **Existing file edit**: exact approved content hash bound. Applier reads the
  file, computes the current hash, refuses if it does not equal the approved
  hash.
- **New file**: create-exclusive (`O_CREAT | O_EXCL`), content hash recorded.
- **Path containment**: every resolved path must be a real-path child of an
  allowlisted root. Symlinks **reject** (do not follow) anywhere in the path.
- **Atomic write**: temp file in same directory + `fs.rename`; temp file is
  `0600`, renamed atomically.
- **Readback validation**: after rename, re-read and re-hash; must equal the
  proposed content hash exactly.
- **Growth limit**: per-edit and per-file byte cap (default 8 KiB edit, 64 KiB
  file).
- **Audit record**: append-only JSONL with proposal ID, target, prior hash,
  applied hash, actor (always `self-evolve-applier`), timestamp, mode, lease
  nonce.
- **Rollback**: only while `currentHash == appliedHash` for that target. Rollback
  restores the prior content from the audit record's `prior-hash` snapshot,
  records a new audit event, and verifies readback.
- **Failure modes that fail closed** (no write, pending/critical review item):
  stale hash; ambiguous scope; symlink anywhere on path; privacy/injection flag;
  lease conflict; validation failure; budget exhaustion; rollback uncertainty;
  unsupported host; corrupt state; missing allowlist; secret-canary match;
  growth-limit exceeded; create-exclusive collision.

## 5. Server / TUI coordination

### 5.1 Module structure (dual-target)

One npm package exposes two target-only modules:

- **Server entry** (existing `self-evolve.js`): exports `default SelfEvolvePlugin`
  only. Imports only from `@opencode-ai/plugin` (the `.` target) and Node
  built-ins. **Must not statically import `./tui` or `@opencode-ai/plugin/tui`**
  — those peers are not installed in headless contexts.
- **TUI entry** (new, e.g. `self-evolve-tui.js` reached via `package.json`
  `exports["./tui"]`): imports from `@opencode-ai/plugin/tui`, `@opentui/solid`,
  and the package's own pure-ESM helpers. Default-exports a `TuiPlugin`.
- Both modules may import shared pure helpers (`self-evolve-core.js`,
  `self-evolve-schemas.js`, etc.) that themselves import nothing from either
  target.

### 5.2 State coordination

- Both targets read/write the same durable state under `client.path.state`.
- Server plugin is the **sole writer** of observation/proposal/audit records.
- TUI plugin is **read-only** with respect to the durable store; it writes
  decisions back via a server-exposed tool (`self-evolve.decide`) or, when
  unavailable, by appending decision records with a server-owned lease check
  on next boot.
- Decision protocol: `(proposalID, targetHash, proposedContentHash,
  decisionVersion, actor, timestamp, nonce, priorState, newState)` with
  compare-and-swap on `priorState`. A decision record is one-use (nonce is
  burned on apply).

### 5.3 Notification flow

- Server detects eligible proposal -> writes pending review record -> calls
  `client.tui.publish({ ... })` to refresh the TUI inbox.
- TUI subscribes via `api.event.on("...")` or polls the durable inbox on idle.
- TUI renders `api.ui.DialogConfirm`/`DialogSelect` at safe idle boundary.
- Decision is written back via `self-evolve.decide` tool (server-internal).
- Headless: durable inbox holds the pending decision; `self-evolve decide
  --nonce ... --accept` resolves it from a terminal.

## 6. Repository identity

- Canonical identity = `git remote get-url origin` (or local absolute path if
  no remote), SHA-256 hashed with the worktree absolute path. Produces a
  `projectFingerprint` stable across clones with the same remote and stable
  across renames within the same worktree path.
- Worktrees, clones, and monorepos:
  - **Worktree** of a repo: identified by the parent repo fingerprint + the
    worktree path. Partitioning is per worktree.
  - **Clone** of a repo: same remote -> same fingerprint. Cross-clone
    aggregation is **disabled** by default.
  - **Monorepo**: one fingerprint for the repo; subprojects are scopes within.
- Cross-repository aggregation for global-skill candidates requires **separate
  explicit consent** and produces only sanitized, normalized evidence without
  repository paths, project names, customer details, or unique commands.

## 7. Privacy classes

| Class                          | Stored?                                                                |
|--------------------------------|------------------------------------------------------------------------|
| Complete transcripts           | **Never**                                                              |
| Raw message bodies             | **Never**                                                              |
| Deterministic receipts         | Always (hashed command signature, tool-error code, etc.)              |
| Structured observations        | Always (no raw text; only typed fields and receipt IDs)                |
| Sanitized evidence excerpts    | Only with **separate explicit consent**; short TTL; bounded length     |
| Skill content hash             | Always (current and proposed)                                          |
| Skill content diff             | Only when a proposal exists; replaced by hash once proposal is closed  |
| Audit records                  | Always (mode, target, hashes, actor, timestamp, nonce)                 |
| Aggregate counters             | Always                                                                 |

Redaction is **not** a secrecy guarantee. The plugin must disclose this in
`SECURITY.md` and the README.

## 8. Retention

- Default retention window: **30 days** for observations, **90 days** for
  proposal/decision/audit records. Configurable.
- Retention sweep runs at process startup and once per day while the process
  lives.
- Purge operations:
  - `/self-evolve purge observations` — all observation records for this project.
  - `/self-evolve purge proposals` — all pending proposals (closed records
    retained for audit).
  - `/self-evolve purge project` — all records for this project fingerprint.
  - `/self-evolve purge --all` — entire `self-evolve/` state subtree.
- Export operations produce a JSON archive of the same scope.

## 9. Budgets and concurrency

| Budget             | Default                                                          |
|--------------------|------------------------------------------------------------------|
| Passive provider calls per process per hour     | 6                              |
| Synthesis runs per process per day              | 24                             |
| Tokens per synthesis (cap)                      | 8000                           |
| Concurrent observations per project             | 1                              |
| Concurrent syntheses globally                   | 1                              |
| Idle debounce (ms)                              | 1500                           |
| Storage quota per project (MiB)                 | 8                              |
| Notifications per process per hour              | 3                              |

Exceeding any budget fails closed (no write, no call). Budgets are
configurable; defaults are conservative.

## 10. Failure and downgrade behavior

- **Stale hash** -> fail closed; proposal becomes pending review.
- **Ambiguous scope** -> fail closed; pending review.
- **Lease conflict** -> back off with bounded jitter; do not write.
- **Validation failure** -> record failure reason on the proposal; do not
  retry within the same idle episode.
- **Budget exhaustion** -> record the attempt; suppress further attempts until
  budget resets.
- **Rollback uncertainty** -> leave the file unchanged; surface as critical
  review item.
- **Duplicate idle event** -> lease-guarded no-op.
- **Out-of-order event** -> stale-result rejection by epoch counter.
- **Concurrent processes** -> per-target lease + create-exclusive files; the
  loser records a lease-busy audit event and exits cleanly.
- **Restart mid-apply** -> next startup detects un-rewritten audit record with
  `applied` state but missing `readback-verified` -> re-reads and either
  completes the audit entry or rolls back to prior hash.
- **Downgrade during in-flight work**: if the mode is downgraded (yolo->auto,
  auto->manual) or the kill switch fires while a synthesis is running:
  - In-flight synthesis result is recorded but **never applied** if the new
    mode forbids application.
  - In-flight apply completes only if it has already acquired the lease and
    written the temp file; otherwise it aborts.
  - All downgrades append an audit event.
- **Corrupt state**: plugin refuses to start autonomous work; `/self-evolve
  status` reports the corruption; only `purge` commands are accepted until
  resolved.

## 11. Migration (v0.1.2 -> v0.2.x)

- v0.1.2 has no durable state, so migration is essentially configuration-only.
- On first start, v0.2.x:
  - creates `<state-root>/self-evolve/` with `0700` perms,
  - writes a `version.json` recording the schema version,
  - records the active host version,
  - defaults the mode to `manual`,
  - leaves the existing manual `/self-evolve` behavior unchanged.
- The `package.json` `engines` field is updated to require
  `@opencode-ai/plugin@^1.18.3`; legacy 1.17.7 hosts receive a clean
  startup message and refuse autonomous work (manual `/self-evolve` may still
  run if the existing manual pipeline is unaffected).

## 12. Permanent prohibitions

These cannot be relaxed by configuration, mode, or allowlist:

1. No spawning implementation, shell, or Git agents.
2. No Git commit, push, publication, or external-tracker mutation.
3. No `client.session.promptAsync` or `client.tui.appendPrompt`.
4. No injection of synthetic messages into the working session transcript.
5. No invocation of the working agent's question tool from the server plugin.
6. No persistence of complete transcripts or raw message bodies.
7. No path outside the canonical allowlist for the applier.
8. No model-authored scope, retention, budget, consent, or apply decisions.
9. No silently rewriting the user's stored mode preference when the kill
   switch fires.

## 13. Validation strategy

Per-bead validation:

- **Pure schemas (.3)**: `node --test` unit tests; no I/O.
- **Store (.4)**: temp-dir filesystem tests; atomic/rename/lease/lock
  correctness; corrupt-record quarantine.
- **Privacy (.5)**: redaction + retention + purge tests against fixtures;
  adversarial fixtures that attempt to leak path/project/customer data.
- **Observation (.6)**: offline corpus tests with synthetic transcripts;
  deterministic receipt extraction.
- **Inventory (.7)**: filesystem skill discovery + hash + path containment;
  symlink-rejection tests.
- **Synthesis (.8)**: mocked analyzer (no real tokens in unit tests); schema
  validation; binding to current hash; stale-hash rejection.
- **Applier (.9)**: temp-dir atomic write tests; symlink attack fixtures;
  create-exclusive collision tests; rollback pre/post conditions; secret-canary
  fixtures.
- **Commands (.10)**: command-execute dispatch tests; consent gate; headless
  inbox.
- **Scheduler (.12)**: duplicate idle dedup; lease contention; non-blocking
  handler contract (must return within bounded ms).
- **TUI (.13)**: pure render tests against TuiPluginApi shape; consent capture;
  readback of decision records.
- **Mode integration (.14)**: end-to-end auto/yolo authority tests with mocked
  analyzer and applier.
- **Hardening (.15)**: adversarial injection fixtures; concurrency storm;
  budget exhaustion; rollback failure.
- **Release (.16)**: `npm pack` -> tarball install -> dual-target import (per
  `self-evolve-0so.1` fixture pattern); README/CHANGELOG/SECURITY review;
  restart guidance.
- **Final (.17)**: full `npm test`, `npm run check`, `npm run pack:check`,
  mocked integration, and one disposable live OpenCode load smoke.

## 14. Mapping to epic success criteria

| Epic success criterion                                                | Bead(s)                                     |
|-----------------------------------------------------------------------|---------------------------------------------|
| Dual-target dual-target runtime contract proven                       | .1 ✓                                        |
| Normative architecture + threat model, no contradiction               | .2 (this document)                          |
| Manual / auto / yolo behavior                                         | .11, .12, .14                               |
| No complete transcripts; isolation; retention; export; purge          | .4, .5, .10                                 |
| Native review without injecting into working agent                    | .13                                         |
| Hash-bound / canonical / symlink-safe / atomic / audited applier      | .9                                          |
| Concurrency / restart / stale hash / injection / rollback fail-closed | .15                                         |
| Packed npm artifact with dual targets + minimum host                  | .16                                         |
| Docs, privacy disclosures, migration, restart behavior                | .16                                         |
| Final verification records passing checks                             | .17                                         |

## 15. Bead-split review (post-contract)

The contract closeout reviewed `.3`, `.5`, `.8`, `.15` for executable-in-one-pass:

- **.3 schemas**: single pass. Schemas + state machines for proposal/decision
  + mode + receipt. No split.
- **.5 privacy**: single pass. Redaction + retention + purge + cross-repo
  isolation. Independent of `.4` store mechanics; depends only on schemas.
  No split.
- **.8 synthesis**: single pass. Hidden analyzer wiring + structured output
  + current-hash binding + critic. The analyzer child-session plumbing is
  already present in v0.1.2; this bead extends it. No split.
- **.15 hardening**: single pass. Adversarial fixtures + concurrency +
  rollback-failure + budget-exhaustion. Independent of `.14`. No split.

No additional splits required. Existing bead granularity is appropriate.
