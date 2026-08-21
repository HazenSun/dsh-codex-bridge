# Changelog

All notable changes to this project are documented here. The project follows Semantic Versioning while public package publication remains in Alpha.

## 0.1.0-alpha.2 - 2026-08-21

### Added

- Guided setup mode that remains available before `bridge.yaml` is valid, with redacted status and live DSH Provider/Model discovery.
- Codex setup Skill plus conversational model discovery, Profile creation, route updates, default switching, removal, and rollback.
- Five versioned setup MCP tools and generated JSON Schemas.
- Semantic Profile diffs, SHA-256 optimistic concurrency, cross-process write locks, atomic `0600` writes, bounded backups, and guarded rollback.
- Reproducible setup-lifecycle E2E covering discovery, preview/apply, stale-revision rejection, restart, a real Kimi call, worktree isolation, and rollback.

### Changed

- `setup` is the recommended source-install entry and never guesses a Provider/Model; bare `init` now requires an explicit DSH route.
- CLI Profile writes use the same live DSH validation and MCP control plane as Codex.
- Configured dormant DSH providers are discovered through DSH settings/directory APIs without returning credential values.
- The installer preserves DSH composition overrides, backs up replaced managed files, and writes Native Shell agents to the requested project.
- Boundary errors and `config show --redacted` now fail closed or omit extensible metadata instead of exposing unchecked values.

### Known limitations

- Source-only distribution; npm packages and the public Codex Plugin Directory entry are not published.
- Initial `bridge.yaml` creation is previewed as an exact CLI setup plan; revision-based MCP mutation starts after the file exists.
- A Profile change requires a fresh Codex task/MCP process before runtime delegation sees the new configuration.
- Git isolated Worktree remains the only writable task backend.

## 0.1.0-alpha.1 - 2026-08-21

### Added

- Local Codex Plugin and DSH Profile installation from source.
- Versioned MCP task, profile, result, delegation, and artifact schemas.
- Automatic single/multi-Agent routing with auditable runtime subagent evidence.
- Durable task lifecycle with continuation, cancellation, timeout, and startup reconciliation.
- Isolated Git Worktrees and content-addressed, redacted Artifact storage.
- Real DSH E2E evidence for DeepSeek V4 Flash, Kimi 2.7 Code, concurrent routing, internal subagents, same-session continuation, and cancellation.
- Chinese installation, usage, configuration, architecture, security, troubleshooting, and contributor documentation.

### Known limitations

- Source-only distribution; npm packages and the public Codex Plugin Directory entry are not published.
- Git isolated Worktree is the only writable backend.
- Some declared execution-policy fields are not yet fully enforced by Bridge-side executors.
- Child role-to-model enforcement is not yet a stable cross-provider contract.
