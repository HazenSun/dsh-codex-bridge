import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  publicationIssue,
  publicationPaths,
  publicationViolations,
} from './check-publication-content.mjs';

test('publication rejects local state even under a public-looking directory', () => {
  for (const path of [
    'bridge.yaml',
    'assets/runtime.json',
    '.credentials.yaml',
    'backup/credentials.yml',
    '.bridge-e2e/tasks/task.json',
    'packages/config/.dsh-test/settings.yaml',
    'GITHUB_SNAPSHOT.md',
    'GITHUB_ASSETS.json',
    'restore_github_assets.py',
    'docs/bridge.local.yml',
    'examples/bridge.production.yaml',
    '.env',
    'examples/.env.production',
    '.bridge/config.json',
    '.runtime/bridge.example.yaml',
    '.private/.env.example',
    'packages/config/.runtime/session.json',
    'docs/private-snapshot-2026.json',
    'docs/local_snapshot.json',
    'docs/snapshots/profile.json',
    'docs/private/profile.json',
    'docs/planning/alpha3.md',
    'docs/iteration-plan-alpha3.md',
    'STATUS.md',
    'receipts/release.json',
    'evidence/setup.json',
    'tests/e2e/evidence/real-dsh-rc2.json',
    'scripts/logs/install.txt',
    'docs/build.log',
    'docs/build.log.1',
    'plugins/dsh-codex-bridge/runtime/index.js',
    'workspace.dsh-bridge.lock',
    'assets/._logo.png',
    'docs/PRIVATE-SNAPSHOT.json',
    'docs/local\\snapshot.json',
    'docs/snapshot\n.json',
  ]) {
    assert.ok(publicationIssue(path), `${JSON.stringify(path)} must not be published`);
  }
});

test('release sources, examples, fixtures, and published references remain allowed', () => {
  for (const path of [
    '.env.example',
    'bridge.example.yaml',
    'examples/bridge.example.yml',
    'README.md',
    'CHANGELOG.md',
    'docs/compatibility.md',
    'docs/implementation-plan.md',
    'docs/adr/0001-runtime-boundary.md',
    '.github/workflows/ci.yml',
    '.agents/plugins/marketplace.json',
    'packages/dsh-plugin/cordis.patch.yml',
    'plugins/dsh-codex-bridge/.codex-plugin/plugin.json',
    'plugins/dsh-codex-bridge/.mcp.json',
    'packages/protocol/schemas/v1alpha1/delegation_evidence.json',
    'packages/protocol/test/__snapshots__/schema.snap',
    'tests/fixtures/profile.json',
    'tests/e2e/evidence/model-matrix.json',
    'tests/e2e/evidence/real-dsh-rc8-continue.patch',
    'tests/e2e/evidence/real-dsh-rc8.json',
    'tests/e2e/evidence/real-dsh-rc8.patch',
  ]) {
    assert.equal(publicationIssue(path), undefined, `${path} is publication content`);
  }
});

test('publication violations are unique and leave allowed paths out', () => {
  assert.deepEqual(publicationViolations(['bridge.yaml', 'README.md', 'bridge.yaml']), [
    { path: 'bridge.yaml', issue: 'machine bridge configuration' },
  ]);
});

async function withRepository(run) {
  const cwd = await mkdtemp(join(tmpdir(), 'bridge-publication-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.name', 'Publication test');
    git('config', 'user.email', 'test@example.test');
    await writeFile(join(cwd, 'README.md'), '# Public source\n');
    git('add', 'README.md');
    git('commit', '-qm', 'baseline');
    await run(cwd, git);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test('commit-range validation catches a private file added and then deleted', async () => {
  await withRepository(async (cwd, git) => {
    const base = git('rev-parse', 'HEAD');
    await writeFile(join(cwd, 'GITHUB_SNAPSHOT.md'), 'Private local restore notes\n');
    git('add', 'GITHUB_SNAPSHOT.md');
    git('commit', '-qm', 'accidental private snapshot');
    await unlink(join(cwd, 'GITHUB_SNAPSHOT.md'));
    git('add', '-u');
    git('commit', '-qm', 'remove snapshot');
    assert.equal(git('diff', '--name-only', base, 'HEAD'), '');
    assert.deepEqual(publicationViolations(publicationPaths({ base, cwd })), [
      { path: 'GITHUB_SNAPSHOT.md', issue: 'private GitHub backup manifest or restore script' },
    ]);
  });
});

test('staged validation respects exact paths and does not include untracked files', async () => {
  await withRepository(async (cwd, git) => {
    await writeFile(join(cwd, 'public guide.md'), 'Install from source\n');
    await writeFile(join(cwd, '.env'), 'LOCAL_TEST_ONLY=1\n');
    git('add', 'public guide.md');
    assert.deepEqual(publicationPaths({ staged: true, cwd }), ['public guide.md']);
    git('add', '.env');
    assert.deepEqual(publicationViolations(publicationPaths({ staged: true, cwd })), [
      { path: '.env', issue: 'machine environment configuration' },
    ]);
  });
});
