# DSH × Codex Bridge Plugin

This Codex plugin contributes the `delegate-to-dsh` skill and launches the local `codex-bridge` DSH profile as a STDIO MCP server.

In a Codex task, a conversational request such as `Use DSH for this` or `使用 DSH 处理` is enough. The skill discovers eligible Profiles, chooses single or multi Agent from the task structure, and returns the DSH patch and execution evidence for Codex review. Explicit single/multi choices always override automatic routing.

Install the repository marketplace and plugin with the root CLI:

```bash
pnpm install
pnpm install:local
```

Start a new Codex task after installation. Each target project must contain a validated `bridge.yaml`; run `dsh-bridge init` in that Git project when needed.
