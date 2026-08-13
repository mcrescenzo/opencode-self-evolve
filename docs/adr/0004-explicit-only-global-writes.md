# ADR-0004: Explicit-Only Global Writes

**Status:** Accepted for v0.4.

Every global Apply and Undo requires a fresh operator decision bound to recommendation/version, immutable support set, host-discovered existing target or explicit creation root, current or `must-not-exist` target hash, proposed content hash, one-use nonce, grant, and expiry. Automatic recommendations On never grants write authority, and Off does not by itself suppress an otherwise valid explicit action. The trade-off is mandatory interaction for every write in exchange for one auditable authority model that remains safe across projects and processes.
