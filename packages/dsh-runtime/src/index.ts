import { randomUUID } from 'node:crypto';

import type { Context } from '@deepseek-ai/cordis';
import { installModelSelection, type AgentHandle, type AgentSetup } from '@deepseek-ai/dsh-agent';
import { createUserMessage, ReasoningEffortId, type TokenUsage } from '@deepseek-ai/dsh-llm';
import { SessionId, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-session-projection';

export interface DshRunRequest {
  readonly cwd: string;
  readonly prompt: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly maxTokens?: number;
  readonly agentPreset?: string;
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
  /** Persist this durable session binding before any new user turn can execute. */
  readonly onSessionReady?: (sessionId: string) => void | Promise<void>;
}

export interface DshRunResult {
  readonly sessionId: string;
  readonly text: string;
  readonly reason: TurnEndReason | undefined;
  readonly usage: TokenUsage;
  /** Tool-call evidence observed only inside this run's event interval. */
  readonly delegation: DshDelegationEvidence;
  /** Inclusive event-log offset before this run's prompt. */
  readonly firstEventSeq: number;
  /** Exclusive event-log offset after this run settles. */
  readonly lastEventSeq: number;
}

export interface DshDelegationEvidence {
  readonly subagentCalls: number;
  /** Successful foreground invocations; background queue acknowledgments are excluded. */
  readonly completedCalls: number;
  readonly failedCalls: number;
  readonly toolNames: readonly string[];
}

export interface DshRuntime {
  run(request: DshRunRequest): Promise<DshRunResult>;
}

export class DshRuntimeUnavailableError extends Error {
  readonly code = 'DSH_RUNTIME_UNAVAILABLE';

  constructor(service: string) {
    super(`Required DSH service is unavailable: ${service}`);
    this.name = 'DshRuntimeUnavailableError';
  }
}

function aggregateUsage(target: TokenUsage, value: TokenUsage): void {
  target.inputTokens += value.inputTokens;
  target.outputTokens += value.outputTokens;
  if (value.totalTokens !== undefined) {
    target.totalTokens = (target.totalTokens ?? 0) + value.totalTokens;
  }
  target.cacheReadTokens = (target.cacheReadTokens ?? 0) + (value.cacheReadTokens ?? 0);
  target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + (value.cacheWriteTokens ?? 0);
  target.reasoningTokens = (target.reasoningTokens ?? 0) + (value.reasoningTokens ?? 0);
}

function isSubagentTool(name: string): boolean {
  return name === 'subagent' || name === 'subagent_fork' || name.startsWith('subagent_');
}

function isForegroundSubagentCall(rawArguments: string): boolean {
  let args: unknown;
  try {
    args = JSON.parse(rawArguments);
  } catch {
    return false;
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return false;
  const background = (args as Record<string, unknown>)['run_in_background'];
  // Bridge mounts one-shot tools: omission uses foreground, while invalid values
  // or unreadable arguments cannot prove the child completed synchronously.
  return background === undefined || background === false;
}

async function withDisposal<T>(
  operation: () => Promise<T>,
  dispose: () => Promise<void>,
): Promise<T> {
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    try {
      await dispose();
    } catch (disposalError) {
      throw new AggregateError([error, disposalError], 'DSH operation and disposal both failed');
    }
    throw error;
  }
  await dispose();
  return result;
}

export function summarizeDshEvents(
  events: readonly SessionEvent[],
  firstSeq: number,
  toSeqExclusive = Number.POSITIVE_INFINITY,
): Omit<DshRunResult, 'sessionId' | 'firstEventSeq' | 'lastEventSeq'> {
  let text = '';
  let reason: TurnEndReason | undefined;
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  const toolNames: string[] = [];
  const subagentCallIds = new Set<string>();
  const foregroundCallIds = new Set<string>();
  const completedCallIds = new Set<string>();
  const failedCallIds = new Set<string>();
  let completeTotalUsage = true;

  for (const event of events) {
    if (event.seq < firstSeq || event.seq >= toSeqExclusive) continue;
    if (event.type === 'assistant/message') {
      const currentText = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (currentText !== '') text = currentText;
      if (event.data.usage !== undefined) {
        aggregateUsage(usage, event.data.usage);
        if (event.data.usage.totalTokens === undefined) completeTotalUsage = false;
      } else {
        completeTotalUsage = false;
      }
    }
    if (event.type === 'turn/end') reason = event.data.reason;
    if (event.type === 'tool/call' && isSubagentTool(event.data.name)) {
      toolNames.push(event.data.name);
      subagentCallIds.add(String(event.data.callId));
      if (isForegroundSubagentCall(event.data.arguments)) {
        foregroundCallIds.add(String(event.data.callId));
      }
    }
    if (event.type === 'tool/result') {
      const message = event.data.message;
      const callId = String(message.toolCallId);
      if (subagentCallIds.has(callId)) {
        if (message.isError === true || event.data.error !== undefined) {
          failedCallIds.add(callId);
        } else if (foregroundCallIds.has(callId)) {
          completedCallIds.add(callId);
        }
      }
    }
  }

  if (!completeTotalUsage) delete usage.totalTokens;

  return {
    text,
    reason,
    usage,
    delegation: {
      subagentCalls: toolNames.length,
      completedCalls: completedCallIds.size,
      failedCalls: failedCallIds.size,
      toolNames,
    },
  };
}

export class InProcessDshRuntime implements DshRuntime {
  readonly #ctx: Context;

  constructor(ctx: Context) {
    this.#ctx = ctx;
  }

  async run(request: DshRunRequest): Promise<DshRunResult> {
    request.signal?.throwIfAborted();
    const agents = this.#ctx.get('agents');
    const sessions = this.#ctx.get('sessions');
    const persistence = this.#ctx.get('sessionPersistence');
    if (agents === undefined) throw new DshRuntimeUnavailableError('agents');
    if (sessions === undefined) throw new DshRuntimeUnavailableError('sessions');
    if (persistence === undefined) throw new DshRuntimeUnavailableError('sessionPersistence');

    const selection = {
      provider: request.provider,
      model: request.model,
      ...(request.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(request.reasoningEffort) }),
    };
    const setup: AgentSetup = async (agentCtx, agent) => {
      let agentPreset = request.agentPreset;
      if (request.sessionId !== undefined) {
        const projections = this.#ctx.get('sessionProjections');
        if (projections === undefined) {
          throw new DshRuntimeUnavailableError('sessionProjections');
        }
        const recordedPreset = projections.stateOf(agent.session, 'agentPreset');
        if (recordedPreset === undefined) {
          throw new DshRuntimeUnavailableError('sessionProjections.agentPreset');
        }
        if (agentPreset !== undefined && agentPreset !== recordedPreset) {
          throw new Error(
            `Cannot resume DSH session ${request.sessionId} with Agent Preset ${agentPreset}; its recorded preset is ${recordedPreset ?? '(none)'}`,
          );
        }
        agentPreset = recordedPreset ?? undefined;
      }
      if (agentPreset !== undefined) {
        const presets = this.#ctx.get('agentPresets');
        if (presets === undefined) throw new DshRuntimeUnavailableError('agentPresets');
        await presets.mount(agentCtx, agentPreset);
      }
      installModelSelection(agentCtx, { current: selection, assembled: undefined });
    };

    let handle: AgentHandle | undefined;
    const abort = (): void => handle?.agent.cancel({ kind: 'user' });
    return withDisposal(
      async () => {
        const options = {
          agentOptions: {
            ...selection,
            ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
          },
          setup,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        };

        handle =
          request.sessionId === undefined
            ? await agents.create({
                ...options,
                sessionId: SessionId(`bridge-${randomUUID()}`),
                meta: {
                  cwd: request.cwd,
                  origin: 'subagent',
                  delegationDepth: 1,
                  ...(request.agentPreset === undefined
                    ? {}
                    : { agentPreset: request.agentPreset }),
                },
              })
            : await agents.resume({
                ...options,
                resumeSessionId: SessionId(request.sessionId),
              });

        request.signal?.addEventListener('abort', abort, { once: true });
        // Factory cancellation is creation-only and detached before the handle is returned.
        // Recheck here so an abort in that handoff cannot submit a new turn.
        request.signal?.throwIfAborted();
        await handle.agent.whenIdle();
        request.signal?.throwIfAborted();
        if (!(await sessions.flush(handle.agent.session))) {
          throw new DshRuntimeUnavailableError('session/flush');
        }
        await request.onSessionReady?.(handle.agent.id);
        request.signal?.throwIfAborted();
        const firstEventSeq = handle.agent.session.seq;
        handle.agent.followup(
          createUserMessage({
            content: [{ type: 'text', text: request.prompt }],
            source: { kind: 'user' },
          }),
        );
        await handle.agent.whenIdle();
        const lastEventSeq = handle.agent.session.seq;
        if (!(await sessions.flush(handle.agent.session))) {
          throw new DshRuntimeUnavailableError('session/flush');
        }
        const log = await persistence.open(handle.agent.id, 'read');
        const summary = await withDisposal(
          async () => {
            const { events } = await log.read(firstEventSeq, lastEventSeq - firstEventSeq);
            if (events.length !== lastEventSeq - firstEventSeq) {
              throw new Error('DSH persisted session log is missing events from the current run');
            }
            return summarizeDshEvents(events, firstEventSeq, lastEventSeq);
          },
          () => log.close(),
        );

        return {
          sessionId: handle.agent.id,
          firstEventSeq,
          lastEventSeq,
          ...summary,
        };
      },
      async () => {
        request.signal?.removeEventListener('abort', abort);
        await handle?.dispose();
      },
    );
  }
}
