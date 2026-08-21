import { randomUUID } from 'node:crypto';

import type { Context } from '@deepseek-ai/cordis';
import { installModelSelection, type AgentHandle, type AgentSetup } from '@deepseek-ai/dsh-agent';
import { createUserMessage, ReasoningEffortId, type TokenUsage } from '@deepseek-ai/dsh-llm';
import { SessionId, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session';
import '@deepseek-ai/dsh-agent-presets';

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
}

export interface DshRunResult {
  readonly sessionId: string;
  readonly text: string;
  readonly reason: TurnEndReason | undefined;
  readonly usage: TokenUsage;
  /** Tool-call evidence observed only inside this run's event interval. */
  readonly delegation: DshDelegationEvidence;
  readonly firstEventSeq: number;
  readonly lastEventSeq: number;
}

export interface DshDelegationEvidence {
  readonly subagentCalls: number;
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
  target.cacheReadTokens = (target.cacheReadTokens ?? 0) + (value.cacheReadTokens ?? 0);
  target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + (value.cacheWriteTokens ?? 0);
  target.reasoningTokens = (target.reasoningTokens ?? 0) + (value.reasoningTokens ?? 0);
}

function isSubagentTool(name: string): boolean {
  return name === 'subagent' || name === 'subagent_fork' || name.startsWith('subagent_');
}

export function summarizeDshEvents(
  events: readonly SessionEvent[],
  firstSeq: number,
): Omit<DshRunResult, 'sessionId' | 'firstEventSeq' | 'lastEventSeq'> {
  let text = '';
  let reason: TurnEndReason | undefined;
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  const toolNames: string[] = [];
  const subagentCallIds = new Set<string>();
  const completedCallIds = new Set<string>();
  const failedCallIds = new Set<string>();

  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === 'assistant/message') {
      const currentText = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (currentText !== '') text = currentText;
      if (event.data.usage !== undefined) aggregateUsage(usage, event.data.usage);
    }
    if (event.type === 'turn/end') reason = event.data.reason;
    if (event.type === 'tool/call' && isSubagentTool(event.data.name)) {
      toolNames.push(event.data.name);
      subagentCallIds.add(String(event.data.callId));
    }
    if (event.type === 'tool/result') {
      const block = event.data.message.content[0];
      const callId = String(block.toolCallId);
      if (subagentCallIds.has(callId)) {
        if (block.isError === true || event.data.error !== undefined) {
          failedCallIds.add(callId);
        } else {
          completedCallIds.add(callId);
        }
      }
    }
  }

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
    const agents = this.#ctx.get('agents');
    const sessions = this.#ctx.get('sessions');
    if (agents === undefined) throw new DshRuntimeUnavailableError('agents');
    if (sessions === undefined) throw new DshRuntimeUnavailableError('sessions');

    const selection = {
      provider: request.provider,
      model: request.model,
      ...(request.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(request.reasoningEffort) }),
    };
    const setup: AgentSetup = async (agentCtx) => {
      if (request.agentPreset !== undefined) {
        const presets = this.#ctx.get('agentPresets');
        if (presets === undefined) throw new DshRuntimeUnavailableError('agentPresets');
        await presets.mount(agentCtx, request.agentPreset);
      }
      installModelSelection(agentCtx, { current: selection, assembled: undefined });
    };

    let handle: AgentHandle | undefined;
    const abort = (): void => handle?.agent.cancel({ kind: 'user' });
    try {
      const options = {
        agentOptions: {
          provider: request.provider,
          model: request.model,
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
                ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
              },
            })
          : await agents.resume({
              ...options,
              resumeSessionId: SessionId(request.sessionId),
            });

      request.signal?.addEventListener('abort', abort, { once: true });
      await handle.agent.whenIdle();
      const firstEventSeq = handle.agent.session.seq;
      handle.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: request.prompt }],
          source: { kind: 'user' },
        }),
      );
      await handle.agent.whenIdle();
      await sessions.flush(handle.agent.session);
      const summary = summarizeDshEvents(handle.agent.session.events, firstEventSeq);

      return {
        sessionId: handle.agent.id,
        firstEventSeq,
        lastEventSeq: handle.agent.session.seq,
        ...summary,
      };
    } finally {
      request.signal?.removeEventListener('abort', abort);
      await handle?.dispose();
    }
  }
}
