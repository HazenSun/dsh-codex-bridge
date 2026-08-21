# Changelog

All notable changes to this project are documented here. The project follows Semantic Versioning while public package publication remains in Alpha.

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
