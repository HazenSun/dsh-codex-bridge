import { describe, expect, it } from 'vitest';

import {
  MCP_TOOL_SCHEMAS,
  PROTOCOL_VERSION,
  ProfileChangeSchema,
  ReadTaskArtifactInputSchema,
  makeMcpErrorOutput,
} from '../src/index.js';

describe('MCP contract', () => {
  it('publishes every P0 tool with input and output schemas', () => {
    expect(Object.keys(MCP_TOOL_SCHEMAS)).toEqual([
      'get_setup_status',
      'discover_dsh_models',
      'preview_profile_change',
      'apply_profile_change',
      'rollback_profile_change',
      'list_profiles',
      'delegate_task',
      'get_task',
      'get_task_result',
      'read_task_artifact',
      'continue_task',
      'cancel_task',
      'wait_task',
      'cleanup_task',
      'doctor',
    ]);
    for (const schema of Object.values(MCP_TOOL_SCHEMAS)) {
      expect(schema.input).toBeDefined();
      expect(schema.output).toBeDefined();
    }
  });

  it('rejects a replacement whose profile id does not match the target', () => {
    expect(() =>
      ProfileChangeSchema.parse({
        operation: 'update',
        profile_id: 'fast-worker',
        profile: {
          protocol_version: PROTOCOL_VERSION,
          profile_id: 'different-worker',
          description: 'Replacement worker',
          dsh: {
            provider: 'provider-main',
            model: 'model-main',
            agent_preset: 'standard',
            max_tokens: 32_000,
          },
          delegation: { max_depth: 0, max_children: 0, roles: {} },
          workspace: { mode: 'isolated_worktree', allowed_roots: ['.'] },
          policy: {
            network: 'restricted',
            allowed_domains: [],
            denied_paths: ['.env', '.git'],
            timeout_seconds: 1_800,
            max_artifact_bytes: 10_485_760,
            max_output_bytes: 1_048_576,
            max_files: 1_000,
            disk_quota_bytes: 1_073_741_824,
          },
        },
      }),
    ).toThrow(/profile_id/);
  });

  it('accepts a bounded partial model route update', () => {
    expect(
      ProfileChangeSchema.parse({
        operation: 'update',
        profile_id: 'fast-worker',
        changes: {
          dsh: {
            provider: 'provider-main',
            model: 'vendor/model-code',
            reasoning_effort: 'high',
          },
        },
      }),
    ).toMatchObject({ operation: 'update', profile_id: 'fast-worker' });
  });

  it('rejects an update with neither or both replacement forms', () => {
    expect(() =>
      ProfileChangeSchema.parse({ operation: 'update', profile_id: 'fast-worker' }),
    ).toThrow(/exactly one/);
    expect(() =>
      ProfileChangeSchema.parse({
        operation: 'update',
        profile_id: 'fast-worker',
        changes: { dsh: { model: 'vendor/model-code' } },
        profile: {
          protocol_version: PROTOCOL_VERSION,
          profile_id: 'fast-worker',
          description: 'Replacement worker',
          dsh: {
            provider: 'provider-main',
            model: 'model-main',
            agent_preset: 'standard',
            max_tokens: 32_000,
          },
          delegation: { max_depth: 0, max_children: 0, roles: {} },
          workspace: { mode: 'isolated_worktree', allowed_roots: ['.'] },
          policy: {
            network: 'restricted',
            allowed_domains: [],
            denied_paths: ['.env', '.git'],
            timeout_seconds: 1_800,
            max_artifact_bytes: 10_485_760,
            max_output_bytes: 1_048_576,
            max_files: 1_000,
            disk_quota_bytes: 1_073_741_824,
          },
        },
      }),
    ).toThrow(/exactly one/);
  });

  it('enforces bounded artifact pagination', () => {
    expect(() =>
      ReadTaskArtifactInputSchema.parse({
        protocol_version: PROTOCOL_VERSION,
        task_id: 'task-001',
        artifact_id: 'artifact-001',
        offset: 0,
        limit: 2_000_000,
      }),
    ).toThrow();
  });

  it('wraps errors in a versioned MCP response', () => {
    const output = makeMcpErrorOutput({
      protocol_version: PROTOCOL_VERSION,
      code: 'TASK_NOT_FOUND',
      message: 'Task is missing',
      retryable: false,
    });

    expect(output.protocol_version).toBe(PROTOCOL_VERSION);
    expect(output.error.code).toBe('TASK_NOT_FOUND');
  });
});
