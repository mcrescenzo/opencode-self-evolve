# Self-Evolve Autonomy Contract (Normative)

**Status:** Normative. Supersedes conflicting text in `docs/autonomous-evolution-plan.md`.
**Locked scope:** `@mcrescenzo/opencode-self-evolve` v0.2.x.
**Verified runtime basis:** OpenCode host 1.18.3 + `@opencode-ai/plugin` 1.18.3 (see `self-evolve-0so.1` closeout notes).

**Implementation status:** The v0.2 runtime implements this contract. Automated
tests cover native TUI API behavior with mocks; the no-token OpenCode smoke proves
target loading and durable server behavior but does not claim live native dialog rendering.

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
| Apply a skill change                             | **Never** (advisory only)         | Explicit per-change TUI or deterministic headless approval | Automatically, **only** in allowlisted scopes |
| Apply in non-allowlisted scope                   | n/a                               | Downgrade to pending proposal         | Downgrade to pending proposal                     |
| Headless apply                                   | n/a                               | Explicit deterministic one-use approval command only | Permitted in explicit allowlist after release gates pass |

`manual` is the fail-closed default for missing, corrupt, unsupported, or
newer-than-known state.

### 1.2 Authority matrix

| Action                                            | `manual` | `auto` | `yolo` | Implementer            |
|---------------------------------------------------|----------|--------|--------|------------------------|
| Read session messages via SDK                      | ✓        | ✓      | ✓      | Server plugin          |
| Write structured observation to state root         | invoke  | ✓      | ✓      | Server plugin          |
| Spawn hidden deny-all-tools analyzer session       | invoke  | ✓      | ✓      | Server plugin          |
| `client.tui.showToast` (toast)                     | ✓        | ✓      | ✓      | Server plugin          |
| Optional supported TUI refresh event               | ✓        | ✓      | ✓      | Server plugin          |
| `api.ui.DialogConfirm` / `DialogSelect` (consent)  | -        | ✓      | ✓      | TUI plugin             |
| `api.attention.notify` (system notification)       | -        | ✓      | ✓      | TUI plugin             |
| Read+write OpenCode skill files in allowlist       | -        | approved | ✓    | Server applier only    |
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
6. **Durable global default mode** (stored under the shared canonical state-root policy: explicit option, synchronous official host path, bounded official path SDK, then environment only when official APIs are absent).
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
- Dedup: idle events carry no monotonic seq/timestamp. Dedup per ephemeral host
  session ID with an in-process debounce + durable lease; never trust a single
  idle event to start work twice for the same session. Durable cursors identify
  that session only by a domain-separated SHA-256 lineage hash.
- Message cursor: persist the domain-separated SHA-256 of the last observed host
  message ID. If no host ID is available, hash the complete bounded legacy
  message shape as a deterministic fallback. On each scan, locate that hash in
  the current 120-message window and inspect only the suffix after its last
  occurrence. If the prior hash is absent, audit a cursor gap and advance to the
  current end without creating receipts or observations from unknown overlap.
  A transient empty host window preserves the established cursor and creates no
  evidence, so a later window must still prove ancestry or fail through the gap rule.
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
- Incident identity and session lineage are separate. Every new observation
  stores the domain-separated SHA-256 session-lineage hash, and the distinct-
  session gate counts each lineage once even when that session contains several
  incidents. Missing legacy lineage maps to one fixed unknown lineage and cannot
  manufacture independent-session evidence.

### 2.4 Synthesize

- Hidden primary analyzer session, mode `primary`, `hidden: true`, `steps: 1`,
  `temperature: 0`, **deny-all tools**, strict structured-output schema,
  bound to current skill content hash.
- Synthesizer is the **only** model call in the pipeline (other than the
  optional critic). No model call in observe/persist/correlate/validate/apply.
- Before that provider call, the store must accept one strict
  `synthesis-attempt` record containing only `outcomeId`, `proposalId`, project
  and cluster fingerprints, target hash, `admittedAt`, and state `admitted`.
  Admission failure prevents the provider call. Prompts and model content are
  never part of this record.

### 2.5 Validate

Two independent gates, both mandatory:

1. **Deterministic validation**: schema, scope, allowlist, content-hash,
   growth budget, symlink/path containment, secret-canary scan, prompt-injection
   classifier output, size limits.
2. **Critic review**: second hidden deny-all-tools pass that scores the proposal
   against the evidence. A pre-critic proposal is `critic-pending`, is absent
   from inbox/command/TUI approval surfaces, and cannot be approved or applied.
   Only the critic may move it to `pending`; failure or low score moves it to
   `failed-closed`.

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
  equivalent deterministic headless command bound to the proposal ID, current
  target hash, proposed-content hash, exact decision version, and a server-issued
  one-use nonce. The command invokes server integration directly; it does not
  use the TUI mailbox.
- The canonical headless grammar is:

  ```text
  /self-evolve approve <proposal-id> --target-hash <sha256> --proposed-content-hash <sha256> --decision-version <integer> --nonce <one-use-nonce>
  ```

  Values come from the current durable inbox entry and are revalidated rather
  than trusted.
- Headless `auto` may apply only after that complete approval tuple validates
  and the nonce is atomically burned by decision CAS. Missing, stale, replayed,
  or mismatched fields fail closed. A bare proposal ID is not approval.

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
- Yolo release calibration is derived exclusively from retained, validated
  `synthesis-outcome` audit records in the current project partition. One
  production provider synthesis attempt has one stable outcome ID and exactly
  one terminal status: `accepted`, `no-change`, `critic-rejected`, or `failed`.
  `accepted` means deterministic validation and critic review both passed and
  the complete proposal content was durably persisted for recovery; valid
  `no-change` also counts as success. Missing, corrupt, or partially persisted
  proposal content is `failed`, never `accepted`. The other two statuses count
  as failure. Both the configured minimum count and success rate must pass.
  Duplicate, malformed, unknown, or cross-project records and all diagnostic
  audit names are ignored without increasing authority. Injected counters are
  never production authority.
- Ordinary boot recovers admitted attempts before retention or autonomous
  scheduling. An admission without a valid outcome becomes `accepted` only
  when its bound proposal is critic-passed and its complete typed content
  reconstructs to the proposed-content hash. Every other draft/pending residue
  becomes `failed-closed`, its content is compacted, and one failed outcome is
  written. Repeating recovery writes no second outcome and makes no provider
  call. Only active/incomplete proposals suppress another synthesis for a
  cluster; terminal proposals do not permanently suppress retry.

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
- **New file**: `skillTarget.currentHash` is either a lowercase SHA-256 hash or the exact `must-not-exist` sentinel. The complete same-directory temporary file is validated first, then published create-exclusively by atomically hard-linking it to the absent target and unlinking the temporary name. There is no empty target reservation.
- **Path containment**: every resolved path must be a real-path child of an
  allowlisted root. Symlinks **reject** (do not follow) anywhere in the path.
- **Atomic write**: existing files use a same-directory `0600` temp file plus
  `fs.rename`. New files use same-directory `fs.link` publication so an existing
  target wins and readers observe either absence or complete content. A platform
  or filesystem without atomic hard-link support fails closed; there is no
  non-exclusive rename fallback.
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

- Both targets resolve the same durable state root. The server owns durable
  records; the TUI reads records and uses only the mailbox below for writes.
- State-root precedence is explicit validated `stateRoot`, synchronous official
  host state, official `client.path.get()`, then XDG/HOME reconstruction only
  when official APIs are absent. A 1.18.3 server environment root may be used
  provisionally for read-only hook selection, but store boot and all authority
  wait for bounded post-start SDK equality. Timeout, unavailability, or mismatch
  suspends the runtime and requires explicit configuration plus restart; roots
  are never merged or migrated automatically.
- The server projection binds a SHA-256 canonical-root identity. The TUI checks
  it before inbox or control reads and fails closed on disagreement.
- Both targets call the same project-identity resolver with an explicit
  fingerprint, the same plugin `remoteUrl`, and their supported OpenCode
  worktree path (`ctx.worktree` server; `api.state.path.worktree` TUI), with a
  deterministic directory fallback. OpenCode 1.18.3 exposes no supported
  remote URL to the TUI, so plugin options are the supported remote input.
- Server plugin is the **sole writer** of observation/proposal/audit records.
- TUI plugin is **read-only** with respect to global settings and every project
  record. It must not append decisions, proposals, audits, or skill content.
- Cross-process decisions use a filesystem request/response mailbox at
  `<state-root>/self-evolve/bridge/<projectFingerprint>/`, with `requests/` and
  `responses/` children. There is no arbitrary client extension, undocumented
  `api.client.selfEvolve`, or server-exposed OpenCode tool.
- A TUI request is a create-exclusive `0600` JSON envelope containing only the
  schema version, request ID, project fingerprint, proposal ID, current target
  hash, proposed-content hash, expected decision version and prior state,
  requested state, actor, creation time, and server-issued one-use nonce.
  Unknown fields or an invalid binding reject the whole request. The TUI may
  write no other file under the state root.
- Durable controls use a separate `control-requests/` and `control-responses/`
  namespace, not decision fields. The TUI reads a strict server-authored
  `control-state.json` projection and may request only: global manual/auto/yolo
  mode, one of four consent toggles, repository exclusion, or canonical
  allowlist replacement. Every envelope binds the project, actor, timestamp,
  request ID, global `updatedAt`, full global/repository settings hash, exact
  action payload, and a server-issued one-use nonce. Unknown fields/actions,
  stale settings, replay, and cross-project requests fail closed. Yolo requires
  a non-empty exact allowlist and two native confirmations; allowlist changes
  require elevated confirmation. Cross-repository consent requires excerpts.
- The server consumes requests under a project mailbox lease, re-reads global
  and repository settings, validates the complete binding, and performs the
  decision transition through the store-owned decision transaction. The store
  writes a restrictive, hash-bound intent under the existing project mutation
  lock, then idempotently commits the exact next proposal and decision records.
  It alone writes the decision, proposal,
  audit, skill mutation, and a bounded `0600` response keyed by request ID.
  Request replay or duplicate consumers produce at most one transition/apply.
- Decision protocol: `(proposalID, targetHash, proposedContentHash,
  decisionVersion, actor, timestamp, nonce, priorState, newState)` with
  compare-and-swap on `priorState`. The intent binds the prior proposal envelope
  ID and exact next proposal/decision envelopes. Startup completes either missing
  side; malformed, newer, or conflicting intents are quarantined and fail boot
  closed. A decision record is one-use (nonce is burned by the transaction).

### 5.3 Notification flow

- Server detects eligible proposal -> writes pending review record -> may
  publish a supported refresh event when that capability is available.
- TUI polls the durable inbox and mailbox responses at safe idle boundaries;
  refresh events are optional latency hints, never the consistency mechanism.
- TUI renders `api.ui.DialogConfirm`/`DialogSelect` at safe idle boundary.
- TUI writes one authenticated, hash-bound request envelope; the server writes
  the bounded response. The TUI never mutates a decision record directly.
- Headless: the durable inbox holds pending proposals. The deterministic
  approval command invokes server integration directly with the complete
  one-use approval tuple; it does not emulate a TUI request.
- Neither path injects a prompt or message into a working session.
- The native palette/slash command is `self-evolve.settings` /
  `/self-evolve-settings`; it uses supported keymap registration and native
  select/confirm/prompt dialogs. Excerpt and cross-repository dialogs state that
  redaction is not a secrecy guarantee.

## 6. Repository identity

- Identity is isolation-first and per checkout/worktree. Compute
  `projectFingerprint = SHA-256(UTF8(canonical JSON tuple))`, where the tuple is
  `['self-evolve-project-v1', sourceKind, canonicalSource,
  canonicalAbsoluteWorktreePath]`. `sourceKind` is `remote` when a canonical
  remote is available and `root` otherwise; `canonicalSource` is that remote or
  the canonical absolute repository root. Canonical filesystem values use
  resolved absolute paths and a stable platform-normalized representation.
- The absolute worktree path is always present, including when a remote exists.
  Separate clones and linked worktrees therefore always receive separate
  partitions. Relocating a repository or worktree creates a new partition; the
  plugin does not silently merge or migrate the old partition.
- An explicit fingerprint must be a lowercase SHA-256 value and must match the
  identity derived from any supplied remote/worktree inputs. Invalid or
  conflicting identity inputs fail closed before project state or mailbox use.
- A monorepo checkout has one project fingerprint. Subprojects are explicit
  scope fingerprints inside that partition, not separate projects.
- Cross-project aggregation in §7 is the only bridge between project
  partitions.

## 7. Privacy classes

| Class                          | Stored?                                                                |
|--------------------------------|------------------------------------------------------------------------|
| Complete transcripts           | **Never**                                                              |
| Raw message bodies             | **Never**                                                              |
| Raw host session/message IDs   | **Never** (domain-separated SHA-256 lineage/cursor hashes only)        |
| Deterministic receipts         | Always (hashed command signature, tool-error code, etc.)              |
| Structured observations        | Always (no raw text; only typed fields and receipt IDs)                |
| Sanitized evidence excerpts    | Only with **separate explicit consent**; short TTL; bounded length     |
| Skill content hash             | Always (current and proposed)                                          |
| Skill content diff             | Only when a proposal exists; replaced by hash once proposal is closed  |
| Audit records                  | Always (mode, target, hashes, actor, timestamp, nonce)                 |
| Cross-project aggregate claims | Only with both excerpt and cross-repository consent; disabled by default |

Redaction is **not** a secrecy guarantee. The plugin must disclose this in
`SECURITY.md` and the README.

### 7.1 Cross-project global-skill aggregation

- Aggregation is disabled by default and runs only while both
  `sanitizedExcerpts` and `crossRepoAggregation` consent are true. Revoking
  either consent stops new contributions immediately; it does not itself erase
  records, so the user can separately export or purge them.
- The only global aggregate file is
  `<state-root>/self-evolve/global/aggregates.jsonl`. Each line must validate
  against an exact, versioned allowlist schema with no unknown fields:
  `schemaVersion`, `aggregateId`, `claimType`, `receiptType`, `signatureHash`,
  `incidentHash`, `occurrenceCount`, `firstSeenDay`, `lastSeenDay`, `createdAt`,
  and `expiresAt`. `claimType` and `receiptType` are finite local enums; hashes
  are SHA-256 values; counts and coarse UTC-day values are bounded primitives.
- No path, project/repository/customer name or identifier, command or command
  fragment, raw or sanitized text, model prose, or skill content may enter the
  global file. Provenance is only a non-reversible, domain-separated incident
  hash. A per-project contribution index may map aggregate IDs to the local
  project solely so project purge can remove its contributions; that index
  stays inside the project partition and is never aggregated.
- Aggregation and compaction run under the global store mutation lock. A
  project purge removes that partition's indexed aggregate contributions and
  compacts the global file before deleting the local index. Purge-all removes
  global settings, aggregates, bridge mailboxes, and every project partition.
- Aggregate claims expire after 30 days by default, independently configurable
  from project retention. Expired claims cannot contribute to eligibility.

## 8. Retention

| Data class | Default TTL |
|---|---:|
| Project observations, receipts, episode cursors, evidence clusters, and eligibility records | 30 days |
| Proposals, decisions, audit records, rollback/intervention/circuit records, and rollback snapshots | 90 days |
| Bridge requests and responses | 24 hours |
| Global aggregate claims | 30 days |

- `retentionDays` configures the observation/evidence window and the default
  aggregate `expiresAt` assigned when a claim is created; the proposal/audit
  window is three times that value. Existing aggregate claims always expire by
  their stored `expiresAt` and are not rewritten by later settings changes. The
  bridge TTL is a fixed safety bound. Retention sweep runs at process startup and once per day
  while the process lives. Mailbox polling may remove already-expired bridge
  files sooner.
- Record age uses the class's canonical event timestamp (for example,
  observation `createdAt`, receipt/cluster `lastSeenAt`, proposal
  `synthesizedAt`, decision/audit `timestamp`, rollback `rolledBackAt`, and
  intervention `startedAt`). Invalid records are quarantined by normal bounded
  store validation rather than treated as safely deletable.
- Terminal `synthesis-outcome` records are audit records and use the same
  three-times-`retentionDays` window. Expiration may reduce rollout history and
  block yolo again; outcomes do not receive active-proposal protection because
  they are independently complete, while the linked active proposal chain
  remains protected by the rule below.
- The latest `critic-pending`, `pending`, `approved`, or `applied` proposal and its linked
  decision/audit chain are retained until it reaches a terminal state; this is
  the conservative exception that prevents a review or rollback option from
  disappearing solely because it aged past the nominal window. A snapshot
  required by an applied proposal is retained with that chain. Unlinked
  snapshots receive the same 90-day grace window so a sweep cannot race the
  short interval between snapshot creation and durable audit linkage.
- Proposal bodies are strict `proposal-content` records in `proposals.jsonl`.
  Every chunk carries the proposal ID, proposed-content hash, encoding,
  zero-based chunk index, exact chunk count, and bounded base64 bytes. Readers
  reject cross-proposal, mixed-hash, duplicate-index, incomplete, non-canonical,
  or decoded-hash-mismatched sets. Legacy free-form content audits are converted
  only when the complete set validates and are then removed.
- Rejected, failed-closed, superseded, and rolled-back transitions delete every
  linked content chunk immediately under the store mutation lock. The
  recoverable decision intent includes this compaction step, so a crash after
  the state/decision append is completed by boot or an ordinary read before
  inbox/export exposure. Retry is idempotent. Proposal purge also removes all
  chunks for removed proposal records; terminal and purged proposals retain
  only hashes and bounded audit metadata.
- Aggregate compaction repairs every project contribution index. Empty indexes,
  expired lease files, expired or orphaned snapshots after their grace window,
  and stale bridge artifacts are removed without following symlinks. A bridge
  consumer lock is recoverable only after expiry when its owner process is no
  longer live; crossing a wall-clock TTL never steals a live owner's lock.
- Purge operations:
  - `/self-evolve purge observations` — all observation records for this project.
  - `/self-evolve purge proposals` — all critic-pending and pending proposal
    versions and their content chunks (closed records retained for audit).
  - `/self-evolve purge project` — all records, rollback snapshots, bridge
    files, local aggregation index, and indexed global aggregate contributions
    for this project fingerprint. Global settings remain.
  - `/self-evolve purge --all` — entire `self-evolve/` state subtree, including
    global settings, global aggregates, all project partitions, and bridge data.
- Export operations produce a JSON archive of the same scope.
- `export all` is state-root-wide rather than an alias for the current project. Its bounded JSON schema contains global settings and aggregate claims, every project partition with settings/records/indexes, decision requests/responses, control requests/responses, the current control-state projection, active proposal-content chunks, and rollback snapshots required for restoration. Every bridge class carries an explicit sensitive-metadata classification and per-file byte count; decision/control requests and control state are limited to 8 KiB, responses to 4 KiB. Strict envelope, filename, and project binding validation rejects unrelated fields. Snapshot bodies are Base64 and explicitly classified `sensitive-skill-snapshot`; the archive is sensitive. Terminal/purged proposal content, locks, temporary files, raw quarantine corruption, unrelated OpenCode state, transcripts, and raw messages are excluded; symlinks, hard links, or file replacement in the exported subtree fail closed.
- Purge-all is terminal for the current store/integration instance. Before returning it stops scheduler, mailbox, and retention timers; subsequent commands/events return `restart-required-after-purge-all`; shutdown must not recreate state. Only a fresh OpenCode process may initialize the subtree again. Project purge remains non-terminal and reinitializes only that project.

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

The storage budget is one total cap for each project-associated partition, including repository settings, all record files, indexes, snapshots, leases, quarantine artifacts, and bridge files. Current usage and pending replacement bytes are evaluated while the shared cross-process mutation lock is held, without following symlinks. TUI decision and control publishers share at most 64 pending request files and a conservative mailbox sub-budget of the smaller of 512 KiB or one eighth of the project quota; pending requests reserve their maximum 4 KiB response and admission also reserves one absent control-state projection. Growing request publications preserve up to 64 KiB (or one eighth of a smaller quota) for later store mutations. A bounded mandatory settings audit envelope of at most 4 KiB may cross an already exhausted cap so a safety control outcome remains durable; ordinary records and recursive failure audits receive no bypass.

Quiet hours use local wall-clock time and the canonical shape
`{ "from": "22:00", "to": "07:00" }`. Equal endpoints disable that period;
an overnight range wraps across midnight.

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
- **Concurrent processes** -> process-aware per-target lease + create-exclusive
  files; a live-owner recovery contender defers without a failure audit or
  state transition, while a dead owner is reclaimed under the mutation lock.
- **Restart mid-decision** -> startup recovers the restrictive transaction intent
  before exposing proposal authority, whether neither record, only the proposal,
  or only the decision reached disk. Repeated recovery adds no duplicate record.
- **Restart mid-apply** -> startup first resolves apply audit/readback. A verified
  published file completes the proposal's `applied` transaction without applying
  again. An absent unpublished new target removes only a hash-proven plugin temp;
  an unrelated collision is never removed. Unverified or failed application
  becomes a visible critical `failed-closed` record with no Apply action.
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
  - routes `/self-evolve` through the durable manual pipeline and inbox while
    retaining the v0.1 session-local command behavior only behind explicit
    compatibility mode.
- Ordinary string package registration enters this durable path. Legacy v0.1
  session-local behavior is available only through the documented explicit
  `durableAutonomy: false` compatibility option. Startup `mode` is not durable
  authority and does not override an existing preference; commands own later
  mode changes, and restart reshapes passive hooks from persisted effective mode.
- The `package.json` `engines` field requires `@opencode-ai/plugin@^1.18.3`.
  After the factory returns, production startup derives the running OpenCode
  version from bounded official health: `client.global.health()` when present,
  otherwise exact-origin GET `/global/health` from `PluginInput.serverUrl`.
  Only healthy stable versions `>=1.18.3 <2.0.0` proceed. Unavailable,
  malformed, prerelease, older, and 2.x hosts receive deterministic manual
  diagnostics and refuse autonomous work. A persisted-auto/yolo provisional
  hook has no integration while validation is pending and remains inert on
  failure. Configuration can narrow but cannot widen this authority.

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
- **Cross-process store remediation (.19)**: real child processes prove global
  settings convergence, versioned checkout/worktree identity, mutation locks,
  append/CAS idempotency, and project aggregate-index purge.
- **Retention remediation (.20)**: clock-controlled startup/daily sweeps cover
  observations, proposals, decisions, audits, rollback snapshots, bridge
  envelopes, aggregate claims, and rebuildable indexes under concurrent access.
- **Yolo rollout remediation (.21)**: persisted, deduplicated synthesis outcomes
  alone advance release gates; injected test metrics cannot grant authority.
- **TUI bridge remediation (.22)**: separate fresh processes exercise mailbox
  request/response, stale/replay rejection, at-most-once decision/apply, idle
  polling, optional refresh, restart recovery, and 24-hour cleanup without an
  injected bridge object or undocumented client extension.
- **Release reconciliation (.23)**: command syntax implements the complete auto
  headless approval tuple; docs/config examples and packed fresh-consumer/live
  no-token smoke match this contract.

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
| Global settings, checkout identity, cross-process mutation safety     | .19                                         |
| Retention for every durable class                                     | .20                                         |
| Persisted yolo release-gate evidence                                  | .21                                         |
| Supported filesystem server/TUI bridge                                | .22                                         |
| Remediated commands, docs, package, and live smoke                     | .23                                         |

## 15. Historical bead-split review

This section records the earlier `.2` closeout review. It is historical, not a
current claim that no remediation is needed. The exhaustive review that created
`.18` through `.23` supersedes its final conclusion.

That earlier closeout reviewed `.3`, `.5`, `.8`, `.15` for executable-in-one-pass:

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

At that time no additional splits were identified. The completed remediation
was governed by beads `.19` through `.23`; final product verification remains `.17`.
