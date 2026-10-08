import type { Context } from '@deepseek-ai/cordis';
import {
  installModelSelection,
  type Agent,
  type CreateAgentOptions,
  type ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent';
import {
  createAssistantMessage,
  createToolResultMessage,
  ReasoningEffortId,
  ToolCallId,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm';
import {
  SessionId,
  SessionSeq,
  type SessionEvent,
  type SessionEventMap,
  type SessionEventType,
  type TurnEndReason,
} from '@deepseek-ai/dsh-session';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DshRuntimeUnavailableError,
  InProcessDshRuntime,
  summarizeDshEvents,
  type DshRunRequest,
} from './index.js';

vi.mock('@deepseek-ai/dsh-agent', () => ({ installModelSelection: vi.fn() }));

afterEach(() => vi.clearAllMocks());

function event<T extends SessionEventType>(
  seq: number,
  type: T,
  data: SessionEventMap[T],
): SessionEvent<T> {
  return { seq: SessionSeq(seq), time: 0, type, data } as SessionEvent<T>;
}

function answer(seq: number, text: string, usage?: TokenUsage): SessionEvent<'assistant/message'> {
  return event(seq, 'assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'fixture', model: 'fixture' },
    }),
    stream: [],
    ...(usage === undefined ? {} : { usage }),
  });
}

function call(seq: number, callId: string, name: string, args = '{}'): SessionEvent<'tool/call'> {
  return event(seq, 'tool/call', {
    turn: 1,
    step: 1,
    callId: ToolCallId(callId),
    name,
    arguments: args,
  });
}

function result(seq: number, callId: string, isError = false): SessionEvent<'tool/result'> {
  return event(seq, 'tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId: ToolCallId(callId), content: [], isError }),
  });
}

function ending(
  seq: number,
  reason: TurnEndReason = { kind: 'completed' },
): SessionEvent<'turn/end'> {
  return event(seq, 'turn/end', { turn: 1, reason });
}

function runtimeFixture(
  priorEvents: readonly SessionEvent[] = [],
  recordedPreset: string | null = 'standard',
) {
  const events = [...priorEvents];
  const lifecycle: string[] = [];
  const agentCtx = {} as Context;
  let id = SessionId('fixture-session');
  const session = {
    header: { agentPreset: 'creation-preset' },
    get seq() {
      return events.length;
    },
  };
  const agent = {
    get id() {
      return id;
    },
    session,
    ctx: agentCtx,
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => {}),
    followup: vi.fn(() => {
      const first = events.length;
      events.push(
        event(first, 'turn/start', { turn: 1 }),
        answer(first + 1, 'current answer', { inputTokens: 8, outputTokens: 3, totalTokens: 11 }),
        ending(first + 2),
      );
    }),
  };
  const handle = {
    agent: agent as unknown as Agent,
    dispose: vi.fn(async () => {
      lifecycle.push('agent-dispose');
    }),
  };
  const reader = {
    read: vi.fn(async (offset: number = 0, length?: number) => {
      lifecycle.push('read');
      return {
        eventState: 'detached' as const,
        events: events.slice(offset, length === undefined ? undefined : offset + length),
      };
    }),
    close: vi.fn(async () => {
      lifecycle.push('read-close');
    }),
  };
  const persistence = {
    open: vi.fn(async (sessionId: SessionId, access: 'read') => {
      if (sessionId !== agent.id || access !== 'read') throw new Error('Unexpected read target');
      lifecycle.push('open');
      return reader;
    }),
  };
  const sessions = {
    flush: vi.fn(async () => {
      lifecycle.push('flush');
      return true;
    }),
  };
  const presets = { mount: vi.fn(async (_ctx: Context, preset: string) => ({ id: preset })) };
  const projections = { stateOf: vi.fn(() => recordedPreset) };
  const factory = async (options: CreateAgentOptions | ResumeAgentOptions) => {
    id = 'sessionId' in options ? options.sessionId : options.resumeSessionId;
    try {
      await options.setup?.(agentCtx, handle.agent);
    } catch (error) {
      // The official factory owns rollback until it returns a published handle.
      await handle.dispose();
      throw error;
    }
    return handle;
  };
  const agents = {
    create: vi.fn((options: CreateAgentOptions) => factory(options)),
    resume: vi.fn((options: ResumeAgentOptions) => factory(options)),
  };
  const services: Record<string, unknown> = {
    agents,
    sessions,
    sessionPersistence: persistence,
    agentPresets: presets,
    sessionProjections: projections,
  };
  const ctx = { get: vi.fn((name: string) => services[name]) } as unknown as Context;
  return {
    runtime: new InProcessDshRuntime(ctx),
    agents,
    agent,
    handle,
    sessions,
    persistence,
    reader,
    presets,
    projections,
    services,
    events,
    lifecycle,
    agentCtx,
  };
}

const request: DshRunRequest = {
  cwd: '/tmp/bridge-runtime-fixture',
  prompt: 'Complete the scoped task.',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  agentPreset: 'standard',
};

describe('summarizeDshEvents', () => {
  it('does not report a successful background queue acknowledgment as a completed child', () => {
    const events = [
      call(0, 'background', 'subagent', '{"run_in_background":true}'),
      result(1, 'background'),
    ];
    expect(summarizeDshEvents(events, 0).delegation).toEqual({
      subagentCalls: 1,
      completedCalls: 0,
      failedCalls: 0,
      toolNames: ['subagent'],
    });
  });

  it.each(['{}', '{"run_in_background":false}', '{"prompt":"Return the scoped answer"}'])(
    'retains completion evidence for a confirmed or default foreground call (%s)',
    (args) => {
      expect(
        summarizeDshEvents([call(0, 'foreground', 'subagent', args), result(1, 'foreground')], 0)
          .delegation,
      ).toMatchObject({ subagentCalls: 1, completedCalls: 1, failedCalls: 0 });
    },
  );

  it.each([
    'invalid json',
    'null',
    '[]',
    'true',
    '"string"',
    '{"run_in_background":"false"}',
    '{"run_in_background":null}',
  ])('withholds completion evidence when foreground arguments cannot be confirmed (%s)', (args) => {
    expect(
      summarizeDshEvents([call(0, 'unknown', 'subagent', args), result(1, 'unknown')], 0)
        .delegation,
    ).toMatchObject({ subagentCalls: 1, completedCalls: 0, failedCalls: 0 });
  });

  it.each(['{"run_in_background":true}', 'invalid json'])(
    'still counts a failed background or unconfirmed invocation (%s)',
    (args) => {
      expect(
        summarizeDshEvents([call(0, 'failed', 'subagent', args), result(1, 'failed', true)], 0)
          .delegation,
      ).toMatchObject({ subagentCalls: 1, completedCalls: 0, failedCalls: 1 });
    },
  );

  it('matches V4 message-level tool identities and errors, including empty result content', () => {
    const events = [
      call(1, 'old', 'subagent'),
      call(2, 'bash', 'bash'),
      call(3, 'one', 'subagent'),
      call(4, 'two', 'subagent_fork'),
      call(5, 'three', 'subagent_codex'),
      result(6, 'one'),
      result(7, 'two', true),
      result(8, 'old'),
      ending(9),
    ];

    expect(summarizeDshEvents(events, 2).delegation).toEqual({
      subagentCalls: 3,
      completedCalls: 1,
      failedCalls: 1,
      toolNames: ['subagent', 'subagent_fork', 'subagent_codex'],
    });
  });

  it('bounds text, reason, and delegation to the half-open run interval', () => {
    const events = [
      call(0, 'old', 'subagent'),
      answer(1, 'earlier answer'),
      answer(2, 'current answer'),
      ending(3),
      call(4, 'later', 'subagent'),
      answer(5, 'later answer'),
      ending(6, { kind: 'blocked' }),
    ];

    expect(summarizeDshEvents(events, 2, 4)).toMatchObject({
      text: 'current answer',
      reason: { kind: 'completed' },
      delegation: { subagentCalls: 0, completedCalls: 0, failedCalls: 0 },
    });
  });

  it('aggregates disjoint usage fields and the complete provider totals', () => {
    const usage = {
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 15,
      cacheReadTokens: 4,
      cacheWriteTokens: 6,
      reasoningTokens: 1,
    };
    expect(
      summarizeDshEvents([answer(0, 'first', usage), answer(1, 'final', usage)], 0),
    ).toMatchObject({
      text: 'final',
      usage: {
        inputTokens: 4,
        outputTokens: 6,
        totalTokens: 30,
        cacheReadTokens: 8,
        cacheWriteTokens: 12,
        reasoningTokens: 2,
      },
    });
  });

  it.each([undefined, { inputTokens: 1, outputTokens: 1 }])(
    'does not report a partial provider total when a message lacks complete accounting (%s)',
    (usage) => {
      const events = [
        answer(0, 'first', { inputTokens: 2, outputTokens: 3, totalTokens: 5 }),
        answer(1, 'final', usage),
      ];
      expect(summarizeDshEvents(events, 0).usage.totalTokens).toBeUndefined();
    },
  );
});

describe('InProcessDshRuntime', () => {
  it('flushes a ready session and awaits its durable binding before submitting any user turn', async () => {
    const fixture = runtimeFixture();
    let signalReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    let allowTurn!: () => void;
    const binding = new Promise<void>((resolve) => {
      allowTurn = resolve;
    });
    let boundId: string | undefined;
    const run = fixture.runtime.run({
      ...request,
      onSessionReady: async (sessionId) => {
        boundId = sessionId;
        fixture.lifecycle.push('session-bound');
        signalReady();
        await binding;
      },
    });
    try {
      await ready;
      expect(boundId).toMatch(/^bridge-/);
      expect(fixture.lifecycle).toEqual(['flush', 'session-bound']);
      expect(fixture.agent.followup).not.toHaveBeenCalled();
    } finally {
      allowTurn();
    }
    expect((await run).sessionId).toBe(boundId);
    expect(fixture.agent.followup).toHaveBeenCalledOnce();
  });

  it('disposes the unpublished turn when persisting the session binding fails', async () => {
    const fixture = runtimeFixture();
    const failure = new Error('session binding write failed');
    await expect(
      fixture.runtime.run({
        ...request,
        onSessionReady: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(fixture.sessions.flush).toHaveBeenCalledOnce();
    expect(fixture.agent.followup).not.toHaveBeenCalled();
    expect(fixture.persistence.open).not.toHaveBeenCalled();
    expect(fixture.handle.dispose).toHaveBeenCalledOnce();
  });

  it('never submits a new turn if cancellation arrives while the binding callback is awaiting', async () => {
    const fixture = runtimeFixture();
    const controller = new AbortController();
    await expect(
      fixture.runtime.run({
        ...request,
        signal: controller.signal,
        onSessionReady: async () => {
          controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fixture.agent.followup).not.toHaveBeenCalled();
    expect(fixture.handle.dispose).toHaveBeenCalledOnce();
  });

  it('creates with the exact model route and reads the flushed V4 run through an owned read handle', async () => {
    const fixture = runtimeFixture();
    const completed = await fixture.runtime.run({
      ...request,
      reasoningEffort: 'high',
      maxTokens: 500,
    });

    const creation = fixture.agents.create.mock.calls[0]?.[0];
    expect(creation?.sessionId).toMatch(/^bridge-/);
    expect(creation).toMatchObject({
      meta: { cwd: request.cwd, origin: 'subagent', delegationDepth: 1, agentPreset: 'standard' },
      agentOptions: {
        provider: request.provider,
        model: request.model,
        reasoningEffort: ReasoningEffortId('high'),
        maxTokens: 500,
      },
    });
    expect(fixture.presets.mount).toHaveBeenCalledWith(fixture.agentCtx, 'standard');
    expect(installModelSelection).toHaveBeenCalledWith(fixture.agentCtx, {
      current: {
        provider: request.provider,
        model: request.model,
        reasoningEffort: ReasoningEffortId('high'),
      },
      assembled: undefined,
    });
    expect(fixture.agent.followup).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: request.prompt }],
      }),
    );
    expect(completed).toMatchObject({ text: 'current answer', firstEventSeq: 0, lastEventSeq: 3 });
    expect(fixture.persistence.open).toHaveBeenCalledWith(completed.sessionId, 'read');
    expect(fixture.reader.read).toHaveBeenCalledWith(0, 3);
    expect(fixture.lifecycle).toEqual([
      'flush',
      'flush',
      'open',
      'read',
      'read-close',
      'agent-dispose',
    ]);
  });

  it('resumes the log-selected preset and keeps prior text, calls, and usage out of continuation evidence', async () => {
    const fixture = runtimeFixture(
      [call(0, 'prior-child', 'subagent'), answer(1, 'prior answer')],
      'selected-preset',
    );
    const presetFreeRequest = {
      cwd: request.cwd,
      prompt: request.prompt,
      provider: request.provider,
      model: request.model,
    };
    const completed = await fixture.runtime.run({
      ...presetFreeRequest,
      sessionId: 'prior-session',
    });

    expect(fixture.agents.create).not.toHaveBeenCalled();
    expect(fixture.agents.resume).toHaveBeenCalledWith(
      expect.objectContaining({ resumeSessionId: 'prior-session' }),
    );
    expect(fixture.projections.stateOf).toHaveBeenCalledWith(fixture.agent.session, 'agentPreset');
    expect(fixture.presets.mount).toHaveBeenCalledWith(fixture.agentCtx, 'selected-preset');
    expect(fixture.reader.read).toHaveBeenCalledWith(2, 3);
    expect(completed).toMatchObject({
      sessionId: 'prior-session',
      text: 'current answer',
      firstEventSeq: 2,
      lastEventSeq: 5,
      delegation: { subagentCalls: 0 },
    });
  });

  it.each(['other-preset', null])(
    'refuses an explicitly different preset when resuming (%s)',
    async (recordedPreset) => {
      const fixture = runtimeFixture([], recordedPreset);
      await expect(fixture.runtime.run({ ...request, sessionId: 'prior-session' })).rejects.toThrow(
        'recorded preset',
      );
      expect(fixture.agent.followup).not.toHaveBeenCalled();
      expect(fixture.presets.mount).not.toHaveBeenCalled();
      expect(fixture.handle.dispose).toHaveBeenCalledOnce();
    },
  );

  it.each(['agents', 'sessions', 'sessionPersistence'])(
    'fails before creating an agent when %s is missing',
    async (service) => {
      const fixture = runtimeFixture();
      delete fixture.services[service];
      await expect(fixture.runtime.run(request)).rejects.toMatchObject({
        code: 'DSH_RUNTIME_UNAVAILABLE',
      });
      expect(fixture.agents.create).not.toHaveBeenCalled();
    },
  );

  it('fails closed when the resumed preset projection is unavailable', async () => {
    const fixture = runtimeFixture();
    delete fixture.services['sessionProjections'];
    await expect(
      fixture.runtime.run({ ...request, sessionId: 'prior-session' }),
    ).rejects.toBeInstanceOf(DshRuntimeUnavailableError);
    expect(fixture.agent.followup).not.toHaveBeenCalled();
  });

  it('does not create or submit work for an already-aborted request', async () => {
    const fixture = runtimeFixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      fixture.runtime.run({ ...request, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fixture.agents.create).not.toHaveBeenCalled();
    expect(fixture.agent.followup).not.toHaveBeenCalled();
  });

  it('closes the cancellation gap between factory completion and attaching the live listener', async () => {
    const fixture = runtimeFixture();
    const controller = new AbortController();
    const create = fixture.agents.create.getMockImplementation();
    fixture.agents.create.mockImplementation(async (options) => {
      const handle = await create!(options);
      controller.abort();
      return handle;
    });
    await expect(
      fixture.runtime.run({ ...request, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fixture.agent.followup).not.toHaveBeenCalled();
    expect(fixture.handle.dispose).toHaveBeenCalledOnce();
    controller.abort();
    expect(fixture.agent.cancel).not.toHaveBeenCalled();
  });

  it('does not submit a prompt when cancellation arrives during the initial idle wait', async () => {
    const fixture = runtimeFixture();
    const controller = new AbortController();
    fixture.agent.whenIdle.mockImplementationOnce(async () => {
      controller.abort();
    });
    await expect(
      fixture.runtime.run({ ...request, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fixture.agent.cancel).toHaveBeenCalledWith({ kind: 'user' });
    expect(fixture.agent.followup).not.toHaveBeenCalled();
    expect(fixture.handle.dispose).toHaveBeenCalledOnce();
  });

  it('cancels active work, collects its durable aborted result, and detaches the listener after disposal', async () => {
    const fixture = runtimeFixture();
    const controller = new AbortController();
    fixture.agent.cancel.mockImplementation(() => {
      fixture.events.push(
        ending(fixture.events.length, { kind: 'aborted', reason: { kind: 'user' } }),
      );
    });
    fixture.agent.followup.mockImplementation(() => {
      fixture.events.push(event(0, 'turn/start', { turn: 1 }));
      controller.abort();
    });
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const completed = await fixture.runtime.run({ ...request, signal: controller.signal });
    expect(completed.reason).toEqual({ kind: 'aborted', reason: { kind: 'user' } });
    expect(fixture.agent.cancel).toHaveBeenCalledOnce();
    expect(fixture.reader.close).toHaveBeenCalledOnce();
    expect(fixture.handle.dispose).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('fixes the run interval before the durability checkpoint can append unrelated events', async () => {
    const fixture = runtimeFixture();
    fixture.sessions.flush.mockImplementation(async () => {
      fixture.events.push(call(3, 'later', 'subagent'), answer(4, 'later answer'));
      return true;
    });
    fixture.sessions.flush.mockResolvedValueOnce(true);
    const completed = await fixture.runtime.run(request);
    expect(completed).toMatchObject({
      text: 'current answer',
      lastEventSeq: 3,
      delegation: { subagentCalls: 0 },
    });
    expect(fixture.reader.read).toHaveBeenCalledWith(0, 3);
  });

  it('requires the scoped flush listener before reading durable events', async () => {
    const fixture = runtimeFixture();
    fixture.sessions.flush.mockResolvedValue(false);
    await expect(fixture.runtime.run(request)).rejects.toThrow('session/flush');
    expect(fixture.persistence.open).not.toHaveBeenCalled();
    expect(fixture.handle.dispose).toHaveBeenCalledOnce();
  });

  it('rejects a truncated run log and still closes both owned resources', async () => {
    const fixture = runtimeFixture();
    fixture.reader.read.mockResolvedValue({ eventState: 'detached', events: [] });
    await expect(fixture.runtime.run(request)).rejects.toThrow('missing events');
    expect(fixture.reader.close).toHaveBeenCalledOnce();
    expect(fixture.handle.dispose).toHaveBeenCalledOnce();
  });

  it('preserves read and teardown failures instead of masking the first failure', async () => {
    const fixture = runtimeFixture();
    const readError = new Error('read failed');
    const closeError = new Error('read close failed');
    const disposeError = new Error('agent dispose failed');
    fixture.reader.read.mockRejectedValue(readError);
    fixture.reader.close.mockRejectedValue(closeError);
    fixture.handle.dispose.mockRejectedValue(disposeError);
    const failure = await fixture.runtime.run(request).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors[0]).toBeInstanceOf(AggregateError);
    expect((aggregate.errors[0] as AggregateError).errors).toEqual([readError, closeError]);
    expect(aggregate.errors[1]).toBe(disposeError);
    expect(fixture.reader.close).toHaveBeenCalledOnce();
    expect(fixture.handle.dispose).toHaveBeenCalledOnce();
  });
});
