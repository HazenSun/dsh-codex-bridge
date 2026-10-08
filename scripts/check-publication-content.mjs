import { execFileSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');

// Keep previously published reference material. New execution receipts belong
// outside the source tree, even when their contents have been redacted.
const publishedReferences = new Set([
  'docs/implementation-plan.md',
  'tests/e2e/evidence/model-matrix.json',
  'tests/e2e/evidence/real-dsh-rc8-continue.patch',
  'tests/e2e/evidence/real-dsh-rc8.json',
  'tests/e2e/evidence/real-dsh-rc8.patch',
]);

const localDirectories = new Set([
  '.bridge',
  '.dsh',
  '.dsh-codex-bridge',
  '.runtime',
  '.local',
  '.private',
  '.cache',
  '.npm-cache',
  'node_modules',
  'dist',
  'coverage',
  'logs',
  'local',
  'private',
  'plans',
  'planning',
  'snapshots',
  'private-snapshots',
  'local-snapshots',
  'execution-evidence',
  'local-evidence',
  'run-evidence',
  'receipts',
]);

export function publicationIssue(path) {
  if (/\p{Cc}/u.test(path) || path.includes('\\')) return 'unsupported publication path';
  const normalized = path.toLowerCase();
  const name = basename(normalized);
  if (['github_snapshot.md', 'github_assets.json', 'restore_github_assets.py'].includes(name)) {
    return 'private GitHub backup manifest or restore script';
  }
  if (publishedReferences.has(normalized)) return undefined;
  const directories = normalized.split('/').slice(0, -1);
  if (
    directories.some(
      (directory) =>
        localDirectories.has(directory) || /^\.(?:bridge|dsh)(?:[-.]|$)/.test(directory),
    )
  ) {
    return 'local runtime, planning, or execution output';
  }
  if (/^(?:output|outputs|evidence|reports|local|private|profiles)\//.test(normalized)) {
    return 'local execution output';
  }
  if (normalized.startsWith('plugins/dsh-codex-bridge/runtime/')) {
    return 'installed plugin runtime';
  }
  if (normalized.startsWith('tests/e2e/evidence/')) return 'new execution evidence';
  if (name === '.env.example' || /^bridge\.example\.ya?ml$/.test(name)) return undefined;
  if (/^\.?credentials\.ya?ml$/.test(name) || name === 'runtime.json')
    return 'machine credentials or launcher configuration';
  if (/^\.env(?:\.|$)/.test(name)) return 'machine environment configuration';
  if (/^bridge(?:[-.][^/]*)?\.ya?ml$/.test(name)) return 'machine bridge configuration';
  if (/\.dsh-bridge\.lock$/.test(name)) return 'local bridge lock';
  if (name === '.ds_store' || name.startsWith('._')) return 'local filesystem metadata';
  if (/\.(?:log|log\.[^/]+)$/.test(name)) return 'execution log';
  if (/(?:^|[-_.])(?:private|local|runtime)[-_](?:snapshot|evidence)(?:[-_.]|$)/.test(name)) {
    return 'private runtime snapshot or evidence';
  }
  if (
    /^(?:(?:iteration|execution|release|implementation)[-_]plan|work[-_]log|handoff|iteration[-_]status)(?:[-_.].*)?\.(?:md|txt|json)$/.test(
      name,
    ) ||
    /^(?:plan|status|tasks)\.(?:md|txt|json)$/.test(normalized)
  ) {
    return 'local planning or handoff notes';
  }
  return undefined;
}

export function publicationViolations(paths) {
  return [...new Set(paths)].sort().flatMap((path) => {
    const issue = publicationIssue(path);
    return issue ? [{ path, issue }] : [];
  });
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function nulPaths(output) {
  return output.split('\0').filter(Boolean);
}

function commit(ref, cwd) {
  if (!ref) throw new Error('A nonempty commit reference is required.');
  return git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], cwd).trim();
}

export function publicationPaths({ base, head = 'HEAD', staged = false, cwd = root } = {}) {
  if (staged && base !== undefined) throw new Error('Choose staged files or a commit range.');
  if (staged) {
    return nulPaths(
      git(['diff', '--cached', '--no-renames', '--name-only', '--diff-filter=ACMRT', '-z'], cwd),
    );
  }
  if (base === undefined) return nulPaths(git(['ls-files', '--cached', '-z'], cwd));
  const headCommit = commit(head, cwd);
  if (/^0{40,64}$/.test(base)) {
    return nulPaths(git(['ls-tree', '-r', '--name-only', '-z', headCommit], cwd));
  }
  const baseCommit = commit(base, cwd);
  const commits = git(['rev-list', `${baseCommit}..${headCommit}`], cwd)
    .trim()
    .split('\n');
  // Inspect each new commit so an add-then-delete sequence cannot hide a local
  // snapshot in published Git history. Deletions themselves are always allowed.
  return [
    ...new Set(
      commits
        .filter(Boolean)
        .flatMap((revision) =>
          nulPaths(
            git(
              [
                'diff-tree',
                '--root',
                '-m',
                '--no-commit-id',
                '--no-renames',
                '--name-only',
                '--diff-filter=ACMRT',
                '-r',
                '-z',
                revision,
              ],
              cwd,
            ),
          ),
        ),
    ),
  ];
}

function main(args) {
  let options;
  if (args.length === 0) options = {};
  else if (args.length === 1 && args[0] === '--staged') options = { staged: true };
  else if (
    args[0] === '--base' &&
    (args.length === 2 || (args.length === 4 && args[2] === '--head'))
  ) {
    options = { base: args[1], head: args[3] ?? 'HEAD' };
  } else {
    throw new Error('Usage: check-publication-content.mjs [--staged | --base REF [--head REF]]');
  }
  const paths = publicationPaths(options);
  const violations = publicationViolations(paths);
  if (violations.length > 0) {
    throw new Error(
      `Publication content rejected:\n${violations.map(({ path, issue }) => `- ${JSON.stringify(path)}: ${issue}`).join('\n')}\nKeep these files outside the publication tree.`,
    );
  }
  process.stdout.write(`Publication content: ${paths.length} paths checked.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
