import { execFile } from 'node:child_process';
import { readFile, readdir, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execFileAsync = promisify(execFile);
const fixture = await mkdtemp(join(tmpdir(), 'dsh-bridge-setup-e2e-'));
const configPath = join(fixture, 'bridge.yaml');
const stderrLines = [];

function environment(overrides) {
  return Object.fromEntries([
    ...Object.entries(process.env).filter((entry) => typeof entry[1] === 'string'),
    ...Object.entries(overrides),
  ]);
}

function structured(result) {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error('MCP result contained no structured content');
  return JSON.parse(text);
}

async function git(args) {
  return execFileAsync('git', ['-C', fixture, ...args], { encoding: 'utf8' });
}

async function sourceStatus() {
  return (await git(['status', '--porcelain=v1', '--untracked-files=all'])).stdout
    .split('\n')
    .filter(
      (line) =>
        line.length > 0 &&
        !line.includes('.bridge-setup-e2e') &&
        !line.includes('.dsh-codex-bridge'),
    )
    .sort()
    .join('\n');
}

async function setupFixture() {
  await execFileAsync('git', ['init', '-q', fixture]);
  await git(['config', 'user.name', 'DSH Setup Lifecycle Test']);
  await git(['config', 'user.email', 'setup-e2e@example.test']);
  await writeFile(join(fixture, 'README.md'), '# DSH setup lifecycle fixture\n');
  await writeFile(
    configPath,
    `protocol_version: bridge.dsh.dev/v1alpha1
data_root: .bridge-setup-e2e
log_level: info
projects:
  - project_id: setup-e2e
    root: .
    default_profile: deepseek-baseline
profiles:
  - protocol_version: bridge.dsh.dev/v1alpha1
    profile_id: deepseek-baseline
    description: Baseline route retained across setup rollback.
    dsh:
      provider: deepseek-official
      model: deepseek-v4-flash
      reasoning_effort: high
      agent_preset: standard
      max_tokens: 8000
    delegation:
      max_depth: 0
      max_children: 0
      roles: {}
    workspace:
      mode: isolated_worktree
      allowed_roots: [.]
    policy:
      network: restricted
      allowed_domains: []
      denied_paths: [.env, .git]
      timeout_seconds: 300
      max_artifact_bytes: 1048576
      max_output_bytes: 262144
      max_files: 20
      disk_quota_bytes: 104857600
`,
  );
  await git(['add', 'README.md', 'bridge.yaml']);
  await git(['commit', '-qm', 'setup lifecycle baseline']);
}

async function connectBridge() {
  const transport = new StdioClientTransport({
    command: 'dsh',
    args: ['--profile', 'codex-bridge'],
    cwd: fixture,
    env: environment({
      DSH_BRIDGE_CONFIG: configPath,
      DSH_TELEMETRY_DISABLED: '1',
    }),
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => {
    stderrLines.push(...String(chunk).split('\n').filter(Boolean));
  });
  const client = new Client({ name: 'dsh-setup-lifecycle', version: '0.1.0-alpha.2' });
  await client.connect(transport, { timeout: 15_000 });
  return client;
}

function kimiProfile() {
  return {
    protocol_version: 'bridge.dsh.dev/v1alpha1',
    profile_id: 'kimi-lifecycle',
    description: 'Kimi route created through the guarded setup control plane.',
    dsh: {
      provider: 'moonshotai-cn',
      model: 'kimi-k2.7-code',
      reasoning_effort: 'high',
      agent_preset: 'standard',
      max_tokens: 8000,
    },
    delegation: { max_depth: 0, max_children: 0, roles: {} },
    workspace: { mode: 'isolated_worktree', allowed_roots: ['.'] },
    policy: {
      network: 'restricted',
      allowed_domains: [],
      denied_paths: ['.env', '.git'],
      timeout_seconds: 300,
      max_artifact_bytes: 1048576,
      max_output_bytes: 262144,
      max_files: 20,
      disk_quota_bytes: 104857600,
    },
  };
}

async function waitTerminal(client, taskId) {
  for (let attempt = 0; attempt < 36; attempt += 1) {
    const output = structured(
      await client.callTool(
        {
          name: 'wait_task',
          arguments: {
            protocol_version: 'bridge.dsh.dev/v1alpha1',
            task_id: taskId,
            timeout_seconds: 10,
          },
        },
        undefined,
        { timeout: 20_000 },
      ),
    );
    if (['completed', 'partial', 'failed', 'cancelled', 'timed_out'].includes(output.task.status)) {
      return output.task;
    }
  }
  throw new Error(`Task ${taskId} did not become terminal`);
}

async function sessionRoute(taskId) {
  const task = JSON.parse(
    await readFile(join(fixture, '.bridge-setup-e2e', 'tasks', taskId, 'task.json'), 'utf8'),
  );
  const sessionsRoot = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions');
  const paths = await readdir(sessionsRoot, { recursive: true });
  const relative = paths.find(
    (path) => typeof path === 'string' && path.endsWith(`${task.session_id}/session.jsonl.zstd`),
  );
  if (relative === undefined) return undefined;
  const { stdout } = await execFileAsync('zstd', ['-dc', resolve(sessionsRoot, relative)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const header = stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((event) => event.type === 'request/header');
  return header?.data?.header?.config;
}

async function main() {
  await setupFixture();
  const startedAt = new Date().toISOString();
  let client = await connectBridge();
  let succeeded = false;
  try {
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    for (const tool of [
      'get_setup_status',
      'discover_dsh_models',
      'preview_profile_change',
      'apply_profile_change',
      'rollback_profile_change',
    ]) {
      if (!tools.includes(tool)) throw new Error(`Missing setup tool: ${tool}`);
    }

    const catalog = structured(
      await client.callTool({
        name: 'discover_dsh_models',
        arguments: { protocol_version: 'bridge.dsh.dev/v1alpha1', include_details: true },
      }),
    );
    const deepseek = catalog.providers
      .find((provider) => provider.provider === 'deepseek-official')
      ?.models.find((model) => model.model === 'deepseek-v4-flash');
    const kimi = catalog.providers
      .find((provider) => provider.provider === 'moonshotai-cn')
      ?.models.find((model) => model.model === 'kimi-k2.7-code');
    if (deepseek === undefined || kimi === undefined) {
      throw new Error('Required DeepSeek/Kimi routes were not discovered from live DSH');
    }

    const change = {
      operation: 'add',
      profile: kimiProfile(),
      set_default_for: ['setup-e2e'],
    };
    const preview = structured(
      await client.callTool({
        name: 'preview_profile_change',
        arguments: { protocol_version: 'bridge.dsh.dev/v1alpha1', change },
      }),
    );
    if (!preview.diff.includes('kimi-lifecycle') || preview.before_revision === undefined) {
      throw new Error('Profile preview did not return the expected semantic diff/revision');
    }
    const applied = structured(
      await client.callTool({
        name: 'apply_profile_change',
        arguments: {
          protocol_version: 'bridge.dsh.dev/v1alpha1',
          change,
          expected_revision: preview.before_revision,
        },
      }),
    );
    const stale = await client.callTool({
      name: 'apply_profile_change',
      arguments: {
        protocol_version: 'bridge.dsh.dev/v1alpha1',
        change: {
          operation: 'set_default',
          project_id: 'setup-e2e',
          profile_id: 'deepseek-baseline',
        },
        expected_revision: preview.before_revision,
      },
    });
    if (stale.isError !== true) throw new Error('Stale configuration revision was not rejected');

    await client.close();
    client = await connectBridge();
    const profiles = structured(
      await client.callTool({
        name: 'list_profiles',
        arguments: { protocol_version: 'bridge.dsh.dev/v1alpha1' },
      }),
    );
    if (!profiles.profiles.some((profile) => profile.profile_id === 'kimi-lifecycle')) {
      throw new Error('Applied Profile was not visible after MCP restart');
    }

    const beforeTaskStatus = await sourceStatus();
    const receipt = structured(
      await client.callTool({
        name: 'delegate_task',
        arguments: {
          protocol_version: 'bridge.dsh.dev/v1alpha1',
          project_id: 'setup-e2e',
          profile_id: 'kimi-lifecycle',
          objective:
            'Create lifecycle.txt containing exactly SETUP_PROFILE_REAL_CALL_OK followed by one newline.',
          acceptance_criteria: ['lifecycle.txt contains the exact requested line'],
          delegation: {
            strategy: 'single',
            reason: 'One bounded smoke-test file has no independent workstreams.',
            roles: [],
          },
          idempotency_key: `setup-lifecycle-${Date.now()}`,
        },
      }),
    );
    const task = await waitTerminal(client, receipt.task_id);
    const result = structured(
      await client.callTool({
        name: 'get_task_result',
        arguments: {
          protocol_version: 'bridge.dsh.dev/v1alpha1',
          task_id: receipt.task_id,
        },
      }),
    ).result;
    const patchArtifact = result.artifacts.artifacts.find((artifact) => artifact.kind === 'patch');
    const patch =
      patchArtifact === undefined
        ? ''
        : structured(
            await client.callTool({
              name: 'read_task_artifact',
              arguments: {
                protocol_version: 'bridge.dsh.dev/v1alpha1',
                task_id: receipt.task_id,
                artifact_id: patchArtifact.artifact_id,
                offset: 0,
                limit: Math.max(1, patchArtifact.bytes),
                expected_sha256: patchArtifact.sha256,
              },
            }),
          ).data;
    const route = await sessionRoute(receipt.task_id);
    const afterTaskStatus = await sourceStatus();

    const status = structured(
      await client.callTool({
        name: 'get_setup_status',
        arguments: { protocol_version: 'bridge.dsh.dev/v1alpha1' },
      }),
    );
    const rolledBack = structured(
      await client.callTool({
        name: 'rollback_profile_change',
        arguments: {
          protocol_version: 'bridge.dsh.dev/v1alpha1',
          expected_revision: status.config_revision,
        },
      }),
    );
    await client.close();
    client = await connectBridge();
    const profilesAfterRollback = structured(
      await client.callTool({
        name: 'list_profiles',
        arguments: { protocol_version: 'bridge.dsh.dev/v1alpha1' },
      }),
    );
    const checks = {
      live_models_discovered: deepseek !== undefined && kimi !== undefined,
      preview_and_revision_returned:
        typeof preview.before_revision === 'string' && preview.diff.includes('kimi-lifecycle'),
      atomic_apply_requires_restart: applied.changed === true && applied.restart_required === true,
      stale_revision_rejected: stale.isError === true,
      profile_visible_after_restart: profiles.profiles.some(
        (profile) => profile.profile_id === 'kimi-lifecycle',
      ),
      real_call_completed:
        task.status === 'completed' && patch.includes('SETUP_PROFILE_REAL_CALL_OK'),
      real_kimi_route_observed:
        route?.provider === 'moonshotai-cn' &&
        route?.model === 'kimi-k2.7-code' &&
        route?.reasoningEffort === 'high',
      task_preserved_main_worktree: beforeTaskStatus === afterTaskStatus,
      rollback_completed: rolledBack.changed === true,
      rollback_removed_profile: !profilesAfterRollback.profiles.some(
        (profile) => profile.profile_id === 'kimi-lifecycle',
      ),
    };
    const evidence = {
      schema: 'dsh-codex-bridge/setup-lifecycle-evidence/v1',
      bridge_version: '0.1.0-alpha.2',
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      fixture,
      task_id: receipt.task_id,
      config_revisions: {
        before: preview.before_revision,
        applied: applied.config_revision,
        rolled_back: rolledBack.config_revision,
      },
      observed_route: route,
      checks,
    };
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    succeeded = Object.values(checks).every(Boolean);
    if (!succeeded) throw new Error(`Setup lifecycle checks failed: ${JSON.stringify(checks)}`);
  } finally {
    await client.close().catch(() => undefined);
    if (succeeded) await rm(fixture, { recursive: true, force: true });
  }
}

await main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify(
      {
        fixture,
        error: error instanceof Error ? error.message : String(error),
        stderr_tail: stderrLines.slice(-50),
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
});
