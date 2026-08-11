# ADR-0004: Explicit-Only Global Writes

**Status:** Accepted for v0.3.

Every global Apply and Undo requires a fresh operator decision bound to recommendation/version, immutable support set, approved target/root, current or `must-not-exist` target hash, proposed content hash, one-use nonce, grant, and expiry. Project analysis mode never grants write authority, and legacy `yolo` narrows to `auto` with no unattended authority. The trade-off is mandatory interaction for every write in exchange for a single auditable authority model that remains safe across projects and processes.
