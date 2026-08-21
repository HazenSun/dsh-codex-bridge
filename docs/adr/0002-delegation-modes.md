# ADR-0002: Direct delegation by default

- Status: Accepted
- Date: 2026-08-21

## Decision

Codex calls the Bridge MCP directly by default. Native Shell Mode is optional and installs a narrow `dsh_orchestrator` Codex custom Agent that calls the same MCP tools.

## Why

There is no public Codex extension point that replaces a native Sub-Agent’s model provider with DSH. Direct Mode preserves the desired external Sub-Agent semantics with the lowest additional Codex usage. Native Shell Mode improves thread visibility and context isolation at the cost of another Codex Agent invocation.

## Consequences

- Documentation never claims DSH is a native Codex model.
- Both modes produce identical Bridge Task and Artifact schemas.
- Direct Mode remains the installation default.
