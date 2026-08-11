# ADR-0002: Project-Local Evidence and Global Recommendations

**Status:** Accepted for v0.3.

Raw evidence provenance, evidence-domain identities, capsules, contribution intents, and contribution links stay in project partitions; identity-free contributions, candidates, support sets, recommendations, content, decisions, attempts, leases, and audits live in state-root-global domains. Opaque random contribution IDs are the only join across those domains. This permits state-root-wide recommendations and precise project purge while preventing durable global records from identifying a project, worktree, source domain, capsule, cluster, observation, session, or local incident.
