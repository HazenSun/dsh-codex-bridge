import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { WorkspaceBoundaryError, WorkspaceManager } from './index.js';

const execFileAsync = promisify(execFile);
const created: string[] = [];

async function fixture(): Promise<{ root: string; worktrees: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-workspace-'));
  created.push(root);
  await execFileAsync('git', ['init', '-q', root]);
  await execFileAsync('git', ['-C', root, 'config', 'user.email', 'bridge@example.test']);
  await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Bridge Test']);
  await writeFile(join(root, 'README.md'), 'base\n');
  await execFileAsync('git', ['-C', root, 'add', 'README.md']);
  await execFileAsync('git', ['-C', root, 'commit', '-qm', 'base']);
  const worktrees = join(root, '.test-worktrees');
  await mkdir(worktrees);
  return { root, worktrees };
}

afterEach(async () => {
  for (const root of created.splice(0)) {
    await execFileAsync('rm', ['-rf', root]);
  }
});

describe('WorkspaceManager', () => {
  it('isolates edits and collects a reproducible patch', async () => {
    const { root, worktrees } = await fixture();
    const manager = new WorkspaceManager({ allowedRoots: [root], worktreesRoot: worktrees });
    const handle = await manager.create('task-001', root);

    await writeFile(join(handle.path, 'README.md'), 'changed\n');
    await writeFile(join(handle.path, 'new-file.txt'), 'new\n');
    const artifacts = await manager.collect(handle);

    expect(artifacts.changedFiles).toEqual(['README.md', 'new-file.txt']);
    expect(artifacts.patch).toContain('+changed');
    expect(artifacts.patch).toContain('new-file.txt');
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('base\n');

    await manager.remove(handle);
  });

  it('rejects a project outside the configured boundary', async () => {
    const { root, worktrees } = await fixture();
    const other = await mkdtemp(join(tmpdir(), 'dsh-bridge-outside-'));
    created.push(other);
    const manager = new WorkspaceManager({ allowedRoots: [root], worktreesRoot: worktrees });

    await expect(manager.validateProjectRoot(other)).rejects.toBeInstanceOf(WorkspaceBoundaryError);
  });
});
