# ADR-0001: Global-Only Autonomous Targets

**Status:** Superseded for existing-skill discovery by [ADR-0006](0006-host-authoritative-existing-skill-discovery.md); retained for explicit new-skill creation.

In v0.3, autonomous inventory and writes targeted only exact operator-approved global skill-collection roots. v0.4 replaces the existing-skill half with host-authoritative global discovery, while new skills still require one explicit creation root and `must-not-exist` publication semantics. Project-local skills remain outside automatic target scope, and a model still cannot choose a filesystem destination.
