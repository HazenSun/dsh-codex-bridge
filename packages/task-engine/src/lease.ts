import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, unlink } from 'node:fs/promises';

/** One task's exclusive mutator capability; reads do not require it. */
export interface TaskLease {
  readonly ownerToken: string;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

export class TaskLeaseConflictError extends Error {
  readonly code = 'TASK_CONFLICT';

  constructor(taskId: string, detail = 'another live process owns this task') {
    super(`Task ${taskId} is leased: ${detail}`);
    this.name = 'TaskLeaseConflictError';
  }
}

interface LeaseRecord {
  readonly schema: 'dsh-task-lease/v1';
  readonly owner: string;
  readonly pid: number;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission refusals and uncertain failures must never authorize reclaiming a live owner.
    return errorCode(error) !== 'ESRCH';
  }
}

async function readLease(path: string, taskId: string): Promise<LeaseRecord | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 4_096) {
      throw new TaskLeaseConflictError(taskId, 'lock requires inspection');
    }
    const content = await readFile(path, 'utf8');
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new TaskLeaseConflictError(taskId, 'lock is incomplete or corrupt');
    }
    if (
      typeof value !== 'object' ||
      value === null ||
      !('schema' in value) ||
      value.schema !== 'dsh-task-lease/v1' ||
      !('owner' in value) ||
      typeof value.owner !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(value.owner) ||
      !('pid' in value) ||
      typeof value.pid !== 'number' ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0
    ) {
      throw new TaskLeaseConflictError(taskId, 'lock owner cannot be verified');
    }
    return { schema: 'dsh-task-lease/v1', owner: value.owner, pid: value.pid };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

async function createLease(path: string, taskId: string): Promise<TaskLease> {
  const record: LeaseRecord = {
    schema: 'dsh-task-lease/v1',
    owner: randomUUID(),
    pid: process.pid,
  };
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  let released: Promise<void> | undefined;
  return {
    ownerToken: record.owner,
    async assertOwned() {
      const current = await readLease(path, taskId);
      if (current?.owner !== record.owner || current.pid !== record.pid) {
        throw new TaskLeaseConflictError(taskId, 'lease ownership was lost');
      }
    },
    release() {
      return (released ??= (async () => {
        let current: LeaseRecord | undefined;
        try {
          current = await readLease(path, taskId);
        } catch (error) {
          if (error instanceof TaskLeaseConflictError) return;
          throw error;
        }
        if (current?.owner !== record.owner || current.pid !== record.pid) return;
        try {
          await unlink(path);
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error;
        }
      })());
    },
  };
}

/**
 * Claim an exact task lock. Dead owners are reclaimed under a generation-specific
 * guard, so competing reclaimers cannot unlink the newly claimed live lease.
 * A crashed reclaimer's guard uses the same protocol, with a bounded recovery chain.
 */
export async function acquireFileTaskLease(
  path: string,
  taskId: string,
  depth = 0,
): Promise<TaskLease> {
  if (depth >= 8)
    throw new TaskLeaseConflictError(taskId, 'recovery guard chain requires inspection');
  try {
    return await createLease(path, taskId);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  const stale = await readLease(path, taskId);
  if (stale === undefined) return acquireFileTaskLease(path, taskId, depth + 1);
  if (pidIsAlive(stale.pid)) throw new TaskLeaseConflictError(taskId);
  const guard = await acquireFileTaskLease(`${path}.reap-${stale.owner}`, taskId, depth + 1);
  try {
    const current = await readLease(path, taskId);
    if (current !== undefined) {
      if (current.owner !== stale.owner || current.pid !== stale.pid || pidIsAlive(current.pid)) {
        throw new TaskLeaseConflictError(taskId, 'ownership changed during recovery');
      }
      await unlink(path);
    }
    // A new claimant can legitimately win the wx race after removal; never replace it.
    try {
      return await createLease(path, taskId);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') throw new TaskLeaseConflictError(taskId);
      throw error;
    }
  } finally {
    await guard.release();
  }
}
