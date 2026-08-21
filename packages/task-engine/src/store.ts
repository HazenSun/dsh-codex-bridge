import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  IdentifierSchema,
  TaskDispatchReceiptSchema,
  TaskIdSchema,
  TaskOperationReceiptSchema,
  TaskResultSchema,
  TaskSchema,
  type Task,
  type TaskDispatchReceipt,
  type TaskOperationReceipt,
  type TaskResult,
} from '@dsh-codex-bridge/protocol';
import type { WorkspaceHandle } from '@dsh-codex-bridge/workspace';

export type StoredOperationKind = 'continue' | 'cancel';

export interface StoredOperationReceipt {
  readonly kind: StoredOperationKind;
  readonly receipt: TaskDispatchReceipt | TaskOperationReceipt;
}

export interface StoredTask {
  readonly task: Task;
  readonly project_root: string;
  readonly base_ref: string;
  readonly idempotency_key?: string;
  readonly session_id?: string;
  readonly workspace?: WorkspaceHandle;
  readonly result?: TaskResult;
  /** Previous run results are immutable evidence retained across continue_task. */
  readonly result_history?: readonly TaskResult[];
  /** Operation idempotency records survive a process restart. */
  readonly operation_receipts?: Readonly<Record<string, StoredOperationReceipt>>;
}

export interface TaskStore {
  get(taskId: string): Promise<StoredTask | undefined>;
  list(): Promise<readonly StoredTask[]>;
  save(record: StoredTask): Promise<void>;
}

function parseStoredTask(value: unknown): StoredTask {
  if (typeof value !== 'object' || value === null) throw new Error('Task record must be an object');
  const source = value as Record<string, unknown>;
  const task = TaskSchema.parse(source['task']);
  const projectRoot = source['project_root'];
  const baseRef = source['base_ref'];
  if (typeof projectRoot !== 'string' || typeof baseRef !== 'string') {
    throw new Error(`Task ${task.task_id} has invalid workspace metadata`);
  }
  const result =
    source['result'] === undefined ? undefined : TaskResultSchema.parse(source['result']);
  const resultHistory =
    source['result_history'] === undefined
      ? undefined
      : TaskResultSchema.array().max(256).parse(source['result_history']);
  const operationReceipts = parseOperationReceipts(source['operation_receipts']);
  return {
    task,
    project_root: projectRoot,
    base_ref: baseRef,
    ...(typeof source['idempotency_key'] === 'string'
      ? { idempotency_key: source['idempotency_key'] }
      : {}),
    ...(typeof source['session_id'] === 'string' ? { session_id: source['session_id'] } : {}),
    ...(source['workspace'] === undefined
      ? {}
      : { workspace: source['workspace'] as WorkspaceHandle }),
    ...(result === undefined ? {} : { result }),
    ...(resultHistory === undefined ? {} : { result_history: resultHistory }),
    ...(operationReceipts === undefined ? {} : { operation_receipts: operationReceipts }),
  };
}

function parseOperationReceipts(
  value: unknown,
): Readonly<Record<string, StoredOperationReceipt>> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Task operation receipts must be an object');
  }

  const records: Record<string, StoredOperationReceipt> = {};
  for (const [key, raw] of Object.entries(value)) {
    IdentifierSchema.parse(key);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`Task operation receipt ${key} must be an object`);
    }
    const source = raw as Record<string, unknown>;
    const kind = source['kind'];
    if (kind !== 'continue' && kind !== 'cancel') {
      throw new Error(`Task operation receipt ${key} has an invalid kind`);
    }
    const receipt =
      kind === 'continue'
        ? TaskDispatchReceiptSchema.parse(source['receipt'])
        : TaskOperationReceiptSchema.parse(source['receipt']);
    records[key] = { kind, receipt };
  }
  return records;
}

export class FileTaskStore implements TaskStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async get(taskId: string): Promise<StoredTask | undefined> {
    TaskIdSchema.parse(taskId);
    try {
      const content = await readFile(join(this.#root, taskId, 'task.json'), 'utf8');
      return parseStoredTask(JSON.parse(content) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async list(): Promise<readonly StoredTask[]> {
    try {
      const entries = await readdir(this.#root, { withFileTypes: true });
      const records = await Promise.all(
        entries.filter((entry) => entry.isDirectory()).map((entry) => this.get(entry.name)),
      );
      return records.filter((record): record is StoredTask => record !== undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async save(record: StoredTask): Promise<void> {
    const validated = parseStoredTask(record);
    const path = join(this.#root, validated.task.task_id, 'task.json');
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, path);
  }
}

export class MemoryTaskStore implements TaskStore {
  readonly #records = new Map<string, StoredTask>();

  async get(taskId: string): Promise<StoredTask | undefined> {
    TaskIdSchema.parse(taskId);
    return this.#records.get(taskId);
  }

  async list(): Promise<readonly StoredTask[]> {
    return [...this.#records.values()];
  }

  async save(record: StoredTask): Promise<void> {
    this.#records.set(record.task.task_id, structuredClone(record));
  }
}
