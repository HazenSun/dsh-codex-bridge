# Changelog

All notable changes to this project are documented here. The project follows Semantic Versioning while public package publication remains in Alpha.

## 0.1.0-alpha.3 - 2026-10-08

### Added

- `setup/install --dsh-bin` and a saved runtime launcher configuration for a dedicated DSH installation. Codex Desktop can start the selected runtime without inheriting terminal exports.
- Explicit reasoning reset through `profiles update --clear-reasoning-effort` and MCP `update.clear_reasoning_effort`.
- Plugin Setup entry registered through the onboarding Skill extension.
- Explicit local MCP registration through the official Codex CLI, with saved Node/launcher/runtime paths. Legacy plugin JSON path templates and inherited custom Home variables are not relied upon.
- Revision-protected `models sync --from-profile` to reuse supported DSH Provider settings and safe credential references inside `codex-bridge`, without writing project configuration or copying literal credentials.
- Per-task cross-process execution leases, with conservative live-owner handling and generation-guarded dead-owner recovery. A second MCP may read a running task but cannot interrupt it through reconciliation, duplicate its continuation, or claim to cancel another process's execution.
- Session metadata is flushed and its binding is saved before a user turn is submitted, so interruption after creation retains the continuation identity. Work interrupted before any session was created remains explicitly non-continuable.

### Changed

- Updated the DSH integration target from `0.1.0-rc.8` to the npm-published `0.2.0-rc.2`.
- Reworked source-install and first-use documentation around exact DSH model discovery, project-scoped Profile changes, and conversational Codex setup.
- Separated installation and MCP checks from credentialed model execution; retained rc.8 evidence is identified as historical.
- Real E2E routes are configurable through Provider/Model/Reasoning environment variables, and logs default to outside the repository.
- Migrated persistence and delegation evidence to DSH Session V4. Foreground child completion is distinguished from background queue acknowledgements; resumed tasks use the current model selection and report cache-aware token usage.
- Updated the MCP SDK and test/release tooling, with constrained transitive security fixes. The source lockfile audit reported zero advisories on 2026-10-08.
- Added publication-content checks to reject local configuration, private backup manifests, planning notes and new execution logs from release commits. Dependabot keeps contract-sensitive major upgrades out of automatic groups; CodeQL has the permissions needed for analysis uploads.

### Verification and distribution

- Real DeepSeek Flash and Pro (`high`) checks passed for concurrent routing, two completed foreground subagents, Session V4 continuation, cancellation, strict output/artifact verification and setup/rollback. See the [compatibility matrix](docs/compatibility.md) for exact scope.
- Distribution remains source-only. Bridge npm packages and the public Codex Plugin Directory entry are not published.
- Provider/model IDs and reasoning options must come from live DSH discovery. Previously recorded Kimi and DeepSeek routes are not guaranteed to exist in the new directory.

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
