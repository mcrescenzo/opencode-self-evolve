# Self-Evolve Autonomy

This glossary defines the durable v0.3 global-first language. The normative behavior and schema mapping are in `docs/autonomy-contract.md`.

## Language

**Project partition**:
The state-root directory that isolates one checkout or worktree's settings, observations, capsules, contribution intents, and contribution links.
_Avoid_: repository state, global project

**Project analysis mode**:
The configured `manual` or `auto` policy for admitting passive analysis from one project partition. It does not grant skill-write authority.
_Avoid_: global mode, repository mode, Yolo mode

**Project analysis override**:
The project value `inherit`, `manual`, or `auto` that resolves against the installation's default project analysis mode.
_Avoid_: repo mode, target mode

**Operational suppressor**:
A temporary fail-closed condition such as unvalidated boot, pause, kill switch, exclusion, corruption, unsupported host, or open circuit breaker. It suppresses passive analysis without changing the configured project analysis mode.
_Avoid_: effective mode, forced Manual

**Approved global root**:
An operator-selected canonical global skill-collection path with explicit update/create capabilities and a path-derived root ID. Autonomous targets never include a project-local skill root. See [ADR-0001](docs/adr/0001-global-only-autonomous-targets.md).
_Avoid_: allowed skill path, repository skill root

**Primary creation root**:
The sole approved global root selected by the operator for new autonomous skill creation. A model may propose a validated logical skill name but cannot select or change this root.
_Avoid_: default output folder, model-selected root

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
An Apply or Undo authorized by a fresh operator action bound to root, target, recommendation version, support set, content hashes, nonce, and expiry. Auto analysis never grants this authority. See [ADR-0004](docs/adr/0004-explicit-only-global-writes.md).
_Avoid_: auto-apply, Yolo apply
