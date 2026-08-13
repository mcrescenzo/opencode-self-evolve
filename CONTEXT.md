# Self-Evolve Autonomy

This glossary defines the durable v0.4 binary-automation language. The normative behavior and schema mapping are in `docs/autonomy-contract.md`.

## Language

**Project partition**:
The state-root directory that isolates one checkout or worktree's settings, observations, capsules, contribution intents, and contribution links.
_Avoid_: repository state, global project

**Automatic recommendations**:
The state-root-global operator preference that is exactly On or Off. On permits future eligible automatic evidence and recommendation work only when all required data permissions and operational gates pass; it never grants file-write authority.
_Avoid_: Full Auto, Auto mode, global mode, project analysis mode, on demand

**Automation epoch**:
The root-global generation that advances exactly once for every accepted Automatic recommendations transition and every required-permission revocation. It fences automatic work without replacing the separate terminal-root or circuit-breaker epochs.
_Avoid_: mode version, pause generation, root epoch

**Required data permissions**:
The inseparable automation bundle of durable observations, sanitized excerpts, and cross-project aggregation. Turning Automatic recommendations On enables all three; revoking any one turns automation Off, while restoring one never turns it back On.
_Avoid_: passive consent, background-analysis consent

**Operational suppressor**:
A fail-closed condition such as unvalidated boot, Emergency Stop, project exclusion, corruption, unsupported host, exhausted budget, quiet period, or an open circuit breaker. It can prevent automatic work without rewriting the Automatic recommendations preference.
_Avoid_: effective mode, forced Off, pause

**Host-global skill source**:
A local global skill collection identified by OpenCode's global-only path, configuration, and resolved-skill projections and accepted only when those projections agree. Project, remote, embedded, cache, ambiguous, or malformed sources are not host-global.
_Avoid_: approved update root, inferred global folder, project skill path

**Host-global existing skill**:
One uniquely resolved existing local skill from a Host-global skill source, bound to its canonical source, precedence, logical name, path, and current content generation. It needs no Self-Evolve root setup.
_Avoid_: allowlisted existing skill, project target, cached skill

**Explicit creation root**:
The operator-selected canonical global skill collection used only to place a new skill. Host-global existing-skill discovery does not require it. See [ADR-0006](docs/adr/0006-host-authoritative-existing-skill-discovery.md).
_Avoid_: approved update root, default output folder, model-selected root

**Evidence domain**:
A project-local independence identity derived from canonical source lineage when that lineage is known. It is never persisted in global records.
_Avoid_: project ID, worktree ID, contributor ID

**Local unknown domain**:
The one conservative project-local evidence domain used for every unavailable, ambiguous, or no-remote source lineage. It can use only the complete single-domain eligibility route and never contributes a distributed-domain or distributed-incident count.
_Avoid_: anonymous global domain, inferred source

**Evidence capsule**:
A consented project-local record linking one local incident to one bounded, heuristically scrubbed summary. Capsules and their IDs never enter global durable state. See [ADR-0002](docs/adr/0002-project-local-evidence-global-recommendations.md).
_Avoid_: global excerpt, transcript snippet

**Contribution intent**:
A project-local transaction record that allocates one opaque random contribution ID and retains its private incident, capsule, cluster, and evidence-domain linkage across retries.
_Avoid_: aggregate claim, incident hash

**Global contribution**:
An immutable identity-free global record keyed by an opaque random contribution ID. It contains only bounded claim metadata, counts, coarse dates, and retention timestamps.
_Avoid_: project contribution, provenance record

**Global candidate**:
A state-root-global materialization of one safe pattern plus deterministic approved-global target binding and identity-free support counts.
_Avoid_: project proposal, evidence cluster

**Support set**:
An immutable, content-addressed identity-free snapshot of the exact opaque contribution IDs, strongest single-domain metrics, distributed metrics, integrity gates, target binding, coarse dates, and the retention window used for one candidate decision. Opaque random contribution IDs reveal no contributor; project-local join keys remain prohibited.
_Avoid_: contributor list, project support

**Global recommendation**:
A state-root-global, identity-free reviewed skill change bound to one candidate, immutable support set, approved target, proposed content hash, and explicit decision lifecycle. See [ADR-0002](docs/adr/0002-project-local-evidence-global-recommendations.md).
_Avoid_: project proposal, repository recommendation

**Acting project**:
The project whose live TUI health and grant authorize a short-lived global action request. Its fingerprint is bridge metadata only and never enters durable global recommendation or audit content.
_Avoid_: source project, recommendation owner

**Consumer integration**:
The live server integration that leases and processes a global action request. It may belong to a different project from the acting project and records its operational identity separately.
_Avoid_: acting project runtime, source runtime

**Explicit global write**:
An Apply or Undo authorized by a fresh operator action bound to source/root, target, recommendation version, support set, content hashes, nonce, and expiry. Automatic recommendations never grants this authority. See [ADR-0004](docs/adr/0004-explicit-only-global-writes.md).
_Avoid_: auto-apply, automatic write, Yolo apply
