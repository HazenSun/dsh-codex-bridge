import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileTaskStore, TaskLeaseConflictError } from './store.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-task-leases-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill(signal);
  const fallback = setTimeout(() => child.kill('SIGKILL'), 1_000);
  try {
    await exited;
  } finally {
    clearTimeout(fallback);
  }
}

async function holder(taskId: string): Promise<{ child: ChildProcess; owner: string }> {
  const path = join(root, taskId, 'task.lease.json');
  await mkdir(join(root, taskId));
  const url = new URL('./lease.ts', import.meta.url).href;
  const code = `import {acquireFileTaskLease} from ${JSON.stringify(url)}; const lease=await acquireFileTaskLease(${JSON.stringify(path)},${JSON.stringify(taskId)}); process.stdout.write(JSON.stringify({owner:lease.ownerToken})+'\\n'); setInterval(()=>{},1000);`;
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', code],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const lines = createInterface({ input: child.stdout });
  try {
    const owner = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Lease holder did not become ready')),
        3_000,
      );
      lines.once('line', (line) => {
        clearTimeout(timeout);
        const parsed: unknown = JSON.parse(line);
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          !('owner' in parsed) ||
          typeof parsed.owner !== 'string'
        )
          reject(new Error('Invalid holder response'));
        else resolve(parsed.owner);
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', () => {
        clearTimeout(timeout);
        reject(new Error(`Lease holder exited: ${stderr}`));
      });
    });
    return { child, owner };
  } catch (error) {
    await stop(child);
    throw error;
  } finally {
    lines.close();
  }
}

describe('FileTaskStore leases', () => {
  it('excludes a second Store even in the same PID and releases ownership for the next caller', async () => {
    const first = new FileTaskStore(root);
    const second = new FileTaskStore(root);
    const lease = await first.acquireLease('task_shared');
    try {
      await expect(second.acquireLease('task_shared')).rejects.toBeInstanceOf(
        TaskLeaseConflictError,
      );
      expect(await second.get('task_shared')).toBeUndefined();
      await lease.assertOwned();
    } finally {
      await lease.release();
    }
    const next = await second.acquireLease('task_shared');
    expect(next.ownerToken).not.toBe(lease.ownerToken);
    await next.release();
    expect(await readdir(join(root, 'task_shared'))).toEqual([]);
  });

  it('keeps a live child owner and reclaims its lease after that exact process dies', async () => {
    const active = await holder('task_child');
    const first = new FileTaskStore(root);
    const second = new FileTaskStore(root);
    try {
      await expect(first.acquireLease('task_child')).rejects.toBeInstanceOf(TaskLeaseConflictError);
      await stop(active.child, 'SIGKILL');
      const contenders = await Promise.allSettled([
        first.acquireLease('task_child'),
        second.acquireLease('task_child'),
      ]);
      const winners = contenders.filter((result) => result.status === 'fulfilled');
      expect(winners).toHaveLength(1);
      expect(contenders.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const winner = winners[0]!.value;
      expect(winner.ownerToken).not.toBe(active.owner);
      await winner.assertOwned();
      await winner.release();
      expect(await readdir(join(root, 'task_child'))).toEqual([]);
    } finally {
      await stop(active.child);
    }
  });

  it('also recovers a dead reclaimer guard without deleting the new live owner', async () => {
    const active = await holder('task_guard');
    try {
      const guard = join(root, 'task_guard', `task.lease.json.reap-${active.owner}`);
      await writeFile(
        guard,
        JSON.stringify({ schema: 'dsh-task-lease/v1', owner: randomUUID(), pid: active.child.pid }),
      );
      await stop(active.child, 'SIGKILL');
      const lease = await new FileTaskStore(root).acquireLease('task_guard');
      await lease.assertOwned();
      expect(await readdir(join(root, 'task_guard'))).toEqual(['task.lease.json']);
      await lease.release();
    } finally {
      await stop(active.child);
    }
  });

  it.each(['{', '{}', '{"schema":"dsh-task-lease/v1","owner":"unknown","pid":0}'])(
    'refuses an unverifiable lock and leaves its bytes untouched (%s)',
    async (content) => {
      const path = join(root, 'task_corrupt', 'task.lease.json');
      await mkdir(join(root, 'task_corrupt'));
      await writeFile(path, content);
      await expect(new FileTaskStore(root).acquireLease('task_corrupt')).rejects.toBeInstanceOf(
        TaskLeaseConflictError,
      );
      expect(await readFile(path, 'utf8')).toBe(content);
    },
  );

  it('never releases a different owner token even when that owner has the same PID', async () => {
    const lease = await new FileTaskStore(root).acquireLease('task_replaced');
    const replacement = { schema: 'dsh-task-lease/v1', owner: randomUUID(), pid: process.pid };
    const path = join(root, 'task_replaced', 'task.lease.json');
    await writeFile(path, JSON.stringify(replacement));
    await expect(lease.assertOwned()).rejects.toBeInstanceOf(TaskLeaseConflictError);
    await lease.release();
    expect(JSON.parse(await readFile(path, 'utf8')) as unknown).toEqual(replacement);
  });
});
