import { readFile, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  BRIDGE_VERSION,
  DSH_VERSION,
  discoverRoutes,
  environment,
  evidenceDirectory,
  execFileAsync,
  readPatch,
  readRuntime,
  requestedRoutes,
  routeMatches,
  savedSession,
  sha256,
  structured,
  verifyConnection,
  waitTerminal,
  worktreeProof,
  writeEvidence,
} from './e2e-support.mjs';

const fixture = await mkdtemp(join(tmpdir(), 'dsh-bridge-setup-e2e-'));
const evidenceDir = await evidenceDirectory('dsh-bridge-setup-e2e');
const configPath = join(fixture, 'bridge.yaml');
const stderrLines = [];
const routes = requestedRoutes();
let runtime;

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
    default_profile: baseline-route
profiles:
  - protocol_version: bridge.dsh.dev/v1alpha1
    profile_id: baseline-route
    description: Baseline route retained across setup rollback.
    dsh:
      provider: ${routes.primary.provider}
      model: ${routes.primary.model}
      reasoning_effort: ${routes.primary.reasoning_effort}
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
    command: runtime.command,
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
  const client = new Client({ name: 'dsh-setup-lifecycle', version: BRIDGE_VERSION });
  try {
    await client.connect(transport, { timeout: 15_000 });
    await verifyConnection(client, runtime);
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

function secondProfile() {
  return {
    protocol_version: 'bridge.dsh.dev/v1alpha1',
    profile_id: 'second-lifecycle',
    description: `Route ${routes.second.provider}/${routes.second.model} created through the guarded setup control plane.`,
    dsh: {
      provider: routes.second.provider,
      model: routes.second.model,
      reasoning_effort: routes.second.reasoning_effort,
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

async function sessionRoute(taskId) {
  const task = JSON.parse(
    await readFile(join(fixture, '.bridge-setup-e2e', 'tasks', taskId, 'task.json'), 'utf8'),
  );
  return { ...(await savedSession(runtime, task.session_id)), record: task };
}

async function main() {
  runtime = await readRuntime();
  await setupFixture();
  const baselineConfigSha = sha256(await readFile(configPath));
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

    const discoveredRoutes = await discoverRoutes(client, routes);

    const change = {
      operation: 'add',
      profile: secondProfile(),
      set_default_for: ['setup-e2e'],
    };
    const preview = structured(
      await client.callTool({
        name: 'preview_profile_change',
        arguments: { protocol_version: 'bridge.dsh.dev/v1alpha1', change },
      }),
    );
    const previewConfigSha = sha256(await readFile(configPath));
    if (!preview.diff.includes('second-lifecycle') || preview.before_revision === undefined) {
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
    const appliedConfigSha = sha256(await readFile(configPath));
    const stale = await client.callTool({
      name: 'apply_profile_change',
      arguments: {
        protocol_version: 'bridge.dsh.dev/v1alpha1',
        change: {
          operation: 'set_default',
          project_id: 'setup-e2e',
          profile_id: 'baseline-route',
        },
        expected_revision: preview.before_revision,
      },
    });
    const afterStaleConfigSha = sha256(await readFile(configPath));
    if (stale.isError !== true) throw new Error('Stale configuration revision was not rejected');

    await client.close();
    client = await connectBridge();
    const profiles = structured(
      await client.callTool({
        name: 'list_profiles',
        arguments: { protocol_version: 'bridge.dsh.dev/v1alpha1' },
      }),
    );
    if (!profiles.profiles.some((profile) => profile.profile_id === 'second-lifecycle')) {
      throw new Error('Applied Profile was not visible after MCP restart');
    }

    const beforeTaskStatus = await sourceStatus();
    const receipt = structured(
      await client.callTool({
        name: 'delegate_task',
        arguments: {
          protocol_version: 'bridge.dsh.dev/v1alpha1',
          project_id: 'setup-e2e',
          profile_id: 'second-lifecycle',
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
    const {
      artifact: patchArtifact,
      patch,
      hash_verified: hashVerified,
    } = await readPatch(client, result);
    const session = await sessionRoute(receipt.task_id);
    const route = session.route;
    const actualFile = await worktreeProof(
      session.record,
      fixture,
      'lifecycle.txt',
      'SETUP_PROFILE_REAL_CALL_OK\n',
    );
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
    const restoredConfigSha = sha256(await readFile(configPath));
    const profilesAfterRollback = structured(
      await client.callTool({
        name: 'list_profiles',
        arguments: { protocol_version: 'bridge.dsh.dev/v1alpha1' },
      }),
    );
    const checks = {
      live_models_discovered:
        discoveredRoutes.primary.confirmed && discoveredRoutes.second.confirmed,
      preview_and_revision_returned:
        typeof preview.before_revision === 'string' && preview.diff.includes('second-lifecycle'),
      preview_did_not_write: previewConfigSha === baselineConfigSha,
      atomic_apply_requires_restart: applied.changed === true && applied.restart_required === true,
      stale_revision_rejected: stale.isError === true,
      stale_revision_did_not_write: appliedConfigSha === afterStaleConfigSha,
      profile_visible_after_restart: profiles.profiles.some(
        (profile) => profile.profile_id === 'second-lifecycle',
      ),
      real_call_completed:
        task.status === 'completed' &&
        patch.includes('SETUP_PROFILE_REAL_CALL_OK') &&
        actualFile.isolated &&
        actualFile.exact_bytes,
      real_requested_route_observed:
        session.routes.length > 0 &&
        session.routes.every((actual) => routeMatches(actual, routes.second)),
      session_v4_readback: session.header.version === 4,
      artifact_hash_verified: hashVerified,
      task_preserved_main_worktree: beforeTaskStatus === afterTaskStatus,
      rollback_completed: rolledBack.changed === true,
      rollback_removed_profile: !profilesAfterRollback.profiles.some(
        (profile) => profile.profile_id === 'second-lifecycle',
      ),
      rollback_restored_exact_config: restoredConfigSha === baselineConfigSha,
    };
    const evidence = {
      schema: 'dsh-codex-bridge/setup-lifecycle-evidence/v2',
      bridge_version: client.getServerVersion().version,
      dsh_version: runtime.dsh_version,
      runtime,
      requested_models: routes,
      discovered_routes: discoveredRoutes,
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
      artifact: patchArtifact,
      worktree_proof: actualFile,
      config_hashes: {
        before: baselineConfigSha,
        preview: previewConfigSha,
        applied: appliedConfigSha,
        after_stale: afterStaleConfigSha,
        restored: restoredConfigSha,
      },
      checks,
    };
    await writeEvidence(
      evidenceDir,
      'setup-lifecycle.session.v4.json',
      `${JSON.stringify(session, null, 2)}\n`,
    );
    await writeEvidence(evidenceDir, 'setup-lifecycle.patch', patch);
    const evidencePath = await writeEvidence(
      evidenceDir,
      'setup-lifecycle.json',
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({ ...evidence, evidence_path: evidencePath }, null, 2)}\n`,
    );
    succeeded = Object.values(checks).every(Boolean);
    if (!succeeded) throw new Error(`Setup lifecycle checks failed: ${JSON.stringify(checks)}`);
  } finally {
    await client.close().catch(() => undefined);
    if (succeeded) await rm(fixture, { recursive: true, force: true });
  }
}

await main().catch(async (error) => {
  const failure = {
    schema: 'dsh-codex-bridge/setup-lifecycle-evidence/v2',
    bridge_version: BRIDGE_VERSION,
    dsh_version: runtime?.dsh_version,
    expected_dsh_version: DSH_VERSION,
    runtime,
    requested_models: routes,
    fixture,
    error: error instanceof Error ? error.message : String(error),
    stderr_tail: stderrLines.slice(-50),
  };
  const failurePath = await writeEvidence(
    evidenceDir,
    'setup-lifecycle.failure.json',
    `${JSON.stringify(failure, null, 2)}\n`,
  );
  process.stderr.write(
    `${JSON.stringify(
      {
        ...failure,
        evidence_path: failurePath,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
});
