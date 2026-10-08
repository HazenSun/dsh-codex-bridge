# Compatibility matrix

The Bridge uses public Codex plugin/MCP surfaces and a pinned DSH Cordis contract. The current target is Bridge `0.1.0-alpha.3` with the npm-published DSH `0.2.0-rc.2`. A target version is not verification evidence: the table states what was actually exercised.

## Current release

| Bridge          | DSH          | Check                               | Status | Evidence                                                                                                                                                                                                                            |
| --------------- | ------------ | ----------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0.1.0-alpha.3` | `0.2.0-rc.2` | Build, typecheck and unit contracts | Passed | Node `24.19.0`, macOS arm64; 124 unit tests and 15 script tests, 2026-10-08                                                                                                                                                         |
| `0.1.0-alpha.3` | `0.2.0-rc.2` | Profile composition and STDIO MCP   | Passed | Exact executable/version and live server version checked by all three E2E runners                                                                                                                                                   |
| `0.1.0-alpha.3` | `0.2.0-rc.2` | Native Codex installation           | Passed | Codex CLI `0.156.1`, fresh isolated Codex Home: Setup Skill, official local MCP registration, 13 live tools and `get_setup_status` readback                                                                                         |
| `0.1.0-alpha.3` | `0.2.0-rc.2` | Task ownership and recovery         | Passed | [Lease tests](../packages/task-engine/src/lease.test.ts) and [engine tests](../packages/task-engine/src/index.test.ts): real live/dead child PID, two-engine read/write isolation, exclusive continuation and early session binding |
| `0.1.0-alpha.3` | `0.2.0-rc.2` | Setup and Profile lifecycle         | Passed | [Setup lifecycle runner](../scripts/setup-lifecycle-e2e.mjs): preview, atomic apply, stale-write rejection, restart, real Pro call and exact rollback                                                                               |
| `0.1.0-alpha.3` | `0.2.0-rc.2` | Credentialed model/subagent E2E     | Passed | [Single-task runner](../scripts/real-dsh-e2e.mjs) and [model matrix](../scripts/model-matrix-e2e.mjs), 2026-10-08                                                                                                                   |

The credentialed checks used `deepseek-official/deepseek-flash/high` and `deepseek-official/deepseek-v4-pro/high`. Both exact routes were discovered before execution and read back from Session V4 request headers. The matrix verified overlapping execution windows, two foreground internal subagents with completion events, same-session continuation, an immediate same-key retry returning the original receipt without another run, strict output bytes, artifact digests and unchanged main worktrees. The single-task runner also verified cancellation. No fallback model or reasoning level was used.

Kimi remains configurable, but was **not credentialed or called in the Alpha 3 run**. Discovery alone is not a generation test. These checks do not certify every model in the DSH catalog, Windows, or cloud transports. New execution receipts and machine-specific logs are kept outside the public repository.

The installer registers local MCP using explicit paths through `codex mcp add`; the Skill plugin is separate. The tested legacy plugin JSON did not expand `${PLUGIN_ROOT}` / `${CODEX_HOME}` or forward `env_vars`. The release does not rely on those behaviors. Dependency audit of the source lockfile reported zero advisories on the verification date; this does not audit DSH's independently installed dependency tree or establish sandbox security.

## Historical evidence

The following results apply to their recorded versions only. They do not certify DSH `0.2.0-rc.2`, models returned by a newer directory, or another machine.

| Bridge          | DSH          | Node.js   | Codex CLI                      | OS          | Status       | Evidence                                                             |
| --------------- | ------------ | --------- | ------------------------------ | ----------- | ------------ | -------------------------------------------------------------------- |
| `0.1.0-alpha.2` | `0.1.0-rc.8` | `24.19.0` | `0.132.0`                      | macOS arm64 | Setup E2E    | Recorded setup-lifecycle run on 2026-08-21; local logs not committed |
| `0.1.0-alpha.2` | `0.1.0-rc.8` | `24.19.0` | `0.132.0`                      | macOS arm64 | Model matrix | Recorded model-matrix run on 2026-08-21; local logs not committed    |
| `0.1.0-alpha.2` | `0.1.0-rc.8` | `22.19+`  | current plugin-capable release | Linux x64   | CI contract  | Setup/runtime schemas, Profile composition, and full verification    |
| `0.1.0-alpha.1` | `0.1.0-rc.8` | `24.19.0` | `0.132.0`                      | macOS arm64 | Verified     | [Real DSH E2E](../tests/e2e/evidence/real-dsh-rc8.json)              |
| `0.1.0-alpha.1` | `0.1.0-rc.8` | `24.19.0` | `0.132.0`                      | macOS arm64 | Model matrix | [Kimi/DeepSeek evidence](../tests/e2e/evidence/model-matrix.json)    |
| `0.1.0-alpha.1` | `0.1.0-rc.8` | `22.19+`  | current plugin-capable release | Linux x64   | CI contract  | Profile composition and full non-credentialed verification           |

## Compatibility policy

- DSH is locked to `0.2.0-rc.2` for Alpha 3. Install the exact version; `latest` can change without a Bridge release.
- A DSH upgrade requires typecheck, Cordis profile composition, cancellation, Agent lifecycle and credentialed real-model E2E evidence.
- Codex consumes the Bridge only through documented Plugin, Skill and STDIO MCP contracts. DSH is not represented as a replaceable native Codex model.
- Node follows DSH’s runtime floor: `^22.19.0 || >=24.0.0`.
- Windows and remote Streamable HTTP transports are not supported by this alpha.

## Codex installation contract

The Plugin provides Setup and Delegate Skills. Local MCP is registered separately by `setup/install` through the official `codex mcp add` command, using absolute Node and source-launcher paths plus an explicit `DSH_BRIDGE_RUNTIME_CONFIG` path. The tested Codex `0.156.1` legacy plugin MCP JSON surface did not reliably expand `${PLUGIN_ROOT}` / `${CODEX_HOME}` or honor `env_vars` / `envVars`; the current Plugin therefore does not use `.mcp.json` or a manifest `mcpServers` field for registration.

Keep the source checkout and dedicated DSH runtime directories. With a custom `CODEX_HOME`, setup and MCP inspection must use that same Home. CLI DSH environment overrides do not update Desktop's saved selection; rerun setup to save runtime changes. Marketplace Skill installation alone is not a complete local MCP setup, and disabling the Skill does not remove the independent registration.

## Evidence scope

The retained Alpha 1 fixtures record tool discovery, profile routing, task completion, a DSH-authored patch, content hash verification, main-worktree isolation, same-session continuation, cancellation, Kimi/DeepSeek concurrent routing and two completed internal subagent calls on DSH `0.1.0-rc.8`. Alpha 2 recorded setup-lifecycle and model-matrix results on 2026-08-21; local execution logs were intentionally not committed.

The current runners target DSH `0.2.0-rc.2`. Reproducing a historical Alpha requires that release's source and pinned dependencies; running today's scripts does not reproduce the rc.8 contract.

`doctor` checks version, Profile composition, configuration and MCP startup. `models list` discovers model routes and advertised capabilities. Neither generates a model response. A successful installation or model listing therefore does not prove provider authentication, billing access, generation, cancellation or internal subagent behavior. Those require a credentialed task or E2E with the exact release and route being claimed.
