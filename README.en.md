# DSH × Codex Bridge

> Connect Codex's planning and review loop to DeepSeek Harness execution agents.

[中文](README.md) · [Installation](docs/installation.md) · [Usage](docs/usage.md) · [Architecture](docs/architecture.md)

DSH Codex Bridge is local-first agent infrastructure. Codex decides what to delegate and reviews the evidence. DeepSeek Harness runs the selected provider/model, tools, and internal subagents. The Bridge owns the versioned protocol, isolated Git worktrees, durable task lifecycle, cancellation, continuation, and content-addressed artifacts.

## Status

- Version: `0.1.0-alpha.2`
- DSH compatibility baseline: `0.1.0-rc.8`
- Distribution: source install only
- Verified: macOS arm64 with real Kimi 2.7 Code and DeepSeek V4 Flash provider calls
- License: Apache-2.0

This project does not turn DSH into a native Codex model. Direct Mode exposes DSH as an external worker over local STDIO MCP. Native Shell Mode optionally adds a narrow Codex orchestration agent for thread visibility.

## Three-minute source setup

Prerequisites: Node.js `22.19+` or `24+`, pnpm, Git, DSH `0.1.0-rc.8`, Codex CLI/Desktop, and a provider already configured in DSH.

```bash
git clone https://github.com/HazenSun/dsh-codex-bridge.git
cd dsh-codex-bridge
corepack enable
pnpm install --frozen-lockfile
pnpm build

BRIDGE_PROJECT=/absolute/path/to/your-git-project
pnpm dsh-bridge setup --project "$BRIDGE_PROJECT" --source . --dry-run
pnpm dsh-bridge setup --project "$BRIDGE_PROJECT" --source .
```

The second command installs the DSH Profile and Codex Plugin. When no execution Profile has been selected, it stops safely at `needs_execution_profile` instead of guessing a model. Open a new Codex task and say:

```text
Set up DSH Bridge for this project. Preview every configuration change before writing.
```

Codex discovers live DSH Provider/Model IDs and proposes a semantic Bridge Profile. For the first file it shows the exact `setup` plan before execution; after `bridge.yaml` exists, every Profile write uses a semantic diff and explicit approval. Provider credentials remain in DSH.

After setup, say:

```text
Use DSH for this task and decide whether a single or multi-agent run is appropriate.
```

Codex discovers eligible Profiles, records its routing decision, delegates into an isolated worktree, and reviews the returned patch and runtime evidence.

## Manage models from Codex

Adding the Provider/Model to DSH supplies the low-level model support. To make it safely routable from Codex, map it to a named Bridge Profile. Example prompts:

```text
Show the DSH models available to this project.
Add kimi-k2.7-code as a fast-code Profile. Preview only.
Make deepseek-v4-flash the default after I approve the diff.
Roll back the latest Bridge model configuration change.
```

Every write uses a reviewed preview, an expected SHA-256 configuration revision, an atomic `0600` write, and a bounded rollback backup. CLI equivalents:

```bash
pnpm dsh-bridge models list --config "$BRIDGE_PROJECT/bridge.yaml" --details
pnpm dsh-bridge profiles add fast-code \
  --config "$BRIDGE_PROJECT/bridge.yaml" \
  --provider <provider-id> --model <model-id>
# Review before_revision, then repeat with:
# --apply --expected-revision <before_revision>

pnpm dsh-bridge profiles update fast-code \
  --config "$BRIDGE_PROJECT/bridge.yaml" \
  --provider <provider-id> --model <new-model-id>
# Preview first; repeat with --apply and its exact before_revision.
```

Configuration changes affect subsequent tasks. Start a new Codex task when the tool returns `restart_required: true`.

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
- guided first-use setup and revision-protected Profile changes

## Verification

```bash
pnpm verify
pnpm test:e2e:dsh
pnpm test:e2e:model-matrix
pnpm test:e2e:setup
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
