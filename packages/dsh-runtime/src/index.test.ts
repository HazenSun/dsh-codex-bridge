import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { describe, expect, it } from 'vitest';

import { summarizeDshEvents } from './index.js';

describe('summarizeDshEvents', () => {
  it('counts only subagent calls inside the current run interval', () => {
    const events = [
      { seq: 1, type: 'tool/call', data: { callId: 'old', name: 'subagent' } },
      { seq: 2, type: 'tool/call', data: { callId: 'bash', name: 'bash' } },
      { seq: 3, type: 'tool/call', data: { callId: 'one', name: 'subagent' } },
      { seq: 4, type: 'tool/call', data: { callId: 'two', name: 'subagent_fork' } },
      { seq: 5, type: 'tool/call', data: { callId: 'three', name: 'subagent_codex' } },
      {
        seq: 6,
        type: 'tool/result',
        data: {
          message: { content: [{ toolCallId: 'one', isError: false }] },
        },
      },
      {
        seq: 7,
        type: 'tool/result',
        data: {
          message: { content: [{ toolCallId: 'two', isError: true }] },
        },
      },
      { seq: 8, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[];

    expect(summarizeDshEvents(events, 2).delegation).toEqual({
      subagentCalls: 3,
      completedCalls: 1,
      failedCalls: 1,
      toolNames: ['subagent', 'subagent_fork', 'subagent_codex'],
    });
  });

  it('keeps continuation evidence separate from earlier runs', () => {
    const events = [
      { seq: 10, type: 'tool/call', data: { callId: 'old', name: 'subagent' } },
      { seq: 20, type: 'tool/call', data: { callId: 'bash', name: 'bash' } },
      { seq: 21, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[];

    expect(summarizeDshEvents(events, 20).delegation.subagentCalls).toBe(0);
  });
});
