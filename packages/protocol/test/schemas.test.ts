import { describe, expect, it } from 'vitest';

import {
  DelegateTaskInputSchema,
  DelegationDecisionSchema,
  DelegationEvidenceSchema,
  DelegationStrategy,
  PROTOCOL_VERSION,
  ProfileConfigDocumentSchema,
  ProfileSchema,
  TaskSchema,
  TaskStatus,
  TaskResultSchema,
  WorkspaceSchema,
  parseProtocol,
} from '../src/index.js';

const profile = {
  protocol_version: PROTOCOL_VERSION,
  profile_id: 'frontend_worker',
  description: 'Frontend implementation worker',
  dsh: {
    provider: 'openrouter-main',
    model: 'example-coding-model',
    reasoning_effort: 'high',
    agent_preset: 'standard',
    max_tokens: 32_000,
  },
  delegation: {
    max_depth: 2,
    max_children: 3,
    roles: {
      reviewer: {
        provider: 'openrouter-main',
        model: 'example-review-model',
        description: 'Reviews the resulting patch',
      },
    },
  },
  workspace: {
    mode: 'isolated_worktree',
    allowed_roots: ['/workspace/projects'],
  },
  policy: {
    network: 'restricted',
    allowed_domains: [],
    denied_paths: ['.env', '.git/**'],
    timeout_seconds: 1_800,
    max_artifact_bytes: 10_485_760,
    max_output_bytes: 10_485_760,
    max_files: 10_000,
    disk_quota_bytes: 1_073_741_824,
  },
};

describe('wire schemas', () => {
  it('parses a resolved profile without exposing credentials', () => {
    expect(ProfileSchema.parse(profile)).toMatchObject({
      profile_id: 'frontend_worker',
      dsh: { model: 'example-coding-model' },
    });
  });

  it('accepts a profile document keyed by profile id and applies safe defaults', () => {
    const document = ProfileConfigDocumentSchema.parse({
      protocol_version: PROTOCOL_VERSION,
      profiles: {
        frontend_worker: {
          description: 'Frontend implementation worker',
          dsh: {
            provider: 'openrouter-main',
            model: 'example-coding-model',
            agent_preset: 'standard',
            max_tokens: 32_000,
          },
          delegation: {},
          workspace: { mode: 'isolated_worktree' },
          policy: { network: 'restricted' },
        },
      },
    });

    expect(document.profiles.frontend_worker?.policy.timeout_seconds).toBe(1_800);
    expect(document.profiles.frontend_worker?.delegation.max_depth).toBe(0);
  });

  it('rejects unknown fields instead of silently stripping them', () => {
    expect(() => ProfileSchema.parse({ ...profile, api_key: 'secret' })).toThrow();
  });

  it('parses a minimal delegation request and keeps protocol version explicit', () => {
    const parsed = parseProtocol(DelegateTaskInputSchema, {
      protocol_version: PROTOCOL_VERSION,
      project_id: 'demo-project',
      profile_id: 'frontend_worker',
      objective: 'Add a health endpoint',
      acceptance_criteria: ['The endpoint returns HTTP 200'],
    });

    expect(parsed.protocol_version).toBe(PROTOCOL_VERSION);
    expect(parsed.objective).toBe('Add a health endpoint');
    expect(parsed.delegation).toBeUndefined();
  });

  it('normalizes optional Codex routing hints without changing legacy input validity', () => {
    const parsed = DelegateTaskInputSchema.parse({
      protocol_version: PROTOCOL_VERSION,
      project_id: 'demo-project',
      profile_id: 'frontend_worker',
      objective: 'Split implementation and verification',
      delegation: {
        strategy: DelegationStrategy.auto,
        reason: 'The work has independent implementation and review tracks',
        roles: ['implementer', 'reviewer'],
      },
    });

    expect(parsed.delegation).toEqual({
      strategy: DelegationStrategy.auto,
      reason: 'The work has independent implementation and review tracks',
      roles: ['implementer', 'reviewer'],
    });

    expect(
      DelegateTaskInputSchema.parse({
        protocol_version: PROTOCOL_VERSION,
        project_id: 'demo-project',
        profile_id: 'frontend_worker',
        objective: 'Use the existing worker',
        delegation: {},
      }).delegation,
    ).toEqual({ strategy: DelegationStrategy.auto, roles: [] });
  });

  it('rejects unknown routing fields and duplicate role ids', () => {
    expect(() =>
      DelegateTaskInputSchema.parse({
        protocol_version: PROTOCOL_VERSION,
        project_id: 'demo-project',
        profile_id: 'frontend_worker',
        objective: 'Reject an unknown hint',
        delegation: { strategy: 'auto', unknown: true },
      }),
    ).toThrow();

    expect(() =>
      DelegateTaskInputSchema.parse({
        protocol_version: PROTOCOL_VERSION,
        project_id: 'demo-project',
        profile_id: 'frontend_worker',
        objective: 'Reject duplicate roles',
        delegation: { strategy: 'multi', roles: ['reviewer', 'reviewer'] },
      }),
    ).toThrow();
  });

  it('validates and records the resolved strategy decision and observed evidence', () => {
    const decision = DelegationDecisionSchema.parse({
      strategy: DelegationStrategy.auto,
      resolved_strategy: DelegationStrategy.multi,
      reason: 'Implementation and review are independent workstreams',
      roles: ['implementer', 'reviewer'],
      decided_by: 'codex',
      decided_at: '2026-08-21T00:00:00.000Z',
    });
    const evidence = DelegationEvidenceSchema.parse({
      children_requested: 2,
      children_completed: 2,
      child_task_ids: ['child-001', 'child-002'],
      roles: ['implementer', 'reviewer'],
      source: 'dsh',
      observed: {
        subagent_calls: 2,
        tool_names: ['subagent', 'subagent_fork'],
      },
      recorded_at: '2026-08-21T00:01:00.000Z',
    });

    const task = TaskSchema.parse({
      protocol_version: PROTOCOL_VERSION,
      task_id: 'task-002',
      trace_id: 'trace-002',
      origin: 'codex',
      delegation_depth: 0,
      project_id: 'demo-project',
      workspace_id: 'workspace-002',
      profile_id: 'frontend_worker',
      objective: 'Split implementation and verification',
      acceptance_criteria: [],
      status: TaskStatus.running,
      created_at: '2026-08-21T00:00:00.000Z',
      updated_at: '2026-08-21T00:01:00.000Z',
      delegation_decision: decision,
      delegation_evidence: evidence,
    });

    expect(task.delegation_decision?.resolved_strategy).toBe(DelegationStrategy.multi);
    expect(task.delegation_evidence?.observed?.subagent_calls).toBe(2);
  });

  it('rejects inconsistent resolved strategies and child evidence counts', () => {
    expect(() =>
      DelegationDecisionSchema.parse({
        strategy: DelegationStrategy.single,
        resolved_strategy: DelegationStrategy.multi,
        reason: 'A contradictory decision',
        roles: [],
        decided_by: 'codex',
        decided_at: '2026-08-21T00:00:00.000Z',
      }),
    ).toThrow();

    expect(() =>
      DelegationEvidenceSchema.parse({
        children_requested: 1,
        children_completed: 1,
        children_failed: 1,
        source: 'bridge',
        recorded_at: '2026-08-21T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('carries the same decision/evidence contract on terminal results', () => {
    const result = TaskResultSchema.parse({
      protocol_version: PROTOCOL_VERSION,
      task_id: 'task-003',
      run_id: 'run-003',
      trace_id: 'trace-003',
      status: TaskStatus.completed,
      summary: 'Completed with one DSH worker',
      acceptance: [],
      changed_files: [],
      diff_stat: { files_changed: 0, insertions: 0, deletions: 0, binary_files: 0 },
      tests: [],
      warnings: [],
      artifacts: { artifacts: [], total_bytes: 0 },
      delegation_decision: {
        strategy: DelegationStrategy.single,
        resolved_strategy: DelegationStrategy.single,
        reason: 'The task is a focused local change',
        roles: [],
        decided_by: 'codex',
        decided_at: '2026-08-21T00:00:00.000Z',
      },
      delegation_evidence: {
        children_requested: 0,
        children_completed: 0,
        source: 'dsh',
        recorded_at: '2026-08-21T00:01:00.000Z',
      },
      completed_at: '2026-08-21T00:01:00.000Z',
    });

    expect(result.delegation_decision?.resolved_strategy).toBe(DelegationStrategy.single);
    expect(result.delegation_evidence?.children_completed).toBe(0);
  });

  it('rejects an unsupported protocol version', () => {
    expect(() =>
      DelegateTaskInputSchema.parse({
        protocol_version: 'bridge.dsh.dev/v9',
        project_id: 'demo-project',
        profile_id: 'frontend_worker',
        objective: 'Nope',
        acceptance_criteria: [],
      }),
    ).toThrow();
  });

  it('validates task snapshots and lifecycle status', () => {
    const task = TaskSchema.parse({
      protocol_version: PROTOCOL_VERSION,
      task_id: 'task-001',
      trace_id: 'trace-001',
      origin: 'codex',
      delegation_depth: 0,
      project_id: 'demo-project',
      workspace_id: 'workspace-001',
      profile_id: 'frontend_worker',
      objective: 'Add a health endpoint',
      acceptance_criteria: ['The endpoint returns HTTP 200'],
      status: TaskStatus.running,
      run_id: 'run-001',
      created_at: '2026-08-21T00:00:00.000Z',
      updated_at: '2026-08-21T00:00:01.000Z',
    });

    expect(task.status).toBe(TaskStatus.running);
  });

  it('keeps workspace paths out of the public workspace descriptor', () => {
    const workspace = WorkspaceSchema.parse({
      protocol_version: PROTOCOL_VERSION,
      workspace_id: 'workspace-001',
      project_id: 'demo-project',
      mode: 'isolated_worktree',
      status: 'ready',
      base_revision: 'abc1234',
      created_at: '2026-08-21T00:00:00.000Z',
      updated_at: '2026-08-21T00:00:01.000Z',
    });

    expect(workspace).not.toHaveProperty('cwd');
  });
});
