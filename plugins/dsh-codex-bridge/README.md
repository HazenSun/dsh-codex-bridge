# DSH × Codex Bridge Plugin

This Codex plugin contributes `setup-dsh-bridge` and `delegate-to-dsh`. The source installer separately registers a local STDIO MCP through the official `codex mcp add` command, using explicit Node, launcher and runtime-configuration paths. No plugin JSON path-template expansion is required. Setup tools remain available even when the target project does not yet have a valid `bridge.yaml`.

In a Codex task, a conversational request such as `Use DSH for this` or `使用 DSH 处理` is enough. The skill discovers eligible Profiles, chooses single or multi Agent from the task structure, and returns the DSH patch and execution evidence for Codex review. Explicit single/multi choices always override automatic routing.

Alpha 3 requires the exact DSH `0.2.0-rc.2` runtime. Use a dedicated installation instead of replacing another project's DSH; select its Home deliberately before installation. Follow the [source installation guide](../../docs/installation.md) to install prerequisites and configure credentials inside DSH.

From the built source checkout, install the repository marketplace and plugin with the root CLI:

```bash
pnpm dsh-bridge setup --project /absolute/path/to/project --source . \
  --dsh-bin /absolute/path/to/dsh-bridge-runtime/node_modules/.bin/dsh --dry-run
pnpm dsh-bridge setup --project /absolute/path/to/project --source . \
  --dsh-bin /absolute/path/to/dsh-bridge-runtime/node_modules/.bin/dsh
```

Start a new Codex task after installation and say `Set up DSH Bridge for this project. Preview every change before writing.` Codex discovers only DSH-exposed Provider/Model IDs. The initial config uses a reviewed `setup` command; later model/Profile changes use preview, approval, SHA-256 revision protection, atomic writes, and rollback backups. Provider credentials stay in DSH.

The installer saves the executable and DSH Home in the selected Codex Home's `dsh-codex-bridge/runtime.json`; the packaged MCP launcher reads it even when Desktop did not inherit terminal exports. Keep that runtime, Home and source checkout available. Installation/discovery do not generate model responses; approve any real test separately.

Use `codex mcp get dsh-codex-bridge --json` to inspect the registration. Disabling this Skill plugin does not remove the separately registered MCP; after confirming no other Bridge project needs it, remove it with `codex mcp remove dsh-codex-bridge`.
