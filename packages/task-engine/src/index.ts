import { randomUUID } from 'node:crypto';

import type { ConfigRegistry } from '@dsh-codex-bridge/config';
import type { DshRunResult, DshRuntime } from '@dsh-codex-bridge/dsh-runtime';
import {
  DelegationStrategy,
  PROTOCOL_VERSION,
  TaskStatus,
  assertTaskStatusTransition,
  canTransitionTaskStatus,
  isTerminalTaskStatus,
  normalizeDelegationRequest,
  type ArtifactManifest,
  type ArtifactRef,
  type BridgeError,
  type BridgeErrorCode,
  type CancelTaskInput,
  type ContinueTaskInput,
  type DelegationDecision,
  type DelegationEvidence,
  type DelegationRequest,
  type DelegateTaskInput,
  type Profile,
  type ReadTaskArtifactOutput,
  type Task,
  type TaskDispatchReceipt,
  type TaskOperationReceipt,
  type TaskResult,
} from '@dsh-codex-bridge/protocol';
import {
  WorkspaceManager,
  type WorkspaceArtifacts,
  type WorkspaceHandle,
} from '@dsh-codex-bridge/workspace';

export * from './store.js';
import type {
  StoredOperationKind,
  StoredOperationReceipt,
  StoredTask,
  TaskStore,
} from './store.js';

const MAX_DELEGATION_EVIDENCE_CHILDREN = 128;

export interface PutArtifactInput {
  readonly kind: ArtifactRef['kind'];
  readonly name: string;
  readonly mediaType: string;
  readonly data: string | Uint8Array;
}

export interface ArtifactPort {
  put(taskId: string, input: PutArtifactInput): Promise<ArtifactRef>;
  manifest(taskId: string): Promise<ArtifactManifest>;
  read(
    taskId: string,
    artifactId: string,
    options: { offset: number; limit: number; expectedSha256?: string },
  ): Promise<ReadTaskArtifactOutput>;
}

export interface TaskEngineOptions {
  readonly config: ConfigRegistry;
  readonly store: TaskStore;
  readonly artifacts: ArtifactPort;
  readonly runtime: DshRuntime;
}

export interface ContinueTaskOptions {
  readonly expectedRunId?: string;
  readonly idempotencyKey?: string;
  readonly acceptanceCriteria?: readonly string[];
}

export interface CancelTaskOptions {
  readonly idempotencyKey?: string;
  readonly reason?: string;
}

export class TaskNotFoundError extends Error {
  readonly code = 'TASK_NOT_FOUND';

  constructor(taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = 'TaskNotFoundError';
  }
}

export class TaskConflictError extends Error {
  readonly code = 'TASK_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'TaskConflictError';
  }
}

function now(): string {
  return new Date().toISOString();
}

function identifier(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function receipt(task: Task): TaskDispatchReceipt {
  const status: TaskDispatchReceipt['status'] =
    task.status === TaskStatus.validating ||
    task.status === TaskStatus.preparing_workspace ||
    task.status === TaskStatus.running
      ? task.status
      : TaskStatus.queued;

  return {
    protocol_version: PROTOCOL_VERSION,
    task_id: task.task_id,
    trace_id: task.trace_id,
    project_id: task.project_id,
    workspace_id: task.workspace_id,
    profile_id: task.profile_id,
    status,
    created_at: task.created_at,
  };
}

function operationReceipt(
  task: Task,
  status: TaskOperationReceipt['status'],
): TaskOperationReceipt {
  return {
    protocol_version: PROTOCOL_VERSION,
    task_id: task.task_id,
    trace_id: task.trace_id,
    status,
    accepted_at: now(),
  };
}

function emptyManifest(): ArtifactManifest {
  return { artifacts: [], total_bytes: 0 };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 4_096 ? `${message.slice(0, 4_093)}...` : message;
}

function errorCode(error: unknown): BridgeErrorCode {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'DSH_RUNTIME_UNAVAILABLE') return 'BACKEND_UNAVAILABLE';
    if (code === 'RATE_LIMITED') return 'RATE_LIMITED';
    if (code === 'MODEL_NOT_FOUND') return 'MODEL_NOT_FOUND';
    if (code === 'REASONING_UNSUPPORTED') return 'REASONING_UNSUPPORTED';
    if (code === 'PERMISSION_DENIED') return 'PERMISSION_DENIED';
    if (code === 'BACKEND_UNAVAILABLE') return 'BACKEND_UNAVAILABLE';
  }
  return 'BACKEND_ERROR';
}

function taskError(code: BridgeErrorCode, message: string, retryable: boolean): BridgeError {
  return {
    protocol_version: PROTOCOL_VERSION,
    code,
    message: errorMessage(message),
    retryable,
  };
}

function errorForTerminalStatus(
  status: 'cancelled' | 'timed_out' | 'interrupted' | 'failed',
  cause?: unknown,
): BridgeError {
  if (status === 'cancelled') {
    return taskError('TASK_CANCELLED', errorMessage(cause ?? 'Task cancelled by caller'), false);
  }
  if (status === 'timed_out') {
    return taskError('TASK_TIMED_OUT', errorMessage(cause ?? 'Task timed out'), true);
  }
  if (status === 'interrupted') {
    return taskError('TASK_INTERRUPTED', errorMessage(cause ?? 'Task was interrupted'), true);
  }
  return taskError(errorCode(cause), errorMessage(cause ?? 'Task execution failed'), true);
}

function isTimeoutAbort(signal: AbortSignal): boolean {
  return signal.aborted && /timed out/i.test(String(signal.reason));
}

function isCancellationAbort(signal: AbortSignal): boolean {
  return signal.aborted && !isTimeoutAbort(signal);
}

export class TaskEngine {
  readonly #config: ConfigRegistry;
  readonly #store: TaskStore;
  readonly #artifacts: ArtifactPort;
  readonly #runtime: DshRuntime;
  readonly #controllers = new Map<string, AbortController>();
  readonly #waiters = new Map<string, Set<() => void>>();
  readonly #operationLocks = new Map<string, Promise<void>>();

  constructor(options: TaskEngineOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#artifacts = options.artifacts;
    this.#runtime = options.runtime;
  }

  listProfiles() {
    return {
      protocol_version: PROTOCOL_VERSION,
      profiles: this.#config.profileSummaries(),
    } as const;
  }

  async delegate(input: DelegateTaskInput): Promise<TaskDispatchReceipt> {
    return this.#withOperationLock(
      input.idempotency_key === undefined ? undefined : `delegate:${input.idempotency_key}`,
      async () => {
        const existing = await this.#findIdempotent(input.idempotency_key);
        if (existing !== undefined) return receipt(existing.task);

        const project = this.#config.project(input.project_id);
        const profile = this.#config.profile(input.profile_id);
        const createdAt = now();
        const { request: delegation, decision: delegationDecision } = this.#resolveDelegation(
          input,
          profile,
          createdAt,
        );
        const taskId = identifier('task');
        const task: Task = {
          protocol_version: PROTOCOL_VERSION,
          task_id: taskId,
          trace_id: input.trace_id ?? identifier('trace'),
          origin: input.origin ?? 'codex',
          delegation_depth: input.delegation_depth ?? 0,
          project_id: project.project_id,
          workspace_id: identifier('workspace'),
          profile_id: profile.profile_id,
          objective: input.objective,
          acceptance_criteria: input.acceptance_criteria ?? [],
          delegation,
          delegation_decision: delegationDecision,
          status: TaskStatus.validating,
          run_id: identifier('run'),
          created_at: createdAt,
          updated_at: createdAt,
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        };
        const record: StoredTask = {
          task,
          project_root: project.root,
          base_ref: input.workspace?.base_ref ?? 'HEAD',
          ...(input.idempotency_key === undefined
            ? {}
            : { idempotency_key: input.idempotency_key }),
        };
        await this.#store.save(record);
        const queued = await this.#transition(record, TaskStatus.queued);
        this.#schedule(queued, profile);
        return receipt(queued.task);
      },
    );
  }

  async get(taskId: string): Promise<Task> {
    return (await this.#required(taskId)).task;
  }

  async result(taskId: string): Promise<TaskResult> {
    const record = await this.#required(taskId);
    if (record.result === undefined) {
      throw new TaskConflictError(`Task ${taskId} has no result while ${record.task.status}`);
    }
    return record.result;
  }

  async readArtifact(
    taskId: string,
    artifactId: string,
    options: { offset: number; limit: number; expectedSha256?: string },
  ): Promise<ReadTaskArtifactOutput> {
    await this.#required(taskId);
    return this.#artifacts.read(taskId, artifactId, options);
  }

  async continue(input: ContinueTaskInput): Promise<TaskDispatchReceipt>;
  async continue(
    taskId: string,
    feedback: string,
    options?: ContinueTaskOptions,
  ): Promise<TaskDispatchReceipt>;
  async continue(
    inputOrTaskId: ContinueTaskInput | string,
    feedback?: string,
    options?: ContinueTaskOptions,
  ): Promise<TaskDispatchReceipt> {
    const request =
      typeof inputOrTaskId === 'string'
        ? {
            taskId: inputOrTaskId,
            feedback: feedback ?? '',
            expectedRunId: options?.expectedRunId,
            idempotencyKey: options?.idempotencyKey,
            acceptanceCriteria: options?.acceptanceCriteria,
          }
        : {
            taskId: inputOrTaskId.task_id,
            feedback: inputOrTaskId.feedback,
            expectedRunId: inputOrTaskId.expected_run_id,
            idempotencyKey: inputOrTaskId.idempotency_key,
            acceptanceCriteria: inputOrTaskId.acceptance_criteria,
          };

    if (request.feedback.trim().length === 0) {
      throw new TaskConflictError('Continuation feedback must not be empty');
    }

    const lockKey = `continue:${request.taskId}:${request.idempotencyKey ?? 'serial'}`;
    return this.#withOperationLock(lockKey, async () => {
      let record = await this.#required(request.taskId);
      const existing = this.#operationReceipt(record, request.idempotencyKey, 'continue');
      if (existing !== undefined) return existing as TaskDispatchReceipt;

      if (!canTransitionTaskStatus(record.task.status, TaskStatus.queued)) {
        throw new TaskConflictError(
          `Task ${request.taskId} cannot continue while ${record.task.status}`,
        );
      }
      if (record.session_id === undefined) {
        throw new TaskConflictError(
          `Task ${request.taskId} has no persisted DSH session to continue`,
        );
      }
      if (request.expectedRunId !== undefined && record.task.run_id !== request.expectedRunId) {
        throw new TaskConflictError(
          `Task ${request.taskId} run_id changed; expected ${request.expectedRunId}, found ${record.task.run_id ?? 'none'}`,
        );
      }

      const profile = this.#config.profile(record.task.profile_id);
      const previousResult = record.result;
      const resultHistory =
        previousResult === undefined
          ? record.result_history
          : [...(record.result_history ?? []), previousResult];
      const nextTask: Task = {
        ...record.task,
        objective: request.feedback,
        acceptance_criteria:
          request.acceptanceCriteria === undefined
            ? record.task.acceptance_criteria
            : [...request.acceptanceCriteria],
        run_id: identifier('run'),
      };
      delete nextTask.error;
      delete nextTask.delegation_evidence;
      delete nextTask.started_at;
      delete nextTask.finished_at;

      const recordWithoutResult = { ...record };
      delete recordWithoutResult.result;
      const nextRecord: StoredTask = {
        ...recordWithoutResult,
        task: nextTask,
        ...(resultHistory === undefined ? {} : { result_history: resultHistory }),
      };
      record = await this.#transition(nextRecord, TaskStatus.queued, {
        clearFinished: true,
      });

      const dispatch = receipt(record.task);
      if (request.idempotencyKey !== undefined) {
        record = await this.#rememberOperation(
          record,
          request.idempotencyKey,
          'continue',
          dispatch,
        );
      }
      this.#schedule(record, profile);
      return dispatch;
    });
  }

  async cancel(input: CancelTaskInput): Promise<TaskOperationReceipt>;
  async cancel(taskId: string, options?: CancelTaskOptions): Promise<TaskOperationReceipt>;
  async cancel(
    inputOrTaskId: CancelTaskInput | string,
    options?: CancelTaskOptions,
  ): Promise<TaskOperationReceipt> {
    const request =
      typeof inputOrTaskId === 'string'
        ? {
            taskId: inputOrTaskId,
            idempotencyKey: options?.idempotencyKey,
            reason: options?.reason,
          }
        : {
            taskId: inputOrTaskId.task_id,
            idempotencyKey: undefined,
            reason: inputOrTaskId.reason,
          };
    const lockKey = `cancel:${request.taskId}:${request.idempotencyKey ?? 'serial'}`;

    return this.#withOperationLock(lockKey, async () => {
      let record = await this.#required(request.taskId);
      const existing = this.#operationReceipt(record, request.idempotencyKey, 'cancel');
      if (existing !== undefined) return existing as TaskOperationReceipt;

      let result: TaskOperationReceipt;
      if (record.task.status === TaskStatus.queued) {
        const error = errorForTerminalStatus(
          'cancelled',
          request.reason ?? 'Task cancelled before execution',
        );
        record = await this.#finalizeTerminal(record, TaskStatus.cancelled, error);
        result = operationReceipt(record.task, TaskStatus.cancelled);
      } else if (record.task.status === TaskStatus.running) {
        const cancelling = await this.#transition(record, TaskStatus.cancelling);
        const controller = this.#controllers.get(request.taskId);
        if (controller === undefined) {
          record = await this.#finalizeTerminal(
            cancelling,
            TaskStatus.cancelled,
            errorForTerminalStatus('cancelled', request.reason),
          );
          result = operationReceipt(record.task, TaskStatus.cancelled);
        } else {
          controller.abort(new Error(request.reason ?? 'Cancelled by Codex'));
          result = operationReceipt(cancelling.task, TaskStatus.cancelling);
          record = cancelling;
        }
      } else if (
        record.task.status === TaskStatus.cancelling ||
        record.task.status === TaskStatus.cancelled
      ) {
        result = operationReceipt(record.task, record.task.status);
      } else {
        throw new TaskConflictError(
          `Task ${request.taskId} cannot cancel while ${record.task.status}`,
        );
      }

      if (request.idempotencyKey !== undefined) {
        await this.#rememberOperation(record, request.idempotencyKey, 'cancel', result);
      }
      return result;
    });
  }

  async wait(taskId: string, timeoutSeconds: number): Promise<Task> {
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 30) {
      throw new TaskConflictError('wait timeout must be between 0 and 30 seconds');
    }
    const initial = await this.get(taskId);
    if (isTerminalTaskStatus(initial.status) || timeoutSeconds === 0) return initial;

    await new Promise<void>((resolveWait) => {
      const listeners = this.#waiters.get(taskId) ?? new Set<() => void>();
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        listeners.delete(finish);
        if (listeners.size === 0) this.#waiters.delete(taskId);
        resolveWait();
      };
      const timer = setTimeout(finish, timeoutSeconds * 1_000);
      listeners.add(finish);
      this.#waiters.set(taskId, listeners);
      void this.#store.get(taskId).then((latest) => {
        if (
          latest !== undefined &&
          (latest.task.status !== initial.status ||
            latest.task.updated_at !== initial.updated_at ||
            latest.task.run_id !== initial.run_id)
        ) {
          finish();
        }
      });
    });
    return this.get(taskId);
  }

  async reconcile(): Promise<void> {
    for (const stored of await this.#store.list()) {
      if (this.#controllers.has(stored.task.task_id)) continue;
      let record = await this.#ensureRunId(stored);
      if (record.task.status === TaskStatus.queued) {
        this.#schedule(record, this.#config.profile(record.task.profile_id));
        continue;
      }
      if (record.task.status === TaskStatus.validating) {
        record = await this.#transition(record, TaskStatus.queued);
        this.#schedule(record, this.#config.profile(record.task.profile_id));
        continue;
      }
      if (
        record.task.status === TaskStatus.preparing_workspace ||
        record.task.status === TaskStatus.running ||
        record.task.status === TaskStatus.waiting_input ||
        record.task.status === TaskStatus.collecting ||
        record.task.status === TaskStatus.cancelling
      ) {
        await this.#finalizeTerminal(
          record,
          TaskStatus.interrupted,
          errorForTerminalStatus('interrupted'),
        );
      }
    }
  }

  #schedule(record: StoredTask, profile: Profile): void {
    queueMicrotask(() => void this.#execute(record, profile));
  }

  async #execute(record: StoredTask, profile: Profile): Promise<void> {
    const latest = await this.#store.get(record.task.task_id);
    if (latest === undefined || latest.task.status !== TaskStatus.queued) return;

    const controller = new AbortController();
    this.#controllers.set(record.task.task_id, controller);
    const timeout = setTimeout(
      () => controller.abort(new Error('Task timed out')),
      profile.policy.timeout_seconds * 1_000,
    );
    let current = await this.#ensureRunId(latest);
    let manager: WorkspaceManager | undefined;
    let workspace: WorkspaceHandle | undefined;
    let runtimeResult: DshRunResult | undefined;
    try {
      current = await this.#transition(current, TaskStatus.preparing_workspace);
      manager = new WorkspaceManager({
        allowedRoots: profile.workspace.allowed_roots,
        worktreesRoot: `${this.#config.value.data_root}/worktrees/${current.task.project_id}`,
      });
      workspace =
        current.workspace ??
        (await manager.create(current.task.task_id, current.project_root, current.base_ref));
      current = { ...current, workspace };
      await this.#store.save(current);
      current = await this.#transition(current, TaskStatus.running, { started: true });

      runtimeResult = await this.#runtime.run({
        cwd: workspace.path,
        prompt: this.#taskPrompt(current.task, profile),
        provider: profile.dsh.provider,
        model: profile.dsh.model,
        ...(profile.dsh.reasoning_effort === undefined
          ? {}
          : { reasoningEffort: profile.dsh.reasoning_effort }),
        maxTokens: profile.dsh.max_tokens,
        agentPreset: profile.dsh.agent_preset,
        ...(current.session_id === undefined ? {} : { sessionId: current.session_id }),
        signal: controller.signal,
      });
      const latestAfterRun = await this.#store.get(current.task.task_id);
      if (controller.signal.aborted || latestAfterRun?.task.status === TaskStatus.cancelling) {
        throw controller.signal.reason ?? new Error('Task cancellation requested');
      }
      current = { ...current, session_id: runtimeResult.sessionId };
      await this.#store.save(current);
      current = await this.#transition(current, TaskStatus.collecting);
      current = await this.#collect(current, manager, workspace, profile, runtimeResult);
      const terminal =
        runtimeResult.reason?.kind === 'completed' &&
        this.#delegationWarnings(current.task, profile, runtimeResult).length === 0
          ? TaskStatus.completed
          : TaskStatus.partial;
      current = await this.#transition(current, terminal, { finished: true });
      if (current.result !== undefined) {
        current = {
          ...current,
          result: { ...current.result, status: terminal, completed_at: now() },
        };
        await this.#store.save(current);
      }
      this.#notify(current.task.task_id);
    } catch (error) {
      current = (await this.#store.get(record.task.task_id)) ?? current;
      if (isTerminalTaskStatus(current.task.status)) {
        return;
      }
      const timedOut = isTimeoutAbort(controller.signal);
      const cancelled =
        current.task.status === TaskStatus.cancelling || isCancellationAbort(controller.signal);
      const terminal = cancelled
        ? TaskStatus.cancelled
        : timedOut
          ? TaskStatus.timed_out
          : TaskStatus.failed;
      const terminalError = errorForTerminalStatus(
        terminal,
        terminal === TaskStatus.failed ? error : (controller.signal.reason ?? error),
      );

      if (manager !== undefined && workspace !== undefined && current.result === undefined) {
        try {
          current = await this.#collect(current, manager, workspace, profile, runtimeResult);
        } catch {
          // Preserve the primary execution error even if post-failure collection fails.
        }
      }
      await this.#finalizeTerminal(current, terminal, terminalError);
    } finally {
      clearTimeout(timeout);
      this.#controllers.delete(record.task.task_id);
    }
  }

  async #collect(
    record: StoredTask,
    manager: WorkspaceManager,
    workspace: WorkspaceHandle,
    profile: Profile,
    runtime?: DshRunResult,
  ): Promise<StoredTask> {
    const workspaceArtifacts = await manager.collect(workspace);
    await Promise.all([
      this.#artifacts.put(record.task.task_id, {
        kind: 'patch',
        name: 'changes.patch',
        mediaType: 'text/x-diff',
        data: workspaceArtifacts.patch,
      }),
      this.#artifacts.put(record.task.task_id, {
        kind: 'changed_files',
        name: 'git-status.txt',
        mediaType: 'text/plain',
        data: workspaceArtifacts.status,
      }),
      this.#artifacts.put(record.task.task_id, {
        kind: 'summary',
        name: 'agent-summary.md',
        mediaType: 'text/markdown',
        data: runtime?.text || 'DSH completed without a textual summary.',
      }),
    ]);
    const manifest = await this.#artifacts.manifest(record.task.task_id);
    const delegationEvidence = this.#delegationEvidence(record.task, runtime);
    const task =
      delegationEvidence === undefined
        ? record.task
        : { ...record.task, delegation_evidence: delegationEvidence };
    const result = this.#makeResult(task, workspaceArtifacts, profile, runtime, manifest);
    const updated = { ...record, task, result };
    await this.#store.save(updated);
    return updated;
  }

  #makeResult(
    task: Task,
    workspace: WorkspaceArtifacts,
    profile: Profile,
    runtime: DshRunResult | undefined,
    artifacts: ArtifactManifest,
  ): TaskResult {
    const changedFiles = workspace.changedFiles.map((path) => ({
      path,
      status: 'modified' as const,
      additions: 0,
      deletions: 0,
      binary: false,
    }));
    return {
      protocol_version: PROTOCOL_VERSION,
      task_id: task.task_id,
      run_id: task.run_id ?? identifier('run'),
      trace_id: task.trace_id,
      status: TaskStatus.partial,
      summary: runtime?.text || 'DSH completed without a textual summary.',
      acceptance: [],
      changed_files: changedFiles,
      diff_stat: {
        files_changed: changedFiles.length,
        insertions: 0,
        deletions: 0,
        binary_files: 0,
      },
      tests: [],
      warnings: [
        ...(runtime?.reason?.kind === 'completed'
          ? []
          : [`DSH ended with ${runtime?.reason?.kind ?? 'unknown'}.`]),
        ...this.#delegationWarnings(task, profile, runtime),
      ],
      artifacts,
      ...(task.delegation_decision === undefined
        ? {}
        : { delegation_decision: task.delegation_decision }),
      ...(task.delegation_evidence === undefined
        ? {}
        : { delegation_evidence: task.delegation_evidence }),
      ...(runtime === undefined
        ? {}
        : {
            usage: {
              input_tokens: runtime.usage.inputTokens,
              output_tokens: runtime.usage.outputTokens,
              total_tokens: runtime.usage.inputTokens + runtime.usage.outputTokens,
              providers: [],
            },
          }),
      ...(task.started_at === undefined ? {} : { started_at: task.started_at }),
      completed_at: now(),
    };
  }

  #makeErrorResult(task: Task, error: BridgeError, artifacts: ArtifactManifest): TaskResult {
    const status =
      error.code === 'TASK_INTERRUPTED'
        ? TaskStatus.interrupted
        : error.code === 'TASK_CANCELLED'
          ? TaskStatus.cancelled
          : error.code === 'TASK_TIMED_OUT'
            ? TaskStatus.timed_out
            : TaskStatus.failed;
    return {
      protocol_version: PROTOCOL_VERSION,
      task_id: task.task_id,
      run_id: task.run_id ?? identifier('run'),
      trace_id: task.trace_id,
      status,
      summary: error.message,
      acceptance: [],
      changed_files: [],
      diff_stat: { files_changed: 0, insertions: 0, deletions: 0, binary_files: 0 },
      tests: [],
      warnings: [error.message],
      artifacts,
      ...(task.delegation_decision === undefined
        ? {}
        : { delegation_decision: task.delegation_decision }),
      ...(task.delegation_evidence === undefined
        ? {}
        : { delegation_evidence: task.delegation_evidence }),
      ...(task.started_at === undefined ? {} : { started_at: task.started_at }),
      completed_at: now(),
      error,
    };
  }

  async #finalizeTerminal(
    record: StoredTask,
    status: 'cancelled' | 'timed_out' | 'interrupted' | 'failed',
    error: BridgeError,
  ): Promise<StoredTask> {
    const artifacts = record.result?.artifacts ?? (await this.#safeManifest(record.task.task_id));
    const completedAt = now();
    const result =
      record.result === undefined
        ? this.#makeErrorResult(record.task, error, artifacts)
        : { ...record.result, status, completed_at: completedAt, error };
    const task: Task = { ...record.task, error };
    const candidate: StoredTask = { ...record, task, result };
    const transitioned = await this.#transition(candidate, status, {
      finished: true,
      force: !canTransitionTaskStatus(record.task.status, status),
    });
    const final: StoredTask = {
      ...transitioned,
      result: { ...result, status, completed_at: completedAt, error },
    };
    await this.#store.save(final);
    this.#notify(final.task.task_id);
    return final;
  }

  async #safeManifest(taskId: string): Promise<ArtifactManifest> {
    try {
      return await this.#artifacts.manifest(taskId);
    } catch {
      return emptyManifest();
    }
  }

  #resolveDelegation(
    input: DelegateTaskInput,
    profile: Profile,
    decidedAt: string,
  ): { request: DelegationRequest; decision: DelegationDecision } {
    const depth = input.delegation_depth ?? 0;
    if (depth > profile.delegation.max_depth) {
      throw new TaskConflictError(
        `Delegation depth ${depth} exceeds Profile limit ${profile.delegation.max_depth}`,
      );
    }

    const request = normalizeDelegationRequest(input.delegation);
    const unknownRoles = request.roles.filter(
      (role) => !Object.hasOwn(profile.delegation.roles, role),
    );
    if (unknownRoles.length > 0) {
      throw new TaskConflictError(`Unknown delegation roles: ${unknownRoles.join(', ')}`);
    }
    if (request.roles.length > profile.delegation.max_children) {
      throw new TaskConflictError(
        `Requested ${request.roles.length} roles exceed Profile child limit ${profile.delegation.max_children}`,
      );
    }

    const resolvedStrategy =
      request.strategy === DelegationStrategy.auto
        ? request.roles.length > 0
          ? DelegationStrategy.multi
          : DelegationStrategy.single
        : request.strategy;
    if (resolvedStrategy === DelegationStrategy.single && request.roles.length > 0) {
      throw new TaskConflictError('A single-Agent delegation cannot request child roles');
    }
    if (resolvedStrategy === DelegationStrategy.multi && profile.delegation.max_children === 0) {
      throw new TaskConflictError(`Profile ${profile.profile_id} does not allow child Agents`);
    }

    const reason =
      request.reason ??
      (request.strategy === DelegationStrategy.auto
        ? resolvedStrategy === DelegationStrategy.multi
          ? `Bridge selected multi because ${request.roles.length} bounded child role(s) were requested.`
          : 'Bridge selected single because no independent child roles were requested.'
        : `Codex explicitly selected ${resolvedStrategy}.`);
    return {
      request,
      decision: {
        strategy: request.strategy,
        resolved_strategy: resolvedStrategy,
        reason,
        roles: [...request.roles],
        decided_by:
          request.strategy === DelegationStrategy.auto ? ('bridge' as const) : ('codex' as const),
        decided_at: decidedAt,
      },
    };
  }

  #expectedChildCalls(task: Task): number {
    if (task.delegation_decision?.resolved_strategy !== DelegationStrategy.multi) return 0;
    return Math.max(1, task.delegation_decision.roles.length);
  }

  #delegationEvidence(task: Task, runtime?: DshRunResult): DelegationEvidence | undefined {
    if (runtime === undefined) return undefined;
    const observed = runtime.delegation;
    if (
      observed.subagentCalls > MAX_DELEGATION_EVIDENCE_CHILDREN ||
      observed.completedCalls > MAX_DELEGATION_EVIDENCE_CHILDREN ||
      observed.failedCalls > MAX_DELEGATION_EVIDENCE_CHILDREN
    ) {
      throw new TaskConflictError(
        `DSH delegation evidence exceeds the protocol limit of ${MAX_DELEGATION_EVIDENCE_CHILDREN} child calls`,
      );
    }
    return {
      children_requested: observed.subagentCalls,
      children_completed: observed.completedCalls,
      children_failed: observed.failedCalls,
      child_task_ids: [],
      roles: [...(task.delegation_decision?.roles ?? [])],
      observed: {
        subagent_calls: observed.subagentCalls,
        tool_names: [...observed.toolNames],
      },
      source: 'dsh',
      summary: `${observed.subagentCalls} child call(s), ${observed.completedCalls} completed, ${observed.failedCalls} failed.`,
      recorded_at: now(),
    };
  }

  #delegationWarnings(task: Task, profile: Profile, runtime?: DshRunResult): string[] {
    if (runtime === undefined || task.delegation_decision === undefined) return [];
    const observed = runtime.delegation;
    const expected = this.#expectedChildCalls(task);
    const warnings: string[] = [];

    if (
      task.delegation_decision.resolved_strategy === DelegationStrategy.single &&
      observed.subagentCalls > 0
    ) {
      warnings.push(
        `Single-Agent policy was violated: DSH made ${observed.subagentCalls} child call(s).`,
      );
    }
    if (
      task.delegation_decision.resolved_strategy === DelegationStrategy.multi &&
      observed.subagentCalls < expected
    ) {
      warnings.push(
        `Multi-Agent evidence is incomplete: expected at least ${expected} child call(s), observed ${observed.subagentCalls}.`,
      );
    }
    if (
      task.delegation_decision.resolved_strategy === DelegationStrategy.multi &&
      observed.completedCalls < expected
    ) {
      warnings.push(
        `Multi-Agent completion evidence is incomplete: expected ${expected} completed child call(s), observed ${observed.completedCalls}.`,
      );
    }
    if (observed.subagentCalls > profile.delegation.max_children) {
      warnings.push(
        `DSH exceeded the Profile child limit: ${observed.subagentCalls}/${profile.delegation.max_children}.`,
      );
    }
    if (observed.failedCalls > 0) {
      warnings.push(`${observed.failedCalls} DSH child call(s) failed.`);
    }
    return warnings;
  }

  #taskPrompt(task: Task, profile: Profile): string {
    const acceptance = task.acceptance_criteria.length
      ? task.acceptance_criteria.map((item, index) => `${index + 1}. ${item}`).join('\n')
      : 'No additional acceptance criteria were supplied.';
    const decision = task.delegation_decision;
    const expectedChildren = this.#expectedChildCalls(task);
    const delegation =
      decision?.resolved_strategy === DelegationStrategy.multi
        ? [
            'Delegation policy: multi Agent.',
            `Call available DSH subagent tools at least ${expectedChildren} time(s) and no more than ${profile.delegation.max_children} time(s).`,
            decision.roles.length === 0
              ? 'Choose bounded, independently useful child assignments.'
              : `Use these child roles: ${decision.roles.join(', ')}.`,
            'Do not perform the assigned child work yourself. Integrate and verify the child results in this workspace.',
          ].join('\n')
        : [
            'Delegation policy: single Agent.',
            'Do not call subagent, subagent_fork, or any provider-specific subagent tool.',
          ].join('\n');
    return [
      'You are the implementation worker for a Codex-reviewed task.',
      'Work only inside the current workspace. Make the requested changes and verify them.',
      '',
      delegation,
      '',
      'Objective:',
      task.objective,
      '',
      'Acceptance criteria:',
      acceptance,
      '',
      'Finish with a concise summary of changes and verification evidence.',
    ].join('\n');
  }

  async #required(taskId: string): Promise<StoredTask> {
    const record = await this.#store.get(taskId);
    if (record === undefined) throw new TaskNotFoundError(taskId);
    return record;
  }

  async #findIdempotent(key: string | undefined): Promise<StoredTask | undefined> {
    if (key === undefined) return undefined;
    return (await this.#store.list()).find((record) => record.idempotency_key === key);
  }

  #operationReceipt(
    record: StoredTask,
    key: string | undefined,
    kind: StoredOperationKind,
  ): TaskDispatchReceipt | TaskOperationReceipt | undefined {
    if (key === undefined) return undefined;
    const stored = record.operation_receipts?.[key];
    if (stored === undefined) return undefined;
    if (stored.kind !== kind) {
      throw new TaskConflictError(`Idempotency key already belongs to ${stored.kind}`);
    }
    return stored.receipt;
  }

  async #rememberOperation(
    record: StoredTask,
    key: string,
    kind: StoredOperationKind,
    value: TaskDispatchReceipt | TaskOperationReceipt,
  ): Promise<StoredTask> {
    const stored: StoredOperationReceipt = { kind, receipt: value };
    const updated: StoredTask = {
      ...record,
      operation_receipts: {
        ...(record.operation_receipts ?? {}),
        [key]: stored,
      },
    };
    await this.#store.save(updated);
    return updated;
  }

  async #ensureRunId(record: StoredTask): Promise<StoredTask> {
    if (record.task.run_id !== undefined) return record;
    const updated: StoredTask = {
      ...record,
      task: { ...record.task, run_id: identifier('run'), updated_at: now() },
    };
    await this.#store.save(updated);
    return updated;
  }

  async #transition(
    record: StoredTask,
    status: TaskStatus,
    options: {
      started?: boolean;
      finished?: boolean;
      clearFinished?: boolean;
      force?: boolean;
    } = {},
  ): Promise<StoredTask> {
    if (!options.force) assertTaskStatusTransition(record.task.status, status);
    const timestamp = now();
    const task: Task = { ...record.task, status, updated_at: timestamp };
    if (options.clearFinished) delete task.finished_at;
    if (options.started) task.started_at = timestamp;
    if (options.finished) task.finished_at = timestamp;
    const updated = { ...record, task };
    await this.#store.save(updated);
    this.#notify(task.task_id);
    return updated;
  }

  async #withOperationLock<T>(key: string | undefined, operation: () => Promise<T>): Promise<T> {
    if (key === undefined) return operation();
    const previous = this.#operationLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#operationLocks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#operationLocks.get(key) === queued) this.#operationLocks.delete(key);
    }
  }

  #notify(taskId: string): void {
    const listeners = this.#waiters.get(taskId);
    if (listeners === undefined) return;
    this.#waiters.delete(taskId);
    for (const listener of listeners) listener();
  }
}
