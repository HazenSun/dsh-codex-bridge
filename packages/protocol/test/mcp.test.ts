import { describe, expect, it } from 'vitest';

import {
  MCP_TOOL_SCHEMAS,
  PROTOCOL_VERSION,
  ReadTaskArtifactInputSchema,
  makeMcpErrorOutput,
} from '../src/index.js';

describe('MCP contract', () => {
  it('publishes every P0 tool with input and output schemas', () => {
    expect(Object.keys(MCP_TOOL_SCHEMAS)).toEqual([
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
