# Security Policy

## Reporting

Report security issues privately through GitHub Security Advisories for `mcrescenzo/opencode-self-evolve`. Do not open a public issue for an undisclosed vulnerability. Never include live secrets; use synthetic values that preserve the relevant token shape.

Relevant reports include privacy-boundary bypasses, analyzer isolation failures, unsafe path handling, stale-hash or symlink bypasses, unauthorized application, audit/rollback defects, synthetic transcript injection, and unexpected external mutation.

## Privacy Classes

- Complete transcripts and raw message bodies are never stored.
- Deterministic receipts and typed observations are stored without raw text.
- Sanitized evidence excerpts require separate explicit consent, are length-bounded, and have a short lifetime.
- Skill hashes are durable. Diffs exist only while a proposal is open and are replaced by hashes when it closes.
- Proposal, decision, audit, and aggregate records are durable within configured retention.

Redaction is defensive, not a secrecy guarantee. Users should not scan material that must never reach their configured model provider.

## Applier Boundary

The applier is the only code path authorized to write skill files. Every target must be contained by an explicit canonical absolute-root allowlist. Existing edits are bound to the exact approved current hash; new files use create-exclusive semantics. Symlinks anywhere in the path are rejected. Writes use a same-directory temporary file, atomic rename, exact readback hashing, an append-only audit record, and rollback guarded by `currentHash == appliedHash`. Scope ambiguity, stale hashes, privacy or injection flags, lease conflicts, missing allowlists, secret canaries, growth limits, audit failure, and rollback uncertainty all fail closed.

## Permanent Prohibitions

No mode, consent, or allowlist can permit:

1. Spawning implementation, shell, or Git agents.
2. Git commits, pushes, publication, or external-tracker mutation.
3. `client.session.promptAsync` or `client.tui.appendPrompt`.
4. Synthetic messages in the working-session transcript.
5. Invoking the working agent's question tool from the server plugin.
6. Persisting complete transcripts or raw message bodies.
7. Applier access outside the canonical allowlist.
8. Model-authored scope, retention, budget, consent, or apply decisions.
9. Silently rewriting the stored mode when a kill switch fires.

## Emergency Stop

Set `SELF_EVOLVE_KILL=1` before startup for a process-local fail-closed downgrade, or run `/self-evolve kill-switch on` for the durable switch. A kill switch prevents autonomous application without silently changing the user's stored mode preference, and the downgrade is audited.
