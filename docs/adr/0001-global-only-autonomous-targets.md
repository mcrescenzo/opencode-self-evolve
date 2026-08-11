# ADR-0001: Global-Only Autonomous Targets

**Status:** Accepted for v0.3.

Autonomous inventory and writes target only exact operator-approved global skill-collection roots. Existing skills require an update-capable approved root; new skills require the one explicit primary creation root and `must-not-exist` publication semantics. Project-local `.opencode/skills` remain outside autonomous target scope. This sacrifices repository-specific autonomous edits in exchange for one reusable global skill catalog, deterministic root authority, and no model-selected filesystem destination.
