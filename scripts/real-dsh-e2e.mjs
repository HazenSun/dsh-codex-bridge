import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  BRIDGE_VERSION,
  DSH_VERSION,
  discoverRoutes,
  environment,
  evidenceDirectory,
  readRuntime,
  requestedRoutes,
  routeMatches,
  savedSession,
  structured,
  verifyConnection,
  worktreeProof,
  writeEvidence,
} from './e2e-support.mjs';

const execFileAsync = promisify(execFile);
const evidenceDir = await evidenceDirectory('dsh-codex-bridge-e2e');
const { primary: requestedRoute } = requestedRoutes();
const fixture = await mkdtemp(join(tmpdir(), 'dsh-codex-bridge-e2e-'));
const stderrLines = [];
let runtime;

async function git(args) {
  return execFileAsync('git', ['-C', fixture, ...args], { encoding: 'utf8' });
}

async function setupFixture() {
  await execFileAsync('git', ['init', '-q', fixture]);
  await git(['config', 'user.name', 'DSH Bridge E2E']);
  await git(['config', 'user.email', 'e2e@example.test']);
  await writeFile(join(fixture, 'README.md'), '# DSH Bridge E2E Fixture\n');
  await git(['add', 'README.md']);
  await git(['commit', '-qm', 'fixture baseline']);
  await writeFile(
    join(fixture, 'bridge.yaml'),
    `protocol_version: bridge.dsh.dev/v1alpha1
data_root: .bridge-e2e
log_level: info
projects:
  - project_id: e2e-fixture
    root: .
    default_profile: primary-builder
profiles:
  - protocol_version: bridge.dsh.dev/v1alpha1
    profile_id: primary-builder
    description: Real DSH 0.2.0-rc.2 closed-loop verification.
    dsh:
      provider: ${requestedRoute.provider}
      model: ${requestedRoute.model}
      reasoning_effort: ${requestedRoute.reasoning_effort}
      agent_preset: standard
      max_tokens: 8000
    delegation:
      max_depth: 1
      max_children: 1
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
}

async function main() {
  runtime = await readRuntime();
  await setupFixture();
  process.stderr.write(`[e2e] fixture ${fixture}\n`);
  const processEnvironment = environment({
    DSH_BRIDGE_CONFIG: join(fixture, 'bridge.yaml'),
    DSH_TELEMETRY_DISABLED: '1',
  });
  const profileDump = await execFileAsync(
    runtime.command,
    ['--profile', 'codex-bridge', '--dump-config'],
    {
      cwd: fixture,
      env: processEnvironment,
      encoding: 'utf8',
      timeout: 20_000,
    },
  );
  const transport = new StdioClientTransport({
    command: runtime.command,
    args: ['--profile', 'codex-bridge'],
    cwd: fixture,
    env: processEnvironment,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => {
    stderrLines.push(...String(chunk).split('\n').filter(Boolean));
  });
  const client = new Client({ name: 'dsh-bridge-real-e2e', version: BRIDGE_VERSION });
  const startedAt = new Date().toISOString();
  let succeeded = false;
  try {
    process.stderr.write('[e2e] connect\n');
    await client.connect(transport);
    const server = await verifyConnection(client, runtime);
    const discoveredRoutes = await discoverRoutes(client, { primary: requestedRoute });
    process.stderr.write('[e2e] list-tools\n');
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    const requiredTools = [
      'cancel_task',
      'continue_task',
      'delegate_task',
      'get_task',
      'get_task_result',
      'list_profiles',
      'read_task_artifact',
      'wait_task',
      'discover_dsh_models',
    ];
    for (const tool of requiredTools) {
      if (!tools.includes(tool)) throw new Error(`Missing MCP tool: ${tool}`);
    }

    process.stderr.write('[e2e] list-profiles\n');
    const profiles = structured(
      await client.callTool({
        name: 'list_profiles',
        arguments: { protocol_version: 'bridge.dsh.dev/v1alpha1' },
      }),
    );
    process.stderr.write('[e2e] delegate-task\n');
    const delegated = structured(
      await client.callTool({
        name: 'delegate_task',
        arguments: {
          protocol_version: 'bridge.dsh.dev/v1alpha1',
          project_id: 'e2e-fixture',
          profile_id: 'primary-builder',
          objective:
            'Create a file named bridge-proof.txt containing exactly the single line DSH_CODEX_BRIDGE_OK followed by a newline. Do not modify any other tracked file.',
          acceptance_criteria: [
            'bridge-proof.txt exists in the isolated worktree',
            'its exact content is DSH_CODEX_BRIDGE_OK followed by one newline',
            'the main project working tree remains unchanged',
          ],
          idempotency_key: `real-e2e-${Date.now()}`,
        },
      }),
    );
    const taskId = delegated.task_id;
    process.stderr.write(`[e2e] delegated ${taskId}\n`);
    let task;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      process.stderr.write(`[e2e] wait-task ${attempt + 1}\n`);
      const waited = structured(
        await client.callTool(
          {
            name: 'wait_task',
            arguments: {
              protocol_version: 'bridge.dsh.dev/v1alpha1',
              task_id: taskId,
              timeout_seconds: 15,
            },
          },
          undefined,
          { timeout: 25_000 },
        ),
      );
      task = waited.task;
      process.stderr.write(`[e2e] status ${task.status}\n`);
      if (
        ['completed', 'partial', 'cancelled', 'timed_out', 'interrupted', 'failed'].includes(
          task.status,
        )
      ) {
        break;
      }
    }
    if (task === undefined) throw new Error('Task status was never returned');
    if (!['completed', 'partial'].includes(task.status)) {
      throw new Error(`Real DSH task ended as ${task.status}: ${JSON.stringify(task.error ?? {})}`);
    }
    process.stderr.write('[e2e] get-result\n');
    const resultEnvelope = structured(
      await client.callTool({
        name: 'get_task_result',
        arguments: { protocol_version: 'bridge.dsh.dev/v1alpha1', task_id: taskId },
      }),
    );
    const result = resultEnvelope.result;
    const patchRef = result.artifacts.artifacts.find((artifact) => artifact.kind === 'patch');
    if (patchRef === undefined) throw new Error('Result has no patch artifact');
    process.stderr.write('[e2e] read-patch\n');
    const patchPage = structured(
      await client.callTool({
        name: 'read_task_artifact',
        arguments: {
          protocol_version: 'bridge.dsh.dev/v1alpha1',
          task_id: taskId,
          artifact_id: patchRef.artifact_id,
          offset: 0,
          limit: Math.min(patchRef.bytes, 1_048_576),
          expected_sha256: patchRef.sha256,
        },
      }),
    );
    const patch = patchPage.data;
    const storedTask = JSON.parse(
      await readFile(join(fixture, '.bridge-e2e', 'tasks', taskId, 'task.json'), 'utf8'),
    );
    const firstSession = await savedSession(runtime, storedTask.session_id);
    const firstFile = await worktreeProof(
      storedTask,
      fixture,
      'bridge-proof.txt',
      'DSH_CODEX_BRIDGE_OK\n',
    );
    const mainStatus = (await git(['status', '--porcelain=v1', '--untracked-files=all'])).stdout
      .split('\n')
      .filter((line) => line && !line.includes('bridge.yaml') && !line.includes('.bridge-e2e'));

    process.stderr.write('[e2e] continue-task\n');
    const continuationReceipt = structured(
      await client.callTool({
        name: 'continue_task',
        arguments: {
          protocol_version: 'bridge.dsh.dev/v1alpha1',
          task_id: taskId,
          feedback:
            'Change bridge-proof.txt so its only line is DSH_CODEX_BRIDGE_CONTINUED followed by one newline. Verify the exact bytes and do not modify any other file.',
          expected_run_id: result.run_id,
          idempotency_key: `real-continue-e2e-${Date.now()}`,
        },
      }),
    );
    let continuationTask;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      continuationTask = structured(
        await client.callTool(
          {
            name: 'wait_task',
            arguments: {
              protocol_version: 'bridge.dsh.dev/v1alpha1',
              task_id: taskId,
              timeout_seconds: 15,
            },
          },
          undefined,
          { timeout: 25_000 },
        ),
      ).task;
      if (
        ['completed', 'partial', 'cancelled', 'timed_out', 'interrupted', 'failed'].includes(
          continuationTask.status,
        )
      ) {
        break;
      }
    }
    if (continuationTask?.status !== 'completed') {
      throw new Error(`Continuation task ended as ${continuationTask?.status ?? 'unknown'}`);
    }
    const continuationResult = structured(
      await client.callTool({
        name: 'get_task_result',
        arguments: { protocol_version: 'bridge.dsh.dev/v1alpha1', task_id: taskId },
      }),
    ).result;
    const continuationPatchRef = continuationResult.artifacts.artifacts.find(
      (artifact) => artifact.kind === 'patch',
    );
    if (continuationPatchRef === undefined) throw new Error('Continuation has no patch artifact');
    const continuationPatch = structured(
      await client.callTool({
        name: 'read_task_artifact',
        arguments: {
          protocol_version: 'bridge.dsh.dev/v1alpha1',
          task_id: taskId,
          artifact_id: continuationPatchRef.artifact_id,
          offset: 0,
          limit: Math.min(continuationPatchRef.bytes, 1_048_576),
          expected_sha256: continuationPatchRef.sha256,
        },
      }),
    ).data;
    const continuedStoredTask = JSON.parse(
      await readFile(join(fixture, '.bridge-e2e', 'tasks', taskId, 'task.json'), 'utf8'),
    );
    const continuedSession = await savedSession(
      runtime,
      continuedStoredTask.session_id,
      firstSession.last_event_seq,
    );
    const continuedFile = await worktreeProof(
      continuedStoredTask,
      fixture,
      'bridge-proof.txt',
      'DSH_CODEX_BRIDGE_CONTINUED\n',
    );

    process.stderr.write('[e2e] delegate-cancellation-task\n');
    const cancelDelegated = structured(
      await client.callTool({
        name: 'delegate_task',
        arguments: {
          protocol_version: 'bridge.dsh.dev/v1alpha1',
          project_id: 'e2e-fixture',
          profile_id: 'primary-builder',
          objective:
            'Inspect the repository in detail, then create a long-report.md containing a comprehensive analysis. Do not finish early.',
          acceptance_criteria: ['The task will be cancelled before completion.'],
          idempotency_key: `real-cancel-e2e-${Date.now()}`,
        },
      }),
    );
    let cancellationTask;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      cancellationTask = structured(
        await client.callTool(
          {
            name: 'wait_task',
            arguments: {
              protocol_version: 'bridge.dsh.dev/v1alpha1',
              task_id: cancelDelegated.task_id,
              timeout_seconds: 2,
            },
          },
          undefined,
          { timeout: 10_000 },
        ),
      ).task;
      if (cancellationTask.status === 'running') break;
      if (
        ['completed', 'partial', 'cancelled', 'timed_out', 'interrupted', 'failed'].includes(
          cancellationTask.status,
        )
      ) {
        throw new Error(`Cancellation task became ${cancellationTask.status} before cancellation`);
      }
    }
    if (cancellationTask?.status !== 'running') {
      throw new Error('Cancellation task never entered running');
    }
    const cancellationReceipt = structured(
      await client.callTool({
        name: 'cancel_task',
        arguments: {
          protocol_version: 'bridge.dsh.dev/v1alpha1',
          task_id: cancelDelegated.task_id,
          reason: 'real DSH cancellation E2E',
        },
      }),
    );
    for (let attempt = 0; attempt < 12; attempt += 1) {
      cancellationTask = structured(
        await client.callTool(
          {
            name: 'wait_task',
            arguments: {
              protocol_version: 'bridge.dsh.dev/v1alpha1',
              task_id: cancelDelegated.task_id,
              timeout_seconds: 2,
            },
          },
          undefined,
          { timeout: 10_000 },
        ),
      ).task;
      if (cancellationTask.status === 'cancelled') break;
    }
    const cancellationResult = structured(
      await client.callTool({
        name: 'get_task_result',
        arguments: {
          protocol_version: 'bridge.dsh.dev/v1alpha1',
          task_id: cancelDelegated.task_id,
        },
      }),
    ).result;
    const finalMainStatus = (
      await git(['status', '--porcelain=v1', '--untracked-files=all'])
    ).stdout
      .split('\n')
      .filter((line) => line && !line.includes('bridge.yaml') && !line.includes('.bridge-e2e'));
    const checks = {
      mcp_tools_present: requiredTools.every((tool) => tools.includes(tool)),
      profile_routed: profiles.profiles.some((profile) => profile.profile_id === 'primary-builder'),
      task_completed: task.status === 'completed',
      patch_contains_proof:
        patch.includes('bridge-proof.txt') && patch.includes('DSH_CODEX_BRIDGE_OK'),
      artifact_hash_verified: createHash('sha256').update(patch).digest('hex') === patchRef.sha256,
      main_worktree_unchanged: mainStatus.length === 0 && finalMainStatus.length === 0,
      actual_file_bytes_verified: firstFile.isolated && firstFile.exact_bytes,
      continuation_file_bytes_verified: continuedFile.isolated && continuedFile.exact_bytes,
      requested_route_observed:
        firstSession.routes.length > 0 &&
        firstSession.routes.every((route) => routeMatches(route, requestedRoute)),
      continuation_route_observed:
        continuedSession.routes.length > 0 &&
        continuedSession.routes.every((route) => routeMatches(route, requestedRoute)),
      saved_session_v4: firstSession.header.version === 4 && continuedSession.header.version === 4,
      session_persisted:
        typeof storedTask.session_id === 'string' && storedTask.session_id.startsWith('bridge-'),
      run_id_consistent:
        typeof storedTask.task?.run_id === 'string' && storedTask.task.run_id === result.run_id,
      dsh_subagent_preset_composed:
        profileDump.stdout.includes('@deepseek-ai/dsh-agent-preset-registry') &&
        profileDump.stdout.includes('default: standard'),
      real_cancel_converged:
        cancellationReceipt.status === 'cancelling' &&
        cancellationTask.status === 'cancelled' &&
        cancellationResult.error?.code === 'TASK_CANCELLED',
      real_continue_same_session:
        continuationReceipt.task_id === taskId &&
        continuedStoredTask.session_id === storedTask.session_id &&
        continuationResult.run_id !== result.run_id &&
        continuedStoredTask.task?.run_id === continuationResult.run_id,
      real_continue_history_retained:
        Array.isArray(continuedStoredTask.result_history) &&
        continuedStoredTask.result_history.length === 1 &&
        continuedStoredTask.result_history[0]?.run_id === result.run_id,
      continuation_patch_verified:
        continuationPatch.includes('DSH_CODEX_BRIDGE_CONTINUED') &&
        createHash('sha256').update(continuationPatch).digest('hex') ===
          continuationPatchRef.sha256,
    };
    await writeEvidence(evidenceDir, 'real-dsh-rc2.patch', patch);
    await writeEvidence(evidenceDir, 'real-dsh-rc2-continue.patch', continuationPatch);
    await writeEvidence(
      evidenceDir,
      'real-dsh-rc2-initial.session.v4.json',
      `${JSON.stringify(firstSession, null, 2)}\n`,
    );
    await writeEvidence(
      evidenceDir,
      'real-dsh-rc2-continued.session.v4.json',
      `${JSON.stringify(continuedSession, null, 2)}\n`,
    );
    const evidencePath = await writeEvidence(
      evidenceDir,
      'real-dsh-rc2.json',
      `${JSON.stringify(
        {
          schema: 'dsh-codex-bridge/e2e-evidence/v1',
          bridge_version: server.version,
          dsh_version: runtime.dsh_version,
          runtime,
          requested_route: requestedRoute,
          discovered_routes: discoveredRoutes,
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          task_id: taskId,
          task_status: task.status,
          tools,
          profile_id: 'primary-builder',
          model: requestedRoute.model,
          observed_routes: firstSession.routes,
          worktree_proof: firstFile,
          session_id: storedTask.session_id,
          run_id: result.run_id,
          continuation: {
            run_id: continuationResult.run_id,
            session_id: continuedStoredTask.session_id,
            artifact: continuationPatchRef,
            observed_routes: continuedSession.routes,
            worktree_proof: continuedFile,
          },
          cancellation: {
            task_id: cancelDelegated.task_id,
            receipt_status: cancellationReceipt.status,
            final_status: cancellationTask.status,
            error_code: cancellationResult.error?.code,
          },
          result_summary: result.summary,
          artifact: patchRef,
          checks,
        },
        null,
        2,
      )}\n`,
    );
    if (Object.values(checks).some((value) => !value))
      throw new Error(`Closed-loop checks failed: ${JSON.stringify(checks)}`);
    succeeded = true;
    process.stdout.write(
      `${JSON.stringify({ evidence_path: evidencePath, task_id: taskId, status: task.status, checks }, null, 2)}\n`,
    );
  } finally {
    await client.close().catch(() => undefined);
    if (succeeded) await rm(fixture, { recursive: true, force: true });
  }
}

await main().catch(async (error) => {
  const failure = {
    schema: 'dsh-codex-bridge/e2e-evidence/v1',
    bridge_version: BRIDGE_VERSION,
    dsh_version: runtime?.dsh_version,
    expected_dsh_version: DSH_VERSION,
    runtime,
    requested_route: requestedRoute,
    completed_at: new Date().toISOString(),
    fixture,
    error: error instanceof Error ? error.message : String(error),
    stderr_tail: stderrLines.slice(-40),
  };
  await writeEvidence(
    evidenceDir,
    'real-dsh-rc2.failure.json',
    `${JSON.stringify(failure, null, 2)}\n`,
  );
  process.stderr.write(`${failure.error}\n`);
  process.exitCode = 1;
});
