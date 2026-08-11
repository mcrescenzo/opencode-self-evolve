# ADR-0003: Always-Installed Inert Lifecycle Hook

**Status:** Accepted for v0.3.

Every durable plugin instance returns exactly one lifecycle `event` hook regardless of persisted project analysis mode. Before validated boot and whenever configured mode is `manual`, that handler returns before lineage hydration, session/message reads, provider calls, durable observation, contribution, or scheduler admission; passive `chat.message` remains prohibited. The stable hook shape enables immediate Manual/Auto changes without restart, while the early return preserves Manual's zero-passive-effect guarantee.
