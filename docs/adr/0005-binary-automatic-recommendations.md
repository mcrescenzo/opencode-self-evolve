# ADR-0005: Binary Automatic Recommendations

**Status:** Accepted for v0.4.

Self-Evolve has one normal operating preference: Automatic recommendations is On or Off. On atomically enables the three required data permissions but never grants file-write authority; Off advances a separate automation epoch, fences and supersedes unfinished automatic work, preserves published recommendations, and establishes a no-backfill boundary. Manual/on-demand analysis, project modes, ordinary Pause/Resume, separate passive-call consent, and `durableAutonomy: false` are removed. This deliberately trades those overlapping controls for a single comprehensible cross-process authority boundary while preserving project Include/Exclude, Emergency Stop, circuit breaker, privacy controls, and fresh explicit Apply/Reject/Undo.
