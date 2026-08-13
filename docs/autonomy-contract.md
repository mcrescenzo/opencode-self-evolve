# Self-Evolve v0.4 Binary-Automation Contract (Normative)

**Status:** Normative target contract for the v0.4 implementation program.
**Version decision:** Package metadata, TUI metadata, and the writable durable-state generation converge on `0.4.0`; protocol domains remain independently versioned.
**Compatibility:** v0.2 and v0.3 state/protocol data are bounded migration or read-only compatibility input only. They never retain writable v0.4 authority.
**Runtime basis:** the stable OpenCode `>=1.18.3 <1.19.0` contract, with local contract probes against 1.18.3-compatible SDK types and the installed 1.18.18 binary.

This document supersedes conflicting v0.2/v0.3 autonomy semantics and any conflicting text in `docs/autonomous-evolution-plan.md`. The exact pure interfaces are exported by `self-evolve-schemas.js`; implementation slices must use them rather than inventing record variants.

## 1. Authority Boundaries

Durable v0.4 separates five scopes:

1. **Automatic recommendations preference:** one state-root-global `automaticRecommendationsEnabled` boolean, presented only as On or Off.
2. **Project participation:** one project's independent Include/Exclude choice. No project mode or mode inheritance remains.
3. **Project evidence:** observations, evidence domains, capsules, contribution intents, and contribution links retained in that project's partition.
4. **Global learning:** identity-free contributions, candidates, support sets, synthesis attempts, recommendations, content, decisions, leases, and audits shared under one state root.
5. **Global targets:** existing local global skills discovered from host-authoritative global sources, plus new skills under one explicit operator-selected creation root.

Automatic recommendations On admits only future eligible automatic work; it does not grant global write authority. Off stops automatic work but does not disable the control center, inbox, or otherwise valid explicit recommendation actions. A project does not own a global recommendation. Any live compatible integration may consume an explicit global request after validating the acting project's short-lived authority.

Models are advisory. A model cannot select or change a source, root, creation root, permission, Automatic recommendations preference, project participation, retention/purge authority, Apply/Undo authority, action grant, nonce, lease, or protocol capability.

## 2. Version and Capability Contract

`V4_VERSION_CONTRACT` fixes:

- package version: `0.4.0`;
- TUI version: `0.4.0`;
- writable durable-state schema generation: `0.4.0`;
- migration input: `0.2.0`, `0.2.1`, `0.2.2`, and `0.3.0`;
- writable state versions: `0.4.0` only;
- legacy writable authority: false.

Defining the decision here does not permit mixed v0.2/v0.3/v0.4 writes. Migration finishes before authority opens and never replays after a valid v0.4 settings record exists.

`V4_PROTOCOL_CONTRACT` preserves the exact global recommendation index/detail, global action request, global decision, feedback, transaction, and project participation version-1 domains. The breaking settings/dashboard control plane advances independently to dashboard version 3 and UI operation version 2. Its new authoritative capability is `automatic-recommendations-control-v1`; `project-participation-v1` remains the only project-level automation control. The exact retained global capabilities are:

```text
global-action-grant-v1
global-action-request-v1
global-recommendation-detail-v1
global-recommendation-index-v1
global-transaction-v1
project-participation-v1
automatic-recommendations-control-v1
```

Legacy bridge schemas `0.2.1`/`0.2.2`, dashboard v1/v2, UI operation v1, `project-analysis-control-v1`, `legacy-control-v1`, `control-repo-mode-v1`, and `operation-pause-v1` are read-only compatibility input only. A new-TUI/old-server or old-TUI/new-server pairing is explicitly limited and submits no write. Package version never implies a capability. Old `set-mode`, `set-repo-mode`, `set-paused`, scan, pause/resume/disable, and `passiveCalls` requests receive deterministic migration guidance and are never reinterpreted as On, Off, Include, Exclude, Emergency Stop, or a permission transition.

### 2.1 Exact v0.4 surface disposition

| v0.3 surface | v0.4 disposition |
|---|---|
| bare `/self-evolve`, `help`, `status`, `inbox`, `budget`, `health` | Retained with binary preference/operational-state language. |
| `review`, exact `approve`, `reject` and `dismiss` compatibility, `snooze`, `undo` | Retained with the same names, tuples, confirmations, and recommendation-specific authority. |
| project `include` / `exclude` and `project-participation-v1` | Retained as the sole project participation switch. |
| durable-observations, sanitized-excerpts, cross-project permission controls | Retained; revoking any one atomically turns automation Off, restoring one leaves it Off. |
| allowlist compatibility suggestions and root-policy editor | Suggestions remain non-authoritative; root policy is retained only for explicit new-skill creation and contract-approved non-host targets. |
| observation/eligibility inspection, export, scoped purge, global purge | Retained with the same scopes and confirmations, except version text advances to `0.4.0`. |
| `reinitialize`, `reset-breaker`, `kill-switch`, health/budget controls | Retained under those exact names and authority; the UI may label kill switch as Emergency Stop. |
| recommendation acknowledgment, structured feedback, and Activity links | Retained native surfaces. |
| Automatic recommendations On/Off | Added as the sole normal operating preference. |
| `/self-evolve scan`, bare-scan compatibility, Manual/on-demand | Removed; requests return migration guidance with no material reads or effects. |
| `manual`, `auto`, `yolo`, installation/project/repository modes and inheritance | Removed as writable state and protocol authority; valid stored legacy values migrate to On. |
| Pause/Resume/Disable and `set-paused` | Removed; requests are not mapped to Off or Emergency Stop. |
| separate `passiveCalls` consent | Removed; required automatic provider permission is part of the On bundle. |
| `durableAutonomy: false`, hidden analyzer, legacy registry/proposals | Removed from configuration, reachable code, and package contents. |

## 3. Binary Preference, Migration, and Lifecycle Hook

### 3.1 Automatic recommendations

`automaticRecommendationsEnabled` is the only stored normal operating preference. It is state-root-global and exactly boolean. Automatic recommendations On requires `durableObservations`, `sanitizedExcerpts`, and `crossRepoAggregation` all true. One accepted On transaction writes the complete permission bundle and advances the separate automation epoch exactly once. One accepted Off transaction writes Off and advances the epoch exactly once without purging retained data.

Revoking any required permission is one recoverable transaction: persist that permission false, persist Off, advance the automation epoch once, enqueue the permission's existing privacy deletion/invalidation duties, and audit the transition. Restoring a permission changes only that permission and never turns automation On. Explicit On re-enables the full required bundle. Identical transition retries are idempotent; stale or conflicting transition IDs/nonces fail.

Fresh installations and authenticated `REINITIALIZE SELF-EVOLVE 0.4.0` initialize On with all three required permissions true. Every valid supported v0.2/v0.3 Manual, Auto, Yolo, project-mode, and paused true/false combination migrates exactly once to that same On bundle. Migration preserves project exclusions and `killSwitchActive`. A valid post-cutover Off or permission revocation survives restart and is never replayed away. Malformed, corrupt, or unsupported authority opens Off with no partial grants.

Project Include/Exclude, Emergency Stop, circuit breaker, budgets, quiet periods, unsupported host, preboot validation, and corruption remain operational suppressors. They do not rewrite the stored preference. Ordinary Pause no longer exists.

The automation epoch is stored outside project partitions under the validated state root, is separate from the terminal-root and breaker epochs, and uses the same cross-process lock/durability primitives. Every automatic admission, provider, persistence, continuation, and settlement binds and freshly compares its exact generation. Process-local aborts are only best-effort latency optimization.

On-to-Off closes the old generation before new admission. Recovery supersedes only collecting, eligible, synthesis-pending candidates and nonterminal attempts from the old generation. Published recommendations and terminal no-change/failed-closed/recommended results remain. Re-enable seeds or advances source cursor baselines so Off-window messages/events and pre-Off observations/contributions/support never backfill; only safely delimited future activity can count.

### 3.2 One stable hook shape

Every durable instance always returns exactly one `Hooks.event` lifecycle hook, including Off and startup-validation states. It never registers passive `chat.message`.

The lifecycle handler must perform this gate before any material operation:

1. If boot/root/host validation has not completed, return.
2. Read the fresh Automatic recommendations preference, required data permissions, automation generation, and operational suppressors without hydrating source lineage or session data.
3. If the preference is Off, any required permission is false, the generation is invalid, or any suppressor is active, return.
4. Only then admit an allowed lifecycle event to normal dedup/scheduler processing.

Before step 4 the handler performs none of the following:

- canonical source-lineage hydration;
- session or message reads;
- provider/synthesizer/critic calls;
- durable receipt, observation, capsule, intent, contribution, candidate, or audit writes;
- scheduler admission or lease creation.

There is no Manual/on-demand path and no `/self-evolve scan`. Removed requests return bounded migration guidance before material reads, provider calls, or durable effects.

## 4. Host-Global Existing Skills and Creation Authority

### 4.1 Stable OpenCode 1.18.x host-source contract

The adapter consumes only official values rooted in `PluginInput.serverUrl`, `PluginInput.directory`, and `PluginInput.worktree`:

1. GET `/path` at the exact official server origin supplies bounded absolute `home`, `config`, `worktree`, and `directory` paths. The stable SDK's `client.path.get()` may supply its typed subset; disagreement fails closed.
2. Directory-scoped GET `/config` (or `client.config.get`) at the host-reported global config directory supplies the global-only `skills.paths` projection. The acting-project projection is read separately. Relative global entries resolve only against the host-reported config directory; URL entries are never local targets.
3. Directory-scoped GET `/skill` supplies the host-resolved `{name, description?, location, content}` set once for the global config directory and once for the acting project. `<built-in>`, URL/embedded/cache markers, malformed shapes, non-file locations, and entries absent from the global-only set are excluded.
4. Fixed global compatibility collections are derived only below the host-reported home/config roots: `<config>/skills`, `<home>/.agents/skills`, and `<home>/.claude/skills`. Project `.opencode/.agents/.claude` collections and every path contained by the canonical project/worktree are excluded.
5. A custom absolute or relative `skills.paths` collection is eligible only when it appears in the global-only config projection, resolves canonically outside the project/worktree, and its winning resolved skill is present with the same canonical location/content in the global-only `/skill` projection. Project-only paths and host/config disagreement fail closed.

OpenCode 1.18.x does not return a trustworthy source-kind tag on each stable `/skill` item. Self-Evolve therefore never infers global authority from the acting-project aggregate alone. The three host projections above, exact-origin access, containment/ownership checks, and byte/hash agreement together are the authority proof. Unsupported endpoint or response shapes produce bounded diagnostics and no target.

### 4.2 Catalog and target rules

`HostGlobalSourceReceipt` binds the exact host version, official origin, host path identity, global config projection hash, normalized source roots and precedence, and global resolved-skill projection hash. `HostGlobalSkillBinding` binds that receipt, canonical collection and skill paths, logical name, precedence, content size/hash, and target-binding hash. Neither grants a write by itself.

The catalog is read-only and may be inspected while automation is Off. It is deterministic, bounded by count/bytes/depth, and fails closed on ambiguity, duplicates without one host winner, malformed frontmatter, missing/noncanonical paths, symlinks, containment/ownership/mode failure, relocation, content drift, unsupported source markers, or host/config disagreement. Provider-bound reads retain the same no-follow, identity-checked bytes through prompt construction.

Existing-skill recommendations require one current host-global binding and no Self-Evolve root policy. Apply revalidates the complete binding and current bytes under its target lease immediately adjacent to mutation.

### 4.3 Explicit new-skill creation

`GlobalRootPolicy` remains operator-selected authority only for new-skill creation and any separately specified non-host target. New targets require exactly one canonical `creationRootId`, bind `must-not-exist` before synthesis, and reject every file, directory, logical-name, symlink, containment, or drift collision. A model may suggest a strict logical name but can never choose or change the root.

Rules:

- Existing targets are host-global only and never require an approved update root.
- New targets require the exact explicit creation root and never fall back to a host-discovered source.
- Project-local, remote, embedded, and cache skills are never automatic targets.
- Legacy `allowedSkillRoots` values remain suggestions only and never authorize an existing or new target.
- GlobalRootPolicy replacement, discovery, and migration perform no provider call, recommendation decision, permission/preference change, or skill mutation.

Deterministic target binding replaces the retired `explicitGlobalDesignation` boolean. That field and all equivalent booleans are rejected as extras.

## 5. Project-Local Evidence and Publication

### 5.1 Evidence domains

`EvidenceDomain` is project-local. One uniquely configured HTTP(S), SSH, or Git network remote is canonicalized to host, non-default port, and repository path after removing transport credentials, transport aliases, trailing separators, and `.git`; its domain-separated hash is independent of clone, linked-worktree, and relocation paths. That known canonical source lineage produces a domain-separated `domainId` and is eligible to count toward distributed support. No remote, malformed or unsupported remote input, and multiple distinct canonical remotes are unavailable or ambiguous: all collapse to the one `UNKNOWN_EVIDENCE_DOMAIN_ID`, carry no source-lineage hash, and set `distributedEligible: false`.

Evidence-domain IDs, source-lineage hashes, and lineage-derived hashes never enter global records.

### 5.2 Evidence capsules

`EvidenceCapsule` is a project-local v0.4 record with one opaque random capsule ID, one local incident ID, receipt type, nullable exact target name, a summary of at most 240 UTF-8 bytes, its exact SHA-256, and creation/expiry timestamps.

One admitted receipt derives at most one capsule for its local incident. Derivation uses only the already-bounded command name, tool/error metadata, procedure shape, or clarification category; it never copies a complete message body. Project-local persistence deduplicates on incident ID and rejects a conflicting retry.

Capsules require fresh sanitized-excerpt consent. They reject unknown fields, controls, recognized secret markers, code fences, absolute paths, injection/self-reference markers, blocked/private names, non-canonical hashes, oversized UTF-8, and non-increasing expiry. Redaction is heuristic, not a secrecy guarantee. Raw transcripts, full message bodies, raw host IDs, complete prompts, and project paths remain prohibited.

### 5.3 Contribution transaction

Fresh `sanitizedExcerpts` and `crossRepoAggregation` consent is mandatory before creating any publication artifact.

A project-local `ContributionIntent` allocates a UUID-v4 `contributionId` before publication. Retries and crash recovery reuse that exact allocation. The intent privately links the contribution to local incident, capsule, cluster, evidence-domain, and consent-version identity through this transition graph:

```text
allocated -> published -> linked -> committed -> revoked
     |            |          |
     +----------> revoked <---+
     +----------> failed-closed
```

Skipping a step, going backward, or reviving `failed-closed` is invalid. `ProjectContributionLink` retains the same private mapping for precise retention and project purge.

`GlobalContribution` contains only:

```text
schemaVersion, contributionId, claimType, receiptType, signatureHash,
occurrenceCount, firstSeenDay, lastSeenDay, createdAt, expiresAt
```

Storage is catalog-independent and sharded by the first byte of the opaque UUID:

```text
<state-root>/self-evolve/global/contributions/<uuid-prefix>/<contributionId>.json
<state-root>/self-evolve/<projectFingerprint>/contribution-intents/<uuid-prefix>/<intentId>.json
<state-root>/self-evolve/<projectFingerprint>/contribution-links/<uuid-prefix>/<contributionId>.json
```

The intent file privately retains the exact immutable contribution payload needed for recovery. Under the one state-root mutation lock, publication preflights the complete final project and global footprint, writes the allocated intent, create-exclusively writes and reads back the immutable global contribution, create-exclusively writes the local link, then commits the intent. Each state transition is idempotent. Boot scans every project partition so a crash after global publication cannot leave readable orphan authority; a partial create-exclusive file is repaired only when the allocating local intent proves its UUID and exact payload.

The global domain has a fixed 64 MiB and 16,384-regular-file ceiling. Project publication uses the configured project byte quota and a 16,384-regular-file safety ceiling across the project partition and project bridge tree. Both complete projected footprints are checked before the first intent write, and each recovered create is checked again before publication. Quota denial creates no intent, contribution, or link.

The UUID-v4 contribution ID is opaque random authority, not an incident hash. No global identifier or digest may derive from project, worktree, source-domain, evidence-domain, capsule, cluster, observation, session, or local-incident identity.

## 6. Global Identity Firewall

Every global validator rejects extras and recursively rejects identifier/hash/path keys for project, repository, worktree, source domain, evidence domain, capsule, cluster, observation, session, or local incident. Callers that hold local identity values must pass them as `forbiddenIdentityValues`; equality with any such value, including an identity-derived SHA-256, fails with `forbidden-global-identity`.

The firewall applies to global contributions, support sets, candidates, recommendations, recommendation content, decisions, synthesis attempts, leases, and audits. Allowed global identifiers are either:

- UUID-v4 values allocated randomly in a project-local intent or global operation; or
- deterministic hashes recomputed exclusively from already identity-free global content and host-global or explicit-creation target material.

Opaque global contribution IDs may appear in immutable support sets so the exact evidence set is hash-bound. They are random join capabilities, not contributor identities; candidate files still expose only counts and hashes, and project-local mappings remain prohibited globally.

## 7. Candidates, Support Sets, and Eligibility

### 7.1 Candidate and support identity

`GlobalCandidate.candidateId` is recomputed from claim type, receipt type, deterministic signature hash, and candidate target-binding hash. It exposes identity-free counts and coarse dates, never contributor identities.

`GlobalSupportSet.supportSetHash` is recomputed from candidate ID, deterministic target binding, the sorted exact opaque contribution-ID set, strongest single-domain metrics, distributed metrics, integrity gates, coarse dates, and support expiry. Evaluation time is excluded so retrying the same support remains idempotent. The support set contains no contributor, evidence-domain, project, worktree, capsule, cluster, observation, session, or local-incident identity.

Materialization joins contributions to committed active links and their bounded project-local observations under the state-root mutation lock. It deduplicates by private evidence-domain plus local-incident identity, collapses every unavailable or ambiguous source to the one local-unknown domain, and discards those private join keys before writing:

```text
<state-root>/self-evolve/global/candidate-support/<hash-prefix>/<supportSetHash>.json
<state-root>/self-evolve/global/candidates/<hash-prefix>/<candidateId>.json
```

Retention and project purge remove or downgrade only pending candidates whose joined support changed; unrelated candidate records remain byte-identical.

A rejected or failed-closed candidate cannot become eligible again with the same support-set hash. New evidence must create a different immutable support set. Stale support, target, root set, or catalog generation invalidates pending authority.

### 7.2 Mandatory integrity gates

Both eligibility routes require all four flags:

- `contradictionFree: true`;
- `injectionFree: true`;
- `chronologyValid: true`;
- `correlationValid: true`.

A failure in any one gate makes the support set ineligible. Distributed evidence does not waive a per-incident safety or integrity gate.

### 7.3 Single-domain route

One strongest evidence domain qualifies exactly at all these boundaries:

- at least 2 independent incidents;
- at least 3 total occurrences;
- at least 2 distinct non-unknown user root lineages;
- freshness ratio at least 0.5 within retention;
- all integrity gates pass;
- candidate target binding revalidates against the current host-global catalog receipt or explicit creation-root policy.

Known and local-unknown domains may use this route. Unknown lineage does not waive the non-unknown user root-lineage threshold.

### 7.4 Distributed route

Distributed support qualifies exactly when:

- at least 2 independent **known** evidence domains contribute;
- at least 3 independent incidents total contribute;
- all integrity gates pass;
- candidate target binding revalidates against the current host-global catalog receipt or explicit creation-root policy.

Unavailable or ambiguous lineage is recorded only as one collapsed local-unknown domain. It never increments `independentKnownDomainCount`, never supplies a second distributed domain, and can qualify only through the complete single-domain route.

`evaluateGlobalSupportEligibility` applies the fixed `V4_ELIGIBILITY_THRESHOLDS`; callers cannot supply lower thresholds.

## 8. Synthesis and Global Recommendation Lifecycle

Before each provider use, after the hidden synthesizer or critic session is created and durably owned but immediately before provider-slot reservation and prompt dispatch, the server freshly revalidates Automatic recommendations On, all required data permissions, the exact automation generation, terminal/breaker epochs, budgets, support-set hash, eligibility, host-global or creation-root target binding, catalog generation, operational suppressors, and the candidate-synthesis lease. The synthesizer moves one generation-bound durably `admitted` `GlobalSynthesisAttempt` to `dispatched` at this boundary, and the critic revalidates the same dispatched attempt. Each boundary rebuilds the exact packet, target prompt, and token claim from that fresh state.

Off returns before source-lineage hydration, session/message reads, provider calls, durable observation/contribution/candidate writes, or scheduler admission. After dispatch, an Off transition or generation mismatch discards late provider output without creating an observation, contribution, candidate, recommendation, or result authority beyond already-durable dispatch accounting. Recovery terminalizes or supersedes old-generation unfinished work exactly once and never revives it after re-enable.

The provider evidence packet exists only in memory. It contains at most one current capsule summary from each of at most eight independent evidence domains, each summary remains at most 240 UTF-8 bytes, and the complete canonical JSON packet remains at most 4 KiB. Packet entries expose only receipt type and summary; project, worktree, source, evidence-domain, contribution, capsule, cluster, observation, session, and local-incident identifiers are excluded. The exact opaque contribution set remains bound only by the durable support set.

Attempt transitions are exact:

```text
admitted -> dispatched -> completed
    |            |
    +----------> failed-closed
```

Once dispatched, a crash or failure never silently retries the same support set. Prompts, excerpts, project identity, and provider response bodies are not attempt fields.

A valid model no-op completes the attempt successfully and moves the candidate from `synthesis-pending` to the terminal `no-change` state. The same support set cannot replay; materially changed support may make the candidate eligible again. No recommendation or content chunk is created for this outcome.

Global attempts, recommendations, and recommendation-content chunks are sharded under `global/synthesis-attempts/`, `global/recommendations/`, and `global/recommendation-content/`. Recovery defers an unexpired candidate-synthesis lease. After lease expiry it terminalizes an admitted or dispatched attempt without a provider call, completes a durable `no-change` candidate marker, or completes only a fully persisted canonical recommendation with complete hash-verified chunks. A recommendation whose candidate write completed before the attempt write is preserved and completed. Partial or invalid completion artifacts are removed and both attempt and candidate terminalize fail closed.

Synthesis and critic sessions remain hidden, deterministic, deny-all-tools sessions. They are not the removed legacy analyzer. The supported `session.delete` capability is required before creating either session. After every prompt path the server interrupts as needed, deletes the owned session before returning output, and releases durable ownership only after deletion succeeds. Delete failure retains ownership for boot retry and fails synthesis closed. Recovery deletes provably owned active or terminal hidden sessions and never mutates foreign or unknown sessions. Existing targets are fixed from a host-global binding before provider use. New targets fix the explicit creation root before provider use; only a strict logical name and proposed content are model suggestions. Deterministic overlap validation rejects exact normalized body copies and proposals containing a substantial complete body from another catalog skill, excluding the bound target itself.

`GlobalRecommendation` binds candidate ID, support-set hash, candidate target-binding hash, final target binding, proposed-content hash, bounded rationale, model ID, critic score/result, deterministic validation, state, decision version, and burned nonce hashes. `GlobalRecommendationContent` is exact canonical base64 chunking bound to recommendation and content hash. Neither stores a capsule, excerpt, prompt, acting project, consumer process, or source identity.

## 9. Explicit Decision, Apply, and Undo

Global recommendation transitions are:

```text
critic-pending --critic--> pending
pending --operator--> approved | rejected
approved --applier--> applied
applied --operator--> undo-approved
undo-approved --applier--> rolled-back
active state --policy--> superseded | failed-closed
```

Only the stated role may perform an edge. Decision version must increment by exactly one. Every decision is bound to recommendation ID, immutable support set, final target-binding hash, current target hash or exact `must-not-exist`, proposed-content hash, prior state, next state, timestamp, and one-use nonce. Replays, stale versions, stale hashes, cross-scope bindings, invalid actors, and invalid edges fail closed.

The operator's `approved` edge is the explicit Apply decision; the applier may publish only that exact approved version after fresh revalidation. The operator's `undo-approved` edge is the explicit Undo decision; the applier may roll back only that exact version after fresh current-state proof. Auto never creates either edge.

Target writes serialize on `globalTargetLeaseKey(rootId, relativePath)`, not candidate/recommendation ID. Lease owners are opaque random tokens. Global leases contain no project/process identity and follow exact active -> released/expired transitions.

Global leases are sharded at `global/leases/<key-prefix>/<leaseKeyHash>.json`, have a maximum one-hour TTL, and participate in the same fixed global byte/file caps. Acquisition and release use only the short synchronous state-root mutation-lock critical section; provider calls occur after acquisition returns and never while that lock is held.

The direct server-domain interface is `createGlobalDecisionDomain(...).decide({ action, decision })`. It accepts only `apply` or `undo` plus an exact `GlobalDecision`; the Automatic recommendations preference is not write authority and ordinary Off is not an action suppressor. `recover()` resumes only already durable nonterminal intents. Projection, grants, acting-project metadata, and mailbox transport are separate callers of this domain and do not enter its records.

An accepted operator edge creates one content-addressed `GlobalApplyIntent` and advances it through `decision-pending -> decision-committed -> snapshot-ready -> temp-written -> published -> readback-verified -> completed`. Any safely reverted failure terminalizes `failed-closed`. Global decisions, intents, exact sensitive snapshots, outcomes, and audits are separately sharded under `global/decisions/`, `global/apply-intents/`, `global/skill-snapshots/`, `global/decision-outcomes/`, and `global/audits/`. They contain only recommendation/target/content bindings and bounded actor roles; project, worktree, source, capsule, cluster, observation, incident, session, and process identity remain prohibited.

While the target-write lease is owned, Apply freshly rebuilds the applicable host-global catalog or creation-root policy and revalidates source/root/content generations, unique logical name, exact existing hash or absent new path, support eligibility and expiry, all required data permissions, Emergency Stop/breaker/integrity suppressors, recommendation/version/nonce edge, content hash, critic result, and deterministic content checks. Ordinary Off alone does not block Apply. Existing replacement uses a same-directory exclusive temp, fsync, atomic rename, and readback. New publication creates the target directory only after absence proof and uses a same-directory verified temp plus create-exclusive hard link; there is no overwrite-capable fallback.

Reject is always available for a current pending recommendation regardless of Automatic recommendations, privacy permission, Emergency Stop, or breaker state; it writes no skill file. Undo uses the same target lease and requires the current skill hash to equal the recorded applied hash. Exact risk-reducing Undo remains available while Off and after privacy/support revocation, Emergency Stop, or breaker trip when snapshot/path/transaction/grant/lease integrity is still provable. Existing Undo restores the exact global snapshot through a same-directory temp, rename, fsync, and readback. New-skill Undo unlinks only that exact hash-proven plugin-created file and removes its direct directory only when empty. Recovery revalidates authority before an unpublished mutation, reuses only a name- and hash-proven temp, completes bookkeeping from exact published/readback disk proof, and rolls back only bytes proven to belong to the plugin transaction. The stored `GlobalDecisionOutcome` makes an identical retry idempotent; reusing its nonce for a different edge remains a replay failure.

## 10. Acting Project and Consumer Protocol

`GlobalActionRequest` is short-lived bridge metadata, not durable recommendation or audit content. It binds:

- state-root identity;
- acting project fingerprint and fresh TUI health hash;
- global projection generation and grant hashes;
- recommendation ID/version;
- support-set, target-binding, and proposed-content hashes;
- explicit `apply`, `reject`, or `undo` action;
- operator role, nonce, issue/expiry, request UUID, and request hash.

Authority TTL is at most 60 seconds.

`GlobalConsumerClaim` separately identifies the consumer integration with an opaque instance UUID and its own project fingerprint. `validateGlobalActionAuthority` requires a validated consumer boot, active unexpired claim, exact request binding, live acting-project health, fresh grant/projection, current recommendation/version, and all hashes. It deliberately does **not** require acting and consumer project fingerprints to match.

Acting and consumer fingerprints are operational bridge data only. `GlobalAuditEvent` has an exact identity-free schema and rejects either fingerprint or any equivalent source identity.

## 11. Consent, Retention, Purge, and Export

### 11.1 Consent revocation

Data permissions are operator authority only. `evaluateV4PermissionTransition` defines immediate effects:

- revoke `durableObservations`: atomically turn automation Off, stop new durable evidence/contributions, invalidate dependent support, and block Apply;
- revoke `sanitizedExcerpts`: atomically turn automation Off, delete project capsules, stop contributions, invalidate dependent support, and block Apply;
- revoke `crossRepoAggregation`: atomically turn automation Off, stop contributions, invalidate dependent support, and block Apply.

Every revocation advances the automation epoch exactly once. Restoring a permission never turns automation On. Existing recommendations remain visible, exportable, rejectable, and exactly undoable after revocation; Apply returns only when every required permission, current support, and all other action-specific proofs pass. Restoring a permission may therefore restore Apply while automation remains Off, but it causes no automatic admission or provider activity.

Capsule deletion is part of settings-transaction recovery and precedes transaction-marker removal. The project-local `getEvidenceCapsuleSupport` query returns only availability plus an opaque capsule ID when available, or a bounded unavailable reason after denial, expiry, deletion, or revocation. That signal is the handoff for contribution/support children; capsule IDs, incident IDs, summaries, and deletion results are not written to global durable state.

### 11.2 Exact defaults

`V4_RETENTION_DEFAULTS` and `makeV4RetentionPolicy` fix:

| Class | Default |
|---|---:|
| Project evidence | 30 days |
| Evidence capsules | 30 days |
| Global contributions | 30 days |
| Global candidates/support | 30 days |
| Global recommendations/content | 90 days |
| Global audits/rollback authority | 90 days |
| Retained bridge artifacts | 24 hours |
| Acting request/consumer authority | at most 60 seconds |
| Global lease safety maximum | at most 1 hour |

Implementations should use shorter operation-specific lease TTLs. Crossing an expiry never steals a lease from a proven live owner without the process-aware recovery contract.

Active pending/applied recommendation chains and rollback material survive nominal age while authority remains live. Rejected, superseded, failed-closed, and rolled-back content compacts promptly. Expired contributions recompute candidates/support and revoke stale pending authority.

### 11.3 Purge

Purge scopes are exact:

- `project-evidence`: local evidence/capsules/intents/links and only their linked global contributions; recompute affected support.
- `project`: the complete project partition plus the same linked global contribution cleanup; global settings/root policy remain.
- `global-recommendation`: one recommendation chain identified by recommendation ID.
- `global-recommendations`: global candidate/support/recommendation domains without deleting unrelated project evidence.
- `all`: the complete self-evolve subtree.

Project purge uses project-local links; it never guesses project ownership from a global record. Purging one project cannot remove another project's local evidence.

Purge-all requires exact `PURGE ALL SELF-EVOLVE 0.4.0` confirmation and the state sequence:

```text
requested -> accepted -> authority-stopped -> deleting -> completed
```

`accepted` means the authenticated accepted-terminal response is published. The system then stops admission/timers/authority before deletion. It remains terminal until a fresh process restart and cannot recreate state during shutdown.

The terminal truth is a power-loss-durable root-global epoch record persisted at `<stateRoot>/.self-evolve-root-epoch.json` — outside the deletable `self-evolve/` subtree but inside the validated state-root boundary. When any process accepts purge-all it writes the terminal epoch durably first; every peer process sharing the state root reads it at its next mutation-lock acquisition or admission cycle and fails closed with a stable `root-epoch-terminal` reason. Old leases, grants, automation generations, and nonces cannot cross terminal epochs: the terminal epoch fences every authoritative mutation, and purge-all deletes the subtree that stored them. Restart alone cannot clear the terminal epoch; a restarted process opens inert. Authority returns only through an authenticated explicit `REINITIALIZE SELF-EVOLVE 0.4.0` operation that creates a new root epoch generation and an On/all-required-permissions automation baseline, binding fresh root/project identity, schema/protocol versions, a one-use nonce, and operator authority. It is replay-safe, audited, and cannot be model-selected.

Exports preserve the same partition/global separation, include only the acting project's private partition, wrap its capsules as `sensitive-evidence-capsule`, mark content/snapshot data sensitive, omit raw prohibited data and operational secrets, and never infer contributor identity from global records. The `global-recommendations` scope excludes project evidence, global settings, contributions, and aggregates. Global export members contain neither capsules nor capsule IDs.

## 12. Exact Pure Schema Interface

All constructors reject unknown fields, invalid types, invalid bounds, stale deterministic IDs/hashes, and non-increasing timestamps. Returned records are deeply frozen.

| Domain | Exact schema/constructor |
|---|---|
| Binary automation | `AutomaticRecommendationsSettings`, `makeAutomaticRecommendationsSettings`, `transitionAutomaticRecommendations`, `evaluateAutomaticRecommendationReadiness` |
| Automation epoch | `AutomationEpoch`, authenticated fresh read/compare/stamp APIs, and one cross-process transition journal |
| Project participation | `ProjectParticipationSettings`, `makeProjectParticipationSettings`, `transitionProjectParticipation` |
| Host-global catalog | `HostGlobalSourceReceipt`, `HostGlobalSkillBinding`, `makeHostGlobalCatalog`, `makeExistingSkillTargetBinding` |
| Creation authority | `makeApprovedGlobalRoot`, `makeGlobalRootPolicy`, `makeNewSkillTargetBinding`, `makeRecommendationTargetBinding` |
| Local evidence | `EvidenceDomain`, `makeEvidenceDomain`, `EvidenceCapsule`, `makeEvidenceCapsule` |
| Publication | `ContributionIntent`, `transitionContributionIntent`, `ProjectContributionLink`, `GlobalContribution` |
| Candidate/support | `GlobalSupportSet`, `GlobalCandidate`, `evaluateGlobalSupportEligibility`, `transitionGlobalCandidate` |
| Recommendation | `GlobalRecommendation`, `GlobalRecommendationContent`, `GlobalDecision`, `transitionGlobalRecommendation` |
| Coordination | `GlobalSynthesisAttempt`, `GlobalLease`, their transition functions, `globalTargetLeaseKey` |
| Protocol/authority | `GlobalActionRequest`, `GlobalConsumerClaim`, `validateGlobalActionAuthority`, separate `evaluateApplyAuthority`, `evaluateRejectAuthority`, and `evaluateUndoAuthority`, `GlobalAuditEvent` |
| Lifecycle | `V4RetentionPolicy`, `makeV4RetentionPolicy`, `V4PurgeOperation`, `transitionV4PurgeOperation`, `evaluateV4PermissionTransition` |
| Identity firewall | `assertGlobalIdentitySafe`, `asOpaqueRandomId` |

Legacy v0.2/v0.3 mode, paused, project-mode, passive-consent, analyzer, proposal, and protocol schemas may exist only inside bounded migration/read-only readers. They are rejected by v0.4 constructors and have no writable or runtime authority.

## 13. Permanent Prohibitions

No preference, configuration, model result, protocol fallback, allowlist, or migration may permit:

1. repo-local autonomous targeting or writes;
2. unattended global Apply or Undo;
3. model-selected sources, roots, permissions, Automatic recommendations state, participation, retention/purge authority, or write authority;
4. global persistence of project/worktree/source-domain/evidence-domain/capsule/cluster/observation/session/local-incident identifiers or identity-derived hashes;
5. raw transcripts, complete message bodies, raw host IDs, complete prompts, or durable capsule text in global state;
6. passive `chat.message` registration;
7. source-lineage hydration, provider/session reads, or durable effects from a preboot or Off lifecycle event;
8. implementation, shell, or Git agents;
9. Git mutation, publication, external-tracker mutation, or external-system writes;
10. prompt/message injection into a working session, `client.session.promptAsync`, `client.tui.appendPrompt`, or the working agent's question tool;
11. writes outside a current host-global existing target or exact explicit creation root by the sole transactional applier;
12. mixed writable v0.2/v0.3/v0.4 authority;
13. automatic admission, provider use, persistence, or settlement with a stale automation generation;
14. backfill of Off-window activity or pre-Off support after re-enable.

## 14. Preserved Package Invariants

- `self-evolve.js` exports only `default SelfEvolvePlugin`.
- The package root/server graph imports neither `./tui` nor `@opentui/*`; target-exclusive TUI code remains reachable only from `./tui`.
- The legacy analyzer, analyzer prompt/session path, module-level legacy registry/refcount, `durableAutonomy: false`, manual proposal synthesis, and analyzer-only notifications are absent from reachable code and package contents.
- The durable synthesizer and critic remain hidden deny-all-tools sessions; bounded historical analyzer IDs may remain only as inert orphan-cleanup constants.
- The server still returns exactly one stable lifecycle `event` hook and registers no passive `chat.message` hook.
- No ordinary runtime dependency is added.
