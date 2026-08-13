# ADR-0006: Host-Authoritative Existing-Skill Discovery

**Status:** Accepted for v0.4.

Existing-skill recommendations use a read-only catalog derived from the OpenCode host's global-only path, configuration, and resolved-skill projections; Self-Evolve accepts a target only when those projections agree on one canonical local global skill. Project, remote, embedded, cache, ambiguous, symlinked, malformed, or drifted sources fail closed. Existing skills therefore need no Self-Evolve root setup, while new-skill creation still requires one explicit operator-selected creation root. This adds a bounded host adapter and provenance receipts in exchange for removing redundant update-root configuration without weakening path or write authority.
