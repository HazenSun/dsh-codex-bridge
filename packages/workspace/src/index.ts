import { execFile } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export class WorkspaceBoundaryError extends Error {
  readonly code = 'WORKSPACE_OUTSIDE_ALLOWED_ROOT';

  constructor(path: string) {
    super(`Project path is outside every allowed root: ${path}`);
    this.name = 'WorkspaceBoundaryError';
  }
}

export class GitWorkspaceError extends Error {
  readonly code = 'GIT_WORKSPACE_ERROR';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GitWorkspaceError';
  }
}

export interface WorkspaceHandle {
  readonly id: string;
  readonly projectRoot: string;
  readonly path: string;
  readonly baseSha: string;
}

export interface WorkspaceArtifacts {
  readonly patch: string;
  readonly status: string;
  readonly changedFiles: readonly string[];
  readonly baseSha: string;
  readonly headSha: string;
}

export interface WorkspaceManagerOptions {
  readonly allowedRoots: readonly string[];
  readonly worktreesRoot: string;
  readonly gitBinary?: string;
}

function isWithin(candidate: string, root: string): boolean {
  const segment = relative(root, candidate);
  return (
    segment === '' || (!segment.startsWith(`..${sep}`) && segment !== '..' && !isAbsolute(segment))
  );
}

async function git(
  binary: string,
  cwd: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(binary, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GitWorkspaceError(`git ${args.join(' ')} failed in ${cwd}: ${detail}`, {
      cause: error,
    });
  }
}

export class WorkspaceManager {
  readonly #allowedRoots: Promise<readonly string[]>;
  readonly #worktreesRoot: string;
  readonly #gitBinary: string;

  constructor(options: WorkspaceManagerOptions) {
    if (options.allowedRoots.length === 0) {
      throw new WorkspaceBoundaryError('No allowed roots configured');
    }
    this.#allowedRoots = Promise.all(options.allowedRoots.map((root) => realpath(resolve(root))));
    this.#worktreesRoot = resolve(options.worktreesRoot);
    this.#gitBinary = options.gitBinary ?? 'git';
  }

  async validateProjectRoot(input: string): Promise<string> {
    const projectRoot = await realpath(resolve(input));
    const allowedRoots = await this.#allowedRoots;
    if (!allowedRoots.some((root) => isWithin(projectRoot, root))) {
      throw new WorkspaceBoundaryError(projectRoot);
    }

    const { stdout } = await git(this.#gitBinary, projectRoot, ['rev-parse', '--show-toplevel']);
    const gitRoot = await realpath(stdout.trim());
    if (gitRoot !== projectRoot) {
      throw new GitWorkspaceError(
        `Project root must be the Git top-level directory: expected ${gitRoot}, received ${projectRoot}`,
      );
    }
    return projectRoot;
  }

  async create(taskId: string, projectPath: string, baseRef = 'HEAD'): Promise<WorkspaceHandle> {
    if (!TASK_ID_PATTERN.test(taskId)) {
      throw new GitWorkspaceError(`Unsafe task id: ${taskId}`);
    }
    const projectRoot = await this.validateProjectRoot(projectPath);
    const { stdout: baseOutput } = await git(this.#gitBinary, projectRoot, [
      'rev-parse',
      '--verify',
      `${baseRef}^{commit}`,
    ]);
    const baseSha = baseOutput.trim();
    const worktreePath = resolve(this.#worktreesRoot, taskId);
    if (!isWithin(worktreePath, this.#worktreesRoot)) {
      throw new WorkspaceBoundaryError(worktreePath);
    }

    await mkdir(dirname(worktreePath), { recursive: true });
    await git(this.#gitBinary, projectRoot, ['worktree', 'add', '--detach', worktreePath, baseSha]);

    return { id: taskId, projectRoot, path: worktreePath, baseSha };
  }

  async collect(handle: WorkspaceHandle): Promise<WorkspaceArtifacts> {
    await git(this.#gitBinary, handle.path, ['add', '--intent-to-add', '--all', '--']);
    const [{ stdout: patch }, { stdout: status }, { stdout: headOutput }] = await Promise.all([
      git(this.#gitBinary, handle.path, [
        'diff',
        '--binary',
        '--no-ext-diff',
        handle.baseSha,
        '--',
      ]),
      git(this.#gitBinary, handle.path, ['status', '--porcelain=v1', '--untracked-files=all']),
      git(this.#gitBinary, handle.path, ['rev-parse', 'HEAD']),
    ]);
    const changedFiles = status
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const value = line.slice(3);
        const renameTarget = value.includes(' -> ') ? value.split(' -> ').at(-1) : value;
        return renameTarget ?? value;
      });

    return {
      patch,
      status,
      changedFiles,
      baseSha: handle.baseSha,
      headSha: headOutput.trim(),
    };
  }

  async remove(handle: WorkspaceHandle): Promise<void> {
    await git(this.#gitBinary, handle.projectRoot, ['worktree', 'remove', '--force', handle.path]);
    await git(this.#gitBinary, handle.projectRoot, ['worktree', 'prune']);
  }
}
