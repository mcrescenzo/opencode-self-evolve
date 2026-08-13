# ADR-0003: Always-Installed Inert Lifecycle Hook

**Status:** Superseded by [ADR-0005](0005-binary-automatic-recommendations.md).

Every durable plugin instance returns exactly one lifecycle `event` hook. v0.3 made that hook inert for Manual mode; v0.4 retains the stable hook shape but makes Automatic recommendations Off the single preference gate. Before validated boot or while Off, the handler returns before lineage hydration, session/message reads, provider calls, durable observation, contribution, or scheduler admission; passive `chat.message` remains prohibited.
