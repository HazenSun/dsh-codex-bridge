# DSH × Codex Bridge

> Connect Codex's planning and review loop to DeepSeek Harness execution agents.

[中文](README.md) · [Installation](docs/installation.md) · [Usage](docs/usage.md) · [Architecture](docs/architecture.md)

DSH Codex Bridge is local-first agent infrastructure. Codex decides what to delegate and reviews the evidence. DeepSeek Harness runs the selected provider/model, tools, and internal subagents. The Bridge owns the versioned protocol, isolated Git worktrees, durable task lifecycle, cancellation, continuation, and content-addressed artifacts.

## Status

- Version: `0.1.0-alpha.1`
- DSH compatibility baseline: `0.1.0-rc.8`
- Distribution: source install only
- Verified: macOS arm64 with real Kimi 2.7 Code and DeepSeek V4 Flash provider calls
- License: Apache-2.0

This project does not turn DSH into a native Codex model. Direct Mode exposes DSH as an external worker over local STDIO MCP. Native Shell Mode optionally adds a narrow Codex orchestration agent for thread visibility.

## Quickstart

Prerequisites: Node.js `22.19+` or `24+`, pnpm, Git, DSH `0.1.0-rc.8`, Codex CLI/Desktop, and a provider already configured in DSH.

```bash
git clone https://github.com/HazenSun/dsh-codex-bridge.git
cd dsh-codex-bridge
corepack enable
pnpm install --frozen-lockfile
pnpm build

BRIDGE_PROJECT=/absolute/path/to/your-git-project
pnpm dsh-bridge init "$BRIDGE_PROJECT" --mode direct
pnpm dsh-bridge install --source . --codex --dsh --mode direct
pnpm dsh-bridge doctor --config "$BRIDGE_PROJECT/bridge.yaml" --json --redacted
```

Open a new Codex task and say:

```text
Use DSH for this task and decide whether a single or multi-agent run is appropriate.
```

Codex discovers eligible Profiles, records its routing decision, delegates into an isolated worktree, and reviews the returned patch and runtime evidence.

## What is implemented

- Codex Plugin with conversational DSH routing
- `auto | single | multi` delegation decisions
- named DSH provider/model Profiles
- real DSH subagent call/completion evidence
- asynchronous, cancellable, resumable tasks
- isolated detached Git worktrees
- patch, Git status, and agent-summary artifacts
- SHA-256 content addressing, pagination, and redaction
- durable JSON task records with startup reconciliation
- CLI initialization, installation, profile inspection, and doctor

## Verification

```bash
pnpm verify
pnpm test:e2e:dsh
pnpm test:e2e:model-matrix
```

The credentialed E2E suites use temporary Git fixtures and real configured providers. Redacted retained evidence is under [`tests/e2e/evidence`](tests/e2e/evidence/).

## Current limits

- npm packages and the public Codex Plugin Directory release are not published yet.
- The writable runtime supports Git isolated worktrees only.
- The Bridge does not auto-commit, merge, deploy, or publish worker output.
- Some declared network/path/file-count/disk policies are not yet fully enforced by Bridge executors.
- Deterministic cross-model work should use separate named Profiles; role-specific child model enforcement is not yet a stable contract.

## Documentation

- [Installation](docs/installation.md)
- [Usage](docs/usage.md)
- [Configuration](docs/configuration.md)
- [Architecture](docs/architecture.md)
- [Security model](docs/security.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Contributing](CONTRIBUTING.md)
- [Security reporting](SECURITY.md)

## License

Apache-2.0. DeepSeek Harness, OpenAI Codex, the MCP SDK, and all other dependencies retain their own licenses and trademarks.
