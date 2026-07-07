# Security Policy

## Reporting

Please report security issues privately through the GitHub Security Advisory flow for `mcrescenzo/opencode-self-evolve`.

Do not include live secrets in reports. If a redaction bypass involves credentials, use synthetic examples that preserve the token shape without exposing a real value.

## Scope

Relevant issues include transcript redaction bypasses, unexpected active-session model turns, analyzer isolation failures, or behavior that mutates files or external systems without explicit user action.

This plugin sends a bounded, redacted recent-session transcript to the configured model provider only after a manual `/self-evolve` scan.
