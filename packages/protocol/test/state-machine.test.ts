import { describe, expect, it } from 'vitest';

import {
  ProtocolError,
  TaskStatus,
  assertTaskStatusTransition,
  canTransitionTaskStatus,
  isTerminalTaskStatus,
} from '../src/index.js';

describe('task status machine', () => {
  it('accepts the documented happy path', () => {
    const path = [
      TaskStatus.validating,
      TaskStatus.queued,
      TaskStatus.preparing_workspace,
      TaskStatus.running,
      TaskStatus.collecting,
      TaskStatus.completed,
    ];

    for (let index = 0; index < path.length - 1; index += 1) {
      expect(canTransitionTaskStatus(path[index]!, path[index + 1]!)).toBe(true);
      expect(() => assertTaskStatusTransition(path[index]!, path[index + 1]!)).not.toThrow();
    }
  });

  it('allows interruption recovery and explicit continuation', () => {
    expect(canTransitionTaskStatus(TaskStatus.interrupted, TaskStatus.queued)).toBe(true);
    expect(canTransitionTaskStatus(TaskStatus.completed, TaskStatus.queued)).toBe(true);
    expect(canTransitionTaskStatus(TaskStatus.partial, TaskStatus.queued)).toBe(true);
    expect(canTransitionTaskStatus(TaskStatus.failed, TaskStatus.queued)).toBe(true);
    expect(isTerminalTaskStatus(TaskStatus.completed)).toBe(true);
    expect(isTerminalTaskStatus(TaskStatus.interrupted)).toBe(true);
    expect(isTerminalTaskStatus(TaskStatus.running)).toBe(false);
    expect(canTransitionTaskStatus(TaskStatus.completed, TaskStatus.running)).toBe(false);
    expect(canTransitionTaskStatus(TaskStatus.cancelled, TaskStatus.queued)).toBe(false);
  });

  it('rejects an illegal transition with a stable error code', () => {
    expect(() => assertTaskStatusTransition(TaskStatus.completed, TaskStatus.running)).toThrowError(
      ProtocolError,
    );

    try {
      assertTaskStatusTransition(TaskStatus.completed, TaskStatus.running);
      throw new Error('expected transition to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe('TASK_INVALID_TRANSITION');
      expect((error as ProtocolError).toJSON().protocol_version).toBe('bridge.dsh.dev/v1alpha1');
    }
  });
});
