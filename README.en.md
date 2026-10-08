# DSH × Codex Bridge

> Connect Codex's planning and review loop to DeepSeek Harness execution agents.

[中文](README.md) · [Installation](docs/installation.md) · [Usage](docs/usage.md) · [Architecture](docs/architecture.md)

DSH Codex Bridge is local-first agent infrastructure. Codex decides what to delegate and reviews the evidence. DeepSeek Harness runs the selected provider/model, tools, and internal subagents. The Bridge owns the versioned protocol, isolated Git worktrees, durable task lifecycle, cancellation, continuation, and content-addressed artifacts.

## Status

- Version: `0.1.0-alpha.3`
- Pinned DSH target: npm `0.2.0-rc.2`
- Distribution: source install only
- Verification: see the [compatibility matrix](docs/compatibility.md); rc.8 model evidence is historical
- License: Apache-2.0

This project does not turn DSH into a native Codex model. Direct Mode exposes DSH as an external worker over local STDIO MCP. Native Shell Mode optionally adds a narrow Codex orchestration agent for thread visibility.

## Ask Codex to install and configure

Replace the three absolute paths and send this to a Codex task with file and terminal access:

```text
Install DSH × Codex Bridge from https://github.com/HazenSun/dsh-codex-bridge.
Target Git project: /absolute/path/to/your-project
Bridge source directory: /absolute/path/to/dsh-codex-bridge
Dedicated DSH install directory: /absolute/path/to/dsh-bridge-runtime

Check prerequisites and show the plan, then build the Bridge, install official DSH 0.2.0-rc.2 and the local plugins.
Pass --dsh-bin during setup, save the dedicated runtime and register the local MCP server.
Back up an existing DSH Home before first use, or validate with a separate DSH_HOME first.
Discover exact Provider/Model IDs visible to codex-bridge, preview the configuration, and create default-code.
Guide me to configure missing credentials in DSH, then run doctor and configuration validation.
Do not run a real model task during installation. Tell me if I need to start a new Codex task.
```

Codex can run the installation and manage Bridge Profiles. Account login and missing Provider credentials still need to be completed in DSH.

## Manual source setup

Prerequisites: Node.js `^22.19.0` or `>=24.0.0`, pnpm `11.19.0`, Git, and Codex CLI/Desktop with local Plugin/STDIO MCP support.

```bash
git clone https://github.com/HazenSun/dsh-codex-bridge.git
cd dsh-codex-bridge
corepack enable
pnpm install --frozen-lockfile
pnpm build

BRIDGE_RUNTIME=/absolute/path/to/dsh-bridge-runtime
npm install --prefix "$BRIDGE_RUNTIME" --no-audit --no-fund @deepseek-ai/dsh@0.2.0-rc.2
export DSH_BRIDGE_DSH_BIN="$BRIDGE_RUNTIME/node_modules/.bin/dsh"
"$DSH_BRIDGE_DSH_BIN" --version

BRIDGE_PROJECT=/absolute/path/to/your-git-project
pnpm dsh-bridge setup --project "$BRIDGE_PROJECT" --source . \
  --dsh-bin "$DSH_BRIDGE_DSH_BIN" --dry-run
pnpm dsh-bridge setup --project "$BRIDGE_PROJECT" --source . \
  --dsh-bin "$DSH_BRIDGE_DSH_BIN"
```

`setup` installs the DSH Profile and Codex Plugin and saves the executable and DSH Home to `dsh-codex-bridge/runtime.json` under Codex Home. Desktop's MCP launcher reads this saved configuration; it does not need to inherit your terminal's `export`. DSH 0.2 may migrate an older `settings.yaml` on first startup, so back up the existing Home or validate with a separate Home first.

The installer also uses the official `codex mcp add` command to register explicit Node, launcher and configuration paths. It does not depend on plugin JSON variable expansion. Installing the marketplace Skill plugin alone does not configure the local runtime; run `setup` for first use.

Keep the Bridge source and dedicated DSH directories: the registered launcher depends on them. With a custom `CODEX_HOME`, run setup and MCP checks against that same Home. To change Desktop's DSH executable or Home, rerun `setup` to save the choice; terminal exports alone only change the CLI environment. Disabling the Skill plugin does not remove the registered MCP server. When all Bridge projects have stopped using it, run `codex mcp remove dsh-codex-bridge` in the same Codex Home before removing dedicated runtime files.

Without `bridge.yaml`, setup stops at `needs_execution_profile`. Use the plugin's Setup entry or open a new Codex task and say:

```text
Set up DSH Bridge for this project. Preview every configuration change before writing.
```

Codex discovers Provider/Model IDs visible to the DSH `codex-bridge` Profile and proposes a named Bridge Profile. For the first file it shows the exact `setup` plan before execution; after `bridge.yaml` exists, Profile writes use a semantic diff and revision protection. If another Profile in the same DSH Home already has model settings, `models sync --from-profile web` can preview copying supported Provider settings and credential references into `codex-bridge`. Credentials remain in DSH. See [Installation](docs/installation.md) for the reviewed sync step, migration and runtime paths.

After setup, say:

```text
Use DSH for this task and decide whether a single or multi-agent run is appropriate.
```

Codex discovers eligible Profiles, records its routing decision, delegates into an isolated worktree, and reviews the returned patch and runtime evidence.

## Manage models from Codex

Make the Provider/Model visible to the DSH `codex-bridge` Profile, then map it to a named Bridge Profile. Existing settings in `web` can be reused through reviewed model sync; a new Provider protocol still requires a DSH Adapter. Example prompts:

```text
Show the DSH models available to this project.
Add my selected Provider/Model from the live directory as fast-code. Preview first.
Make fast-code the default Profile for this project after I approve the diff.
Roll back the latest Bridge model configuration change.
```

Every write uses a reviewed preview, an expected SHA-256 configuration revision, an atomic `0600` write, and a bounded rollback backup. CLI equivalents:

```bash
pnpm dsh-bridge models list --config "$BRIDGE_PROJECT/bridge.yaml" --details
# Replace these values with exact IDs from discovery.
DSH_PROVIDER_ID='returned-provider-id'
DSH_MODEL_ID='returned-model-id'
pnpm dsh-bridge profiles add fast-code \
  --config "$BRIDGE_PROJECT/bridge.yaml" \
  --provider "$DSH_PROVIDER_ID" --model "$DSH_MODEL_ID"
# Review before_revision, then repeat with:
# --apply --expected-revision <before_revision>

# Set the variables to the newly selected route before updating.
pnpm dsh-bridge profiles update fast-code \
  --config "$BRIDGE_PROJECT/bridge.yaml" \
  --provider "$DSH_PROVIDER_ID" --model "$DSH_MODEL_ID"
# Preview first; repeat with --apply and its exact before_revision.
```

Configuration changes do not alter an active turn or recorded history. Start a new Codex task when the tool returns `restart_required: true`: new tasks and continued runs after MCP restart use the current Profile. An existing Session can only resume with its recorded Agent Preset.

Only set `--reasoning-effort` to an effort advertised by the selected model. Model discovery does not prove account access or successful generation. Profile changes affect this project's `bridge.yaml`, not the DSH global default or other projects.

Updating a model without a reasoning option preserves the old value. To use the new model's default, add `--clear-reasoning-effort` to `profiles update`, preview, then apply with the returned revision. It is mutually exclusive with `--reasoning-effort`. The saved runtime configuration is shared by Bridge tasks under the same Codex Home.

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

`pnpm verify` runs local checks. E2E suites use temporary Git fixtures and real providers, and may incur model charges. Select exact routes with `DSH_BRIDGE_E2E_PROVIDER`, `DSH_BRIDGE_E2E_MODEL` and an optional advertised `DSH_BRIDGE_E2E_EFFORT`; the model matrix also accepts a second route. Logs default to outside the repository. See [Getting Started](docs/getting-started.md#8-真实-dsh-闭环验证) for parameters. Retained evidence under [`tests/e2e/evidence`](tests/e2e/evidence/) records DSH rc.8; see the [compatibility matrix](docs/compatibility.md) for Alpha 3 results.

## Current limits

- npm packages and the public Codex Plugin Directory release are not published yet.
- Source installation uses local STDIO MCP and does not require a public HTTPS service.
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
