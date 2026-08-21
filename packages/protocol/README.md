# `@dsh-codex-bridge/protocol`

The host-neutral wire contract shared by the Codex Plugin, the DSH Plugin and
future host adapters. It is intentionally independent of Cordis, MCP SDK
types, Codex thread objects and any provider SDK.

## Design commitments

- Wire keys use `snake_case` and carry `protocol_version`.
- Schemas are strict: an unknown field is rejected rather than silently
  dropped.
- IDs, timestamps, hashes, budgets and pagination limits are bounded at the
  protocol boundary.
- Task status transitions are explicit and validated by code.
- A completed, partial or failed run can be continued explicitly; the task
  engine must assign a new `run_id` and retain the previous result.
- `interrupted` is queryable evidence of a lost run and may be re-queued after
  reconciliation; it is not evidence of successful completion.
- Error codes are stable strings suitable for retry and UI policy.
- Delegation keeps the requested `auto | single | multi` strategy separate from the resolved decision and runtime evidence so automatic routing is auditable.
- Large outputs are represented by content-addressed Artifact references; the
  artifact reader is separately paginated.

## Public entry point

```ts
import {
  DelegateTaskInputSchema,
  PROTOCOL_VERSION,
  TaskStatus,
  canTransitionTaskStatus,
  parseProtocol,
} from '@dsh-codex-bridge/protocol';

const input = parseProtocol(DelegateTaskInputSchema, {
  protocol_version: PROTOCOL_VERSION,
  project_id: 'demo-project',
  profile_id: 'frontend_worker',
  objective: 'Add a health endpoint',
  acceptance_criteria: ['The endpoint returns HTTP 200'],
  delegation: {
    strategy: 'multi',
    reason: 'Implementation and independent verification are separate workstreams.',
    roles: ['implementation', 'reviewer'],
  },
});

if (canTransitionTaskStatus(TaskStatus.running, TaskStatus.collecting)) {
  // The task engine may now collect artifacts.
}
```

The package exposes schemas and inferred TypeScript types from `src/index.ts`.
The protocol package does not create tasks, touch the filesystem, or call an
LLM; those concerns belong to the task engine and runtime adapter packages.

JSON Schema artifacts for contract tests and non-TypeScript hosts live under
`schemas/v1alpha1/`. Regenerate them after a schema change with:

```bash
npm run generate:schemas
```
