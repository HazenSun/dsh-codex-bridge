import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { ConfigRegistry } from '@dsh-codex-bridge/config';
import type {
  DshDelegationEvidence,
  DshRunRequest,
  DshRunResult,
  DshRuntime,
} from '@dsh-codex-bridge/dsh-runtime';
import {
  PROTOCOL_VERSION,
  TaskStatus,
  type ArtifactManifest,
  type ArtifactRef,
  type DelegateTaskInput,
  type ReadTaskArtifactOutput,
  type Task,
  TaskResultSchema,
} from '@dsh-codex-bridge/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  FileTaskStore,
  MemoryTaskStore,
  TaskConflictError,
  TaskEngine,
  type ArtifactPort,
  type PutArtifactInput,
} from './index.js';

const execFileAsync = promisify(execFile);

class MemoryArtifacts implements ArtifactPort {
  readonly #entries = new Map<string, Map<string, { ref: ArtifactRef; data: string }>>();

  async put(taskId: string, input: PutArtifactInput): Promise<ArtifactRef> {
    const data =
      typeof input.data === 'string' ? input.data : Buffer.from(input.data).toString('base64');
    const sha256 = createHash('sha256').update(data).digest('hex');
    const ref: ArtifactRef = {
      artifact_id: sha256,
      task_id: taskId,
      kind: input.kind,
      name: input.name,
      media_type: input.mediaType,
      encoding: 'utf8',
      bytes: Buffer.byteLength(data),
      sha256,
      uri: `artifact://${taskId}/${sha256}`,
      created_at: new Date().toISOString(),
    };
    const task = this.#entries.get(taskId) ?? new Map<string, { ref: ArtifactRef; data: string }>();
    task.set(sha256, { ref, data });
    this.#entries.set(taskId, task);
    return ref;
  }

  async manifest(taskId: string): Promise<ArtifactManifest> {
    const artifacts = [...(this.#entries.get(taskId)?.values() ?? [])].map((entry) => entry.ref);
    return { artifacts, total_bytes: artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0) };
  }

  async read(
    taskId: string,
    artifactId: string,
    options: { offset: number; limit: number; expectedSha256?: string },
  ): Promise<ReadTaskArtifactOutput> {
    const entry = this.#entries.get(taskId)?.get(artifactId);
    if (entry === undefined) throw new Error('artifact not found');
    if (options.expectedSha256 !== undefined && options.expectedSha256 !== entry.ref.sha256) {
      throw new Error('artifact hash mismatch');
    }
    const data = entry.data.slice(options.offset, options.offset + options.limit);
    const nextOffset = options.offset + data.length;
    return {
      protocol_version: PROTOCOL_VERSION,
      artifact: entry.ref,
      offset: options.offset,
      data,
      next_offset: nextOffset,
      eof: nextOffset >= entry.data.length,
    };
  }
}

class WritingRuntime implements DshRuntime {
  readonly calls: DshRunRequest[] = [];

  constructor(
    readonly delegation: DshDelegationEvidence = {
      subagentCalls: 0,
      completedCalls: 0,
      failedCalls: 0,
      toolNames: [],
    },
  ) {}

  async run(request: DshRunRequest): Promise<DshRunResult> {
    this.calls.push(request);
    await writeFile(join(request.cwd, 'generated.txt'), `run-${this.calls.length}\n`);
    return {
      sessionId: request.sessionId ?? 'bridge-test-session',
      text: `completed run ${this.calls.length}`,
      reason: { kind: 'completed' },
      usage: { inputTokens: 10, outputTokens: 5 },
      delegation: this.delegation,
      firstEventSeq: 0,
      lastEventSeq: 1,
    };
  }
}

class BlockingRuntime implements DshRuntime {
  startedResolve!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.startedResolve = resolve;
  });

  async run(request: DshRunRequest): Promise<DshRunResult> {
    this.startedResolve();
    await new Promise<void>((_resolve, reject) => {
      request.signal?.addEventListener(
        'abort',
        () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })),
        { once: true },
      );
    });
    throw new Error('unreachable');
  }
}

let projectRoot: string;
let dataRoot: string;

async function fixture(): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'dsh-task-engine-'));
  projectRoot = join(base, 'project');
  dataRoot = join(base, 'data');
  await execFileAsync('git', ['init', '-q', projectRoot]);
  await execFileAsync('git', ['-C', projectRoot, 'config', 'user.name', 'Bridge Test']);
  await execFileAsync('git', ['-C', projectRoot, 'config', 'user.email', 'bridge@example.test']);
  await writeFile(join(projectRoot, 'README.md'), 'fixture\n');
  await execFileAsync('git', ['-C', projectRoot, 'add', 'README.md']);
  await execFileAsync('git', ['-C', projectRoot, 'commit', '-qm', 'fixture']);
  projectRoot = await realpath(projectRoot);
}

function registry(): ConfigRegistry {
  return new ConfigRegistry({
    protocol_version: PROTOCOL_VERSION,
    data_root: dataRoot,
    log_level: 'silent',
    projects: [{ project_id: 'fixture', root: projectRoot, default_profile: 'writer' }],
    profiles: [
      {
        protocol_version: PROTOCOL_VERSION,
        profile_id: 'writer',
        description: 'Deterministic test writer.',
        dsh: {
          provider: 'test-provider',
          model: 'test-model',
          reasoning_effort: 'high',
          agent_preset: 'standard',
          max_tokens: 4_096,
        },
        delegation: {
          max_depth: 1,
          max_children: 1,
          roles: {
            reviewer: {
              provider: 'test-provider',
              model: 'test-model',
              description: 'Review the implementation independently.',
            },
          },
        },
        workspace: { mode: 'isolated_worktree', allowed_roots: [projectRoot] },
        policy: {
          network: 'off',
          allowed_domains: [],
          denied_paths: ['.env'],
          timeout_seconds: 30,
          max_artifact_bytes: 1_048_576,
          max_output_bytes: 262_144,
          max_files: 20,
          disk_quota_bytes: 104_857_600,
        },
      },
    ],
  });
}

function delegateInput(key = 'delegate-key'): DelegateTaskInput {
  return {
    protocol_version: PROTOCOL_VERSION,
    project_id: 'fixture',
    profile_id: 'writer',
    objective: 'Create generated.txt.',
    acceptance_criteria: ['generated.txt exists'],
    idempotency_key: key,
  };
}

async function terminal(engine: TaskEngine, taskId: string): Promise<Task> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const task = await engine.wait(taskId, 1);
    if (
      ['completed', 'partial', 'cancelled', 'timed_out', 'interrupted', 'failed'].includes(
        task.status,
      )
    ) {
      return task;
    }
  }
  throw new Error('task did not become terminal');
}

beforeEach(fixture);

describe('TaskEngine', () => {
  it('runs an isolated task and returns content-addressed evidence', async () => {
    const runtime = new WritingRuntime();
    const engine = new TaskEngine({
      config: registry(),
      store: new MemoryTaskStore(),
      artifacts: new MemoryArtifacts(),
      runtime,
    });
    const receipt = await engine.delegate(delegateInput());
    const task = await terminal(engine, receipt.task_id);
    const result = await engine.result(task.task_id);

    expect(task.status).toBe(TaskStatus.completed);
    expect(result.run_id).toBe(task.run_id);
    expect(result.artifacts.artifacts.map((artifact) => artifact.kind)).toContain('patch');
    expect(await readFile(join(runtime.calls[0]!.cwd, 'generated.txt'), 'utf8')).toBe('run-1\n');
    expect(await readFile(join(projectRoot, 'README.md'), 'utf8')).toBe('fixture\n');
    expect(result.delegation_decision?.resolved_strategy).toBe('single');
    expect(result.delegation_evidence?.observed?.subagent_calls).toBe(0);
  });

  it('resolves automatic routing from bounded roles and records observed multi-Agent evidence', async () => {
    const runtime = new WritingRuntime({
      subagentCalls: 1,
      completedCalls: 1,
      failedCalls: 0,
      toolNames: ['subagent'],
    });
    const engine = new TaskEngine({
      config: registry(),
      store: new MemoryTaskStore(),
      artifacts: new MemoryArtifacts(),
      runtime,
    });
    const input = delegateInput('multi-key');
    const receipt = await engine.delegate({
      ...input,
      delegation: {
        strategy: 'auto',
        reason: 'Implementation and independent review are separate workstreams.',
        roles: ['reviewer'],
      },
    });
    const task = await terminal(engine, receipt.task_id);
    const result = await engine.result(task.task_id);

    expect(task.status).toBe(TaskStatus.completed);
    expect(result.delegation_decision).toMatchObject({
      strategy: 'auto',
      resolved_strategy: 'multi',
      decided_by: 'bridge',
      roles: ['reviewer'],
    });
    expect(result.delegation_evidence).toMatchObject({
      children_requested: 1,
      children_completed: 1,
      children_failed: 0,
      observed: { subagent_calls: 1, tool_names: ['subagent'] },
    });
    expect(runtime.calls[0]!.prompt).toContain('Delegation policy: multi Agent.');
  });

  it('marks an explicit multi-Agent request partial when no child evidence is observed', async () => {
    const engine = new TaskEngine({
      config: registry(),
      store: new MemoryTaskStore(),
      artifacts: new MemoryArtifacts(),
      runtime: new WritingRuntime(),
    });
    const receipt = await engine.delegate({
      ...delegateInput('missing-children'),
      delegation: {
        strategy: 'multi',
        reason: 'Independent review is required.',
        roles: [],
      },
    });
    const task = await terminal(engine, receipt.task_id);
    const result = await engine.result(task.task_id);

    expect(task.status).toBe(TaskStatus.partial);
    expect(result.warnings.join(' ')).toMatch(/Multi-Agent evidence is incomplete/);
  });

  it('marks a single-Agent task partial when DSH invokes a child anyway', async () => {
    const engine = new TaskEngine({
      config: registry(),
      store: new MemoryTaskStore(),
      artifacts: new MemoryArtifacts(),
      runtime: new WritingRuntime({
        subagentCalls: 1,
        completedCalls: 1,
        failedCalls: 0,
        toolNames: ['subagent'],
      }),
    });
    const receipt = await engine.delegate(delegateInput('single-violation'));
    const task = await terminal(engine, receipt.task_id);

    expect(task.status).toBe(TaskStatus.partial);
    expect((await engine.result(task.task_id)).warnings.join(' ')).toMatch(
      /Single-Agent policy was violated/,
    );
  });

  it('rejects recursion depth and unknown roles before creating a task', async () => {
    const engine = new TaskEngine({
      config: registry(),
      store: new MemoryTaskStore(),
      artifacts: new MemoryArtifacts(),
      runtime: new WritingRuntime(),
    });

    await expect(
      engine.delegate({ ...delegateInput('too-deep'), delegation_depth: 2 }),
    ).rejects.toThrow(/exceeds Profile limit/);
    await expect(
      engine.delegate({
        ...delegateInput('unknown-role'),
        delegation: {
          strategy: 'multi',
          reason: 'Use an undeclared specialist.',
          roles: ['security'],
        },
      }),
    ).rejects.toThrow(/Unknown delegation roles/);
  });

  it('fails closed before persisting delegation evidence above the protocol limit', async () => {
    const store = new FileTaskStore(join(dataRoot, 'overflow-tasks'));
    const engine = new TaskEngine({
      config: registry(),
      store,
      artifacts: new MemoryArtifacts(),
      runtime: new WritingRuntime({
        subagentCalls: 129,
        completedCalls: 129,
        failedCalls: 0,
        toolNames: Array.from({ length: 129 }, () => 'subagent'),
      }),
    });
    const receipt = await engine.delegate(delegateInput('overflow-evidence'));
    const task = await terminal(engine, receipt.task_id);
    const result = await engine.result(task.task_id);

    expect(task.status).toBe(TaskStatus.failed);
    expect(result.error?.message).toMatch(/exceeds the protocol limit of 128/);
    expect(() => TaskResultSchema.parse(result)).not.toThrow();
    expect((await store.get(task.task_id))?.task.status).toBe(TaskStatus.failed);
  });

  it('deduplicates delegate and continues the same DSH session with a fresh run id', async () => {
    const runtime = new WritingRuntime();
    const store = new MemoryTaskStore();
    const engine = new TaskEngine({
      config: registry(),
      store,
      artifacts: new MemoryArtifacts(),
      runtime,
    });
    const first = await engine.delegate(delegateInput('same-key'));
    const duplicate = await engine.delegate(delegateInput('same-key'));
    expect(duplicate.task_id).toBe(first.task_id);
    const completed = await terminal(engine, first.task_id);
    const firstRunId = completed.run_id!;

    await expect(
      engine.continue({
        protocol_version: PROTOCOL_VERSION,
        task_id: first.task_id,
        feedback: 'Use a second value.',
        expected_run_id: 'run_stale',
      }),
    ).rejects.toBeInstanceOf(TaskConflictError);

    await engine.continue({
      protocol_version: PROTOCOL_VERSION,
      task_id: first.task_id,
      feedback: 'Use a second value.',
      expected_run_id: firstRunId,
      idempotency_key: 'continue-key',
    });
    const continued = await terminal(engine, first.task_id);
    expect(continued.run_id).not.toBe(firstRunId);
    expect(runtime.calls[1]!.sessionId).toBe('bridge-test-session');
    expect((await store.get(first.task_id))?.result_history).toHaveLength(1);
  });

  it('cancels a running runtime and persists a queryable terminal result', async () => {
    const runtime = new BlockingRuntime();
    const engine = new TaskEngine({
      config: registry(),
      store: new MemoryTaskStore(),
      artifacts: new MemoryArtifacts(),
      runtime,
    });
    const receipt = await engine.delegate(delegateInput('cancel-key'));
    await runtime.started;
    const cancellation = await engine.cancel(receipt.task_id, { reason: 'test cancellation' });
    expect(cancellation.status).toBe(TaskStatus.cancelling);
    const task = await terminal(engine, receipt.task_id);
    expect(task.status).toBe(TaskStatus.cancelled);
    expect((await engine.result(receipt.task_id)).error?.code).toBe('TASK_CANCELLED');
  });

  it('reconciles an orphaned running record as interrupted', async () => {
    const store = new MemoryTaskStore();
    const timestamp = new Date().toISOString();
    await store.save({
      project_root: projectRoot,
      base_ref: 'HEAD',
      task: {
        protocol_version: PROTOCOL_VERSION,
        task_id: 'task_orphan',
        trace_id: 'trace_orphan',
        origin: 'codex',
        delegation_depth: 0,
        project_id: 'fixture',
        workspace_id: 'workspace_orphan',
        profile_id: 'writer',
        objective: 'Interrupted work.',
        acceptance_criteria: [],
        status: TaskStatus.running,
        run_id: 'run_orphan',
        created_at: timestamp,
        updated_at: timestamp,
        started_at: timestamp,
      },
    });
    const engine = new TaskEngine({
      config: registry(),
      store,
      artifacts: new MemoryArtifacts(),
      runtime: new WritingRuntime(),
    });
    await engine.reconcile();

    expect((await engine.get('task_orphan')).status).toBe(TaskStatus.interrupted);
    expect((await engine.result('task_orphan')).error?.code).toBe('TASK_INTERRUPTED');
  });
});
