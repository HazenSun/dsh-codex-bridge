# DSH × Codex Bridge Plugin

This Codex plugin contributes `setup-dsh-bridge` and `delegate-to-dsh`, then launches the local `codex-bridge` DSH profile as a STDIO MCP server. Setup tools remain available even when the target project does not yet have a valid `bridge.yaml`.

In a Codex task, a conversational request such as `Use DSH for this` or `使用 DSH 处理` is enough. The skill discovers eligible Profiles, chooses single or multi Agent from the task structure, and returns the DSH patch and execution evidence for Codex review. Explicit single/multi choices always override automatic routing.

Install the repository marketplace and plugin with the root CLI:

```bash
pnpm install
pnpm build
pnpm dsh-bridge setup --project /absolute/path/to/project --source . --dry-run
pnpm dsh-bridge setup --project /absolute/path/to/project --source .
```

Start a new Codex task after installation and say `Set up DSH Bridge for this project. Preview every change before writing.` Codex discovers only DSH-exposed Provider/Model IDs. The initial config uses a reviewed `setup` command; later model/Profile changes use preview, approval, SHA-256 revision protection, atomic writes, and rollback backups. Provider credentials stay in DSH.
