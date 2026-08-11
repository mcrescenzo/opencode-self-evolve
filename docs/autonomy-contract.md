# Self-Evolve v0.3 Global-First Contract (Normative)

**Status:** Normative target contract for the v0.3 implementation program.
**Version decision:** Package metadata, TUI metadata, and the writable durable-state generation converge on `0.3.0`; protocol domains remain independently versioned.
**Compatibility:** v0.2 state and bridge data are migration or read-only compatibility input only. They never retain writable v0.3 authority.
**Runtime basis:** OpenCode 1.18.3 and `@opencode-ai/plugin` 1.18.3.

This document supersedes conflicting v0.2 autonomy semantics and any conflicting text in `docs/autonomous-evolution-plan.md`. The exact pure interfaces are exported by `self-evolve-schemas.js`; later implementation slices must use them rather than inventing record variants.

## 1. Authority Boundaries

Durable v0.3 separates four scopes:

1. **Project analysis:** one project's `manual` or `auto` evidence admission policy.
2. **Project evidence:** observations, evidence domains, capsules, contribution intents, and contribution links retained in that project's partition.
3. **Global learning:** identity-free contributions, candidates, support sets, synthesis attempts, recommendations, content, decisions, leases, and audits shared under one state root.
4. **Global targets:** existing or new skills under exact operator-approved global roots only.

Project analysis mode does not grant global write authority. A project does not own a global recommendation. Any live compatible integration may consume an explicit global request after validating the acting project's short-lived authority.

Models are advisory. A model cannot select or change a root, primary creation root, consent value, project analysis mode, project override, retention/purge authority, Apply/Undo authority, action grant, nonce, lease, or protocol capability.

## 2. Version and Capability Contract

`V3_VERSION_CONTRACT` fixes:

- package version: `0.3.0`;
- TUI version: `0.3.0`;
- writable durable-state schema generation: `0.3.0`;
- migration input: `0.2.0`, `0.2.1`, and `0.2.2`;
- writable state versions: `0.3.0` only;
- legacy writable authority: false.

The current package/TUI metadata remains owned by the final release-integration slice, and the durable store cutover remains owned by the state-cutover slice. Defining the decision here does not permit mixed v0.2/v0.3 writes.

`V3_PROTOCOL_CONTRACT` versions each v0.3 protocol domain independently at version 1:

- global bridge schema;
- global projection;
- global operation;
- global decision;
- global feedback;
- global transaction;
- project analysis control;
- project participation.

The exact capabilities are:

```text
global-action-grant-v1
global-action-request-v1
global-recommendation-detail-v1
global-recommendation-index-v1
global-transaction-v1
project-analysis-control-v1
project-participation-v1
```

Legacy bridge schemas `0.2.1`/`0.2.2` and project projection/operation v1 are compatibility input only. An old/new target pairing enters an explicit non-authoritative limited mode; it cannot infer a new capability from package version.

## 3. Project Analysis and Lifecycle Hook

### 3.1 Configured policy

Project analysis modes are exactly `manual` and `auto`. Project overrides are exactly `inherit`, `manual`, and `auto`. The installation default and project override resolve through `resolveProjectAnalysisMode`; temporary operational state resolves separately through `resolveProjectOperationalState`.

Legacy `yolo` is accepted only as stored migration input and normalizes to:

```json
{ "mode": "auto", "unattendedWriteAllowed": false, "migratedFrom": "yolo" }
```

No v0.3 validator, transition, request, grant, recommendation, or authority evaluator accepts `yolo` as configured or write authority.

The legacy `asMode`, `resolveMode`, `transitionMode`, and `evaluateApplyAuthority` exports remain v0.2 compatibility interfaces until the cutover slice removes their writable callers. v0.3 code must use the project-analysis and global-write interfaces in section 12; compatibility exports confer no v0.3 authority.

Operational suppressors are, in fail-closed precedence: unsupported host, unvalidated boot, corrupt state, kill switch, pause, exclusion, open circuit breaker, then configured Manual. Suppression does not rewrite the configured mode.

### 3.2 One stable hook shape

Every durable instance always returns exactly one `Hooks.event` lifecycle hook, including Manual and startup-validation states. It never registers passive `chat.message`.

The lifecycle handler must perform this gate before any material operation:

1. If boot/root/host validation has not completed, return.
2. Read fresh configured project analysis mode and operational suppressors without hydrating source lineage or session data.
3. If configured mode is Manual or any suppressor is active, return.
4. Only then admit an allowed lifecycle event to normal dedup/scheduler processing.

Before step 4 the handler performs none of the following:

- canonical source-lineage hydration;
- session or message reads;
- provider/analyzer/critic calls;
- durable receipt, observation, capsule, intent, contribution, candidate, or audit writes;
- scheduler admission or lease creation.

Manual analysis remains command-driven through `/self-evolve scan`, bound to its explicit source session. Manual never gains passive behavior from the installed hook.

## 4. Global Root and Target Authority

`ApprovedGlobalRoot` contains exactly `rootId`, `canonicalPath`, `canUpdate`, and `canCreate`. `rootId` is the domain-separated SHA-256 of the canonical path and must round-trip exactly.

`GlobalRootPolicy` contains exact v0.3 schema version, bounded approved roots, nullable `creationRootId`, fixed `selectedBy: "operator"`, `updatedAt`, and deterministic `rootSetHash`.

`GlobalSkillCatalog` is rebuilt from that policy and the filesystem. Its generation hash is domain-separated over the root-set hash and the exact sorted direct-child skill bindings. A catalog with any blocker grants no target authority.

Rules:

- Every root is canonical, absolute, unique by path and root ID, and grants at least update or create capability.
- Each approved path is one exact skill collection. Discovery inspects only direct `<logical-name>/SKILL.md` children; it never recursively infers collection roots. If an approved parent contains nested collection folders, setup is blocked until the operator approves each intended exact collection.
- Logical names are strict lowercase hyphenated names and must be unique across every approved root. Duplicate names, malformed direct skills, symlinks, missing or noncanonical roots, relocation, containment failure, or catalog/content-hash drift invalidate the catalog.
- If no primary creation root is selected, no root may grant create capability.
- If one is selected, exactly that one root grants create capability.
- Existing targets require an update-capable approved root, exact normalized logical name, direct-child `<logical-name>/SKILL.md`, and current SHA-256.
- New candidate targets bind the primary creation root, catalog generation, root-set hash, and `must-not-exist` before synthesis; logical name and path are null at that stage.
- A synthesizer may propose a normalized logical name. `makeRecommendationTargetBinding` derives its exact direct-child path under the already-bound creation root. It cannot change the root, root set, catalog generation, or target class.
- New target resolution rejects any existing logical name, directory, file, or symlink collision and never falls back to another root.
- Project-local skill roots are never approved autonomous roots.
- Legacy `allowedSkillRoots` values may be retained as candidate collection suggestions during migration, but only a separately validated operator-selected `globalRootPolicy` authorizes catalog discovery.

Deterministic target binding replaces the retired `explicitGlobalDesignation` boolean. That field and all equivalent booleans are rejected as extras.

## 5. Project-Local Evidence and Publication

### 5.1 Evidence domains

`EvidenceDomain` is project-local. One uniquely configured HTTP(S), SSH, or Git network remote is canonicalized to host, non-default port, and repository path after removing transport credentials, transport aliases, trailing separators, and `.git`; its domain-separated hash is independent of clone, linked-worktree, and relocation paths. That known canonical source lineage produces a domain-separated `domainId` and is eligible to count toward distributed support. No remote, malformed or unsupported remote input, and multiple distinct canonical remotes are unavailable or ambiguous: all collapse to the one `UNKNOWN_EVIDENCE_DOMAIN_ID`, carry no source-lineage hash, and set `distributedEligible: false`.

Evidence-domain IDs, source-lineage hashes, and lineage-derived hashes never enter global records.

### 5.2 Evidence capsules

`EvidenceCapsule` is a project-local v0.3 record with one opaque random capsule ID, one local incident ID, receipt type, nullable exact target name, a summary of at most 240 UTF-8 bytes, its exact SHA-256, and creation/expiry timestamps.

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
- deterministic hashes recomputed exclusively from already identity-free global content and approved-global target material.

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
- candidate target binding revalidates against the current approved global root policy.

Known and local-unknown domains may use this route. Unknown lineage does not waive the non-unknown user root-lineage threshold.

### 7.4 Distributed route

Distributed support qualifies exactly when:

- at least 2 independent **known** evidence domains contribute;
- at least 3 independent incidents total contribute;
- all integrity gates pass;
- candidate target binding revalidates against the current approved global root policy.

Unavailable or ambiguous lineage is recorded only as one collapsed local-unknown domain. It never increments `independentKnownDomainCount`, never supplies a second distributed domain, and can qualify only through the complete single-domain route.

`evaluateGlobalSupportEligibility` applies the fixed `V3_ELIGIBILITY_THRESHOLDS`; callers cannot supply lower thresholds.

## 8. Synthesis and Global Recommendation Lifecycle

Before each provider use, after the hidden session is created and durably owned but immediately before passive-slot reservation and prompt dispatch, the server freshly revalidates consent, budgets, support-set hash, eligibility, target binding, root set, catalog generation, kill/pause state, and the candidate-synthesis lease. Passive work additionally requires fresh `passiveCalls` consent; explicit manual work does not. The synthesizer moves one durably `admitted` `GlobalSynthesisAttempt` to `dispatched` at this boundary, and the critic revalidates the same dispatched attempt. Each boundary rebuilds the exact packet, target prompt, and token claim from that fresh state.

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

Synthesis and critic sessions remain hidden, deterministic, deny-all-tools sessions. The supported `session.delete` capability is required before creating either session. After every prompt path the server interrupts as needed, deletes the owned session before returning output, and releases durable ownership only after deletion succeeds. Delete failure retains ownership for boot retry and fails synthesis closed. Recovery deletes provably owned active or terminal hidden sessions and never mutates foreign or unknown sessions. Existing targets are fixed before provider use. New targets fix the primary creation root before provider use; only a strict logical name and proposed content are model suggestions. Deterministic overlap validation rejects exact normalized body copies and proposals containing a substantial complete body from another catalog skill, excluding the bound target itself.

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

The direct server-domain interface is `createGlobalDecisionDomain(...).decide({ action, decision })`. It accepts only `apply` or `undo` plus an exact `GlobalDecision`; project analysis mode is not an input and cannot grant or suppress explicit write authority. `recover()` resumes only already durable nonterminal intents. Projection, grants, acting-project metadata, and mailbox transport are separate callers of this domain and do not enter its records.

An accepted operator edge creates one content-addressed `GlobalApplyIntent` and advances it through `decision-pending -> decision-committed -> snapshot-ready -> temp-written -> published -> readback-verified -> completed`. Any safely reverted failure terminalizes `failed-closed`. Global decisions, intents, exact sensitive snapshots, outcomes, and audits are separately sharded under `global/decisions/`, `global/apply-intents/`, `global/skill-snapshots/`, `global/decision-outcomes/`, and `global/audits/`. They contain only recommendation/target/content bindings and bounded actor roles; project, worktree, source, capsule, cluster, observation, incident, session, and process identity remain prohibited.

While the target-write lease is owned, Apply freshly rebuilds the approved global catalog and revalidates the current root set and capabilities, original catalog generation, unique logical name, exact existing hash or absent new path, support eligibility and expiry, required consent, pause/kill/circuit/emergency suppressors, recommendation/version/nonce edge, content hash, critic result, and deterministic content checks. Existing replacement uses a same-directory exclusive temp, fsync, atomic rename, and readback. New publication creates the target directory only after absence proof and uses a same-directory verified temp plus create-exclusive hard link; there is no overwrite-capable fallback.

Undo uses the same target lease and requires the current skill hash to equal the recorded applied hash. Existing Undo restores the exact global snapshot through a same-directory temp, rename, fsync, and readback. New-skill Undo unlinks only that exact hash-proven plugin-created file and removes its direct directory only when empty. Recovery revalidates authority before an unpublished mutation, reuses only a name- and hash-proven temp, completes bookkeeping from exact published/readback disk proof, and rolls back only bytes proven to belong to the plugin transaction. The stored `GlobalDecisionOutcome` makes an identical retry idempotent; reusing its nonce for a different edge remains a replay failure.

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

Consent is operator authority only. `evaluateV3ConsentTransition` defines immediate effects:

- revoke `passiveCalls`: stop passive analysis;
- revoke `durableObservations`: stop new durable evidence/contributions, invalidate dependent support, block Apply;
- revoke `sanitizedExcerpts`: delete project capsules, stop contributions, invalidate dependent support, block Apply;
- revoke `crossRepoAggregation`: stop contributions, invalidate dependent support, block Apply.

Existing recommendations may remain visible, exportable, and rejectable after revocation, but cannot Apply when required consent/support is absent.

Capsule deletion is part of settings-transaction recovery and precedes transaction-marker removal. The project-local `getEvidenceCapsuleSupport` query returns only availability plus an opaque capsule ID when available, or a bounded unavailable reason after denial, expiry, deletion, or revocation. That signal is the handoff for contribution/support children; capsule IDs, incident IDs, summaries, and deletion results are not written to global durable state.

### 11.2 Exact defaults

`V3_RETENTION_DEFAULTS` and `makeV3RetentionPolicy` fix:

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

Purge-all requires exact `PURGE ALL SELF-EVOLVE 0.3.0` confirmation and the state sequence:

```text
requested -> accepted -> authority-stopped -> deleting -> completed
```

`accepted` means the authenticated accepted-terminal response is published. The system then stops admission/timers/authority before deletion. It remains terminal until a fresh process restart and cannot recreate state during shutdown.

Exports preserve the same partition/global separation, include only the acting project's private partition, wrap its capsules as `sensitive-evidence-capsule`, mark content/snapshot data sensitive, omit raw prohibited data and operational secrets, and never infer contributor identity from global records. The `global-recommendations` scope excludes project evidence, global settings, contributions, and aggregates. Global export members contain neither capsules nor capsule IDs.

## 12. Exact Pure Schema Interface

All constructors reject unknown fields, invalid types, invalid bounds, stale deterministic IDs/hashes, and non-increasing timestamps. Returned records are deeply frozen.

| Domain | Exact schema/constructor |
|---|---|
| Project analysis | `ProjectAnalysisSettings`, `makeProjectAnalysisSettings`, `transitionProjectAnalysisSettings`, `resolveProjectAnalysisMode`, `resolveProjectOperationalState` |
| Root authority | `makeApprovedGlobalRoot`, `makeGlobalRootPolicy`, `makeCandidateTargetBinding`, `makeRecommendationTargetBinding` |
| Local evidence | `EvidenceDomain`, `makeEvidenceDomain`, `EvidenceCapsule`, `makeEvidenceCapsule` |
| Publication | `ContributionIntent`, `transitionContributionIntent`, `ProjectContributionLink`, `GlobalContribution` |
| Candidate/support | `GlobalSupportSet`, `GlobalCandidate`, `evaluateGlobalSupportEligibility`, `transitionGlobalCandidate` |
| Recommendation | `GlobalRecommendation`, `GlobalRecommendationContent`, `GlobalDecision`, `transitionGlobalRecommendation` |
| Coordination | `GlobalSynthesisAttempt`, `GlobalLease`, their transition functions, `globalTargetLeaseKey` |
| Protocol/authority | `GlobalActionRequest`, `GlobalConsumerClaim`, `validateGlobalActionAuthority`, `evaluateGlobalWriteAuthority`, `GlobalAuditEvent` |
| Lifecycle | `V3RetentionPolicy`, `makeV3RetentionPolicy`, `V3PurgeOperation`, `transitionV3PurgeOperation`, `evaluateV3ConsentTransition` |
| Identity firewall | `assertGlobalIdentitySafe`, `asOpaqueRandomId` |

Legacy v0.2 schemas remain compatibility interfaces until the cutover slice removes writable callers. Their presence does not grant v0.3 authority.

## 13. Permanent Prohibitions

No mode, configuration, model result, protocol fallback, allowlist, or migration may permit:

1. repo-local autonomous targeting or writes;
2. unattended global Apply or Undo;
3. model-selected roots, consent, mode, retention/purge authority, or write authority;
4. global persistence of project/worktree/source-domain/evidence-domain/capsule/cluster/observation/session/local-incident identifiers or identity-derived hashes;
5. raw transcripts, complete message bodies, raw host IDs, complete prompts, or durable capsule text in global state;
6. passive `chat.message` registration;
7. provider/session reads or durable effects from a preboot or Manual lifecycle event;
8. implementation, shell, or Git agents;
9. Git mutation, publication, external-tracker mutation, or external-system writes;
10. prompt/message injection into a working session, `client.session.promptAsync`, `client.tui.appendPrompt`, or the working agent's question tool;
11. writes outside exact approved global roots by the sole transactional applier;
12. mixed writable v0.2/v0.3 authority.

## 14. Preserved Package Invariants

- `self-evolve.js` exports only `default SelfEvolvePlugin`.
- One module-level `const registry = createRegistry()` owns legacy session-local state and is never reassigned.
- The package root/server graph imports neither `./tui` nor `@opentui/*`; target-exclusive TUI code remains reachable only from `./tui`.
- Durable global-first records never enter the legacy module registry.
- No ordinary runtime dependency is added.
