# Changelog

All notable public changes to `@mcrescenzo/opencode-self-evolve` will be
recorded here.

This project follows semantic versioning after the first public release.

## 0.1.0 - Unreleased

- Initial public package metadata for the manual self-evolve opencode plugin.
- Manual scan command with hidden analyzer session, transcript redaction, proposal validation, deterministic advisory output, and optional TUI toast.
- Session-local in-memory controls for status, pause, resume, disable, and dismiss.
- Fixed a module-level registry reassignment bug where a second plugin factory instantiation (opencode's documented double-instantiation) would silently discard all in-memory session state; the registry is now created once and never reassigned.
