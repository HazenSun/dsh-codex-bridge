# ADR-0001: Host MCP inside the DSH Cordis process

- Status: Accepted
- Date: 2026-08-21

## Decision

The default runtime launches `dsh --profile codex-bridge`. The DSH bundle hosts the STDIO MCP gateway, task engine and `InProcessDshRuntime` in one Cordis process. Code remains separated into packages, but deployment is one process.

## Why

The in-process API exposes `agents.create`, `resume`, `cancel`, `whenIdle`, Session events, Agent Presets and per-Agent model selection. The current DSH SDK transport does not expose equivalent per-prompt cancellation and session-close semantics.

## Consequences

- stdout belongs exclusively to MCP framing; diagnostics go to stderr or persisted events.
- DSH imports are confined to `dsh-runtime` and `dsh-plugin`.
- DSH is pinned and contract-tested because Cordis APIs are still Developer Preview.
- A future SDK backend may be added behind the runtime interface without changing the host-neutral protocol.
