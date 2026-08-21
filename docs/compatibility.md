# Compatibility matrix

The Bridge uses public Codex plugin/MCP surfaces and a pinned DSH Cordis contract. “Supported” means the listed combination is exercised by build, contract or end-to-end evidence—not merely expected to work.

| Bridge          | DSH          | Node.js   | Codex CLI                      | OS          | Status       | Evidence                                                          |
| --------------- | ------------ | --------- | ------------------------------ | ----------- | ------------ | ----------------------------------------------------------------- |
| `0.1.0-alpha.1` | `0.1.0-rc.8` | `24.19.0` | `0.132.0`                      | macOS arm64 | Verified     | [Real DSH E2E](../tests/e2e/evidence/real-dsh-rc8.json)           |
| `0.1.0-alpha.1` | `0.1.0-rc.8` | `24.19.0` | `0.132.0`                      | macOS arm64 | Model matrix | [Kimi/DeepSeek evidence](../tests/e2e/evidence/model-matrix.json) |
| `0.1.0-alpha.1` | `0.1.0-rc.8` | `22.19+`  | current plugin-capable release | Linux x64   | CI contract  | Profile composition and full non-credentialed verification        |

## Compatibility policy

- DSH is locked to `0.1.0-rc.8`; `latest` is not used because it currently points at a different RC.
- A DSH upgrade requires typecheck, Cordis profile composition, cancellation, Agent lifecycle and credentialed real-model E2E evidence.
- Codex consumes the Bridge only through documented Plugin, Skill and STDIO MCP contracts. DSH is not represented as a replaceable native Codex model.
- Node follows DSH’s runtime floor: `^22.19.0 || >=24.0.0`.
- Windows and remote Streamable HTTP transports are not supported by this alpha.

## Evidence scope

The retained E2E fixtures prove tool discovery, profile routing, task completion, a DSH-authored patch, content hash verification, main-worktree isolation, same-session continuation, cancellation, Kimi/DeepSeek concurrent routing and two completed internal subagent calls. They do not certify every third-party provider or model; each project owner remains responsible for DSH provider configuration and cost controls.
