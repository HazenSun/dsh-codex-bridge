import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

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
  structured,
  verifyConnection,
  waitTerminal,
  worktreeProof,
  writeEvidence,
} from './e2e-support.mjs';

const fixture = await mkdtemp(join(tmpdir(), 'dsh-model-matrix-'));
const evidenceDir = await evidenceDirectory('dsh-model-matrix');
const routes = requestedRoutes();
const stderrLines = [];
let runtime;

async function git(args) {
  return execFileAsync('git', ['-C', fixture, ...args], { encoding: 'utf8' });
}

function profileYaml(id, route) {
  return `  - protocol_version: bridge.dsh.dev/v1alpha1
    profile_id: ${id}
    description: Model matrix profile for ${route.provider}/${route.model}.
    dsh:
      provider: ${route.provider}
      model: ${route.model}
      reasoning_effort: ${route.reasoning_effort}
      agent_preset: standard
      max_tokens: 12000
    delegation:
      max_depth: 2
      max_children: 3
      roles:
        alpha:
          provider: ${route.provider}
          model: ${route.model}
          reasoning_effort: ${route.reasoning_effort}
          description: Return the first independently assigned fragment.
        beta:
          provider: ${route.provider}
          model: ${route.model}
          reasoning_effort: ${route.reasoning_effort}
          description: Return the second independently assigned fragment.
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
      max_files: 30
      disk_quota_bytes: 104857600
`;
}

async function setupFixture() {
  await execFileAsync('git', ['init', '-q', fixture]);
  await git(['config', 'user.name', 'DSH Matrix Test']);
  await git(['config', 'user.email', 'matrix@example.test']);
  await writeFile(join(fixture, 'README.md'), '# DSH model matrix fixture\n');
  await git(['add', 'README.md']);
  await git(['commit', '-qm', 'matrix baseline']);
  await writeFile(
    join(fixture, 'bridge.yaml'),
    `protocol_version: bridge.dsh.dev/v1alpha1
data_root: .bridge-matrix
log_level: info
projects:
  - project_id: matrix
    root: .
    default_profile: primary-route
profiles:
${profileYaml('primary-route', routes.primary)}${profileYaml('second-route', routes.second)}`,
  );
}

async function taskRecord(taskId) {
  return JSON.parse(
    await readFile(join(fixture, '.bridge-matrix', 'tasks', taskId, 'task.json'), 'utf8'),
  );
}

async function runTask(client, { profile, objective, acceptance, delegation, key }) {
  const receipt = structured(
    await client.callTool({
      name: 'delegate_task',
      arguments: {
        protocol_version: 'bridge.dsh.dev/v1alpha1',
        project_id: 'matrix',
        profile_id: profile,
        objective,
        acceptance_criteria: acceptance,
        delegation,
        idempotency_key: key,
      },
    }),
  );
  const task = await waitTerminal(client, receipt.task_id);
  const { result } = structured(
    await client.callTool({
      name: 'get_task_result',
      arguments: { protocol_version: 'bridge.dsh.dev/v1alpha1', task_id: receipt.task_id },
    }),
  );
  return {
    receipt,
    task,
    result,
    ...(await readPatch(client, result)),
    record: await taskRecord(receipt.task_id),
  };
}

function compact(run) {
  return {
    task_id: run.task.task_id,
    status: run.task.status,
    run_id: run.result.run_id,
    session_id: run.record.session_id,
    started_at: run.task.started_at,
    finished_at: run.task.finished_at,
    summary: run.result.summary,
    error: run.result.error,
    delegation_decision: run.result.delegation_decision,
    delegation_evidence: run.result.delegation_evidence,
    patch_sha256: run.artifact.sha256,
    patch_hash_verified: run.hash_verified,
  };
}

const singleDelegation = {
  strategy: 'single',
  reason: 'One local file write has no independent workstreams.',
  roles: [],
};

async function main() {
  if (
    routes.primary.provider === routes.second.provider &&
    routes.primary.model === routes.second.model
  )
    throw new Error('Model matrix requires two distinct provider/model routes');
  runtime = await readRuntime();
  await setupFixture();
  const transport = new StdioClientTransport({
    command: runtime.command,
    args: ['--profile', 'codex-bridge'],
    cwd: fixture,
    env: environment({
      DSH_BRIDGE_CONFIG: join(fixture, 'bridge.yaml'),
      DSH_TELEMETRY_DISABLED: '1',
    }),
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) =>
    stderrLines.push(...String(chunk).split('\n').filter(Boolean)),
  );
  const client = new Client({ name: 'dsh-model-matrix', version: BRIDGE_VERSION });
  let succeeded = false;
  try {
    await client.connect(transport, { timeout: 15_000 });
    const server = await verifyConnection(client, runtime);
    const discoveredRoutes = await discoverRoutes(client, routes);
    const startedAt = new Date().toISOString();
    process.stderr.write(
      `[matrix] Concurrent ${routes.primary.provider}/${routes.primary.model} + ${routes.second.provider}/${routes.second.model}\n`,
    );
    const parallel = await Promise.allSettled([
      runTask(client, {
        profile: 'primary-route',
        objective:
          'Create primary.txt containing exactly PRIMARY_MODEL_OK followed by one newline. Change no other file.',
        acceptance: ['primary.txt has the exact requested single line'],
        delegation: singleDelegation,
        key: `primary-${Date.now()}`,
      }),
      runTask(client, {
        profile: 'second-route',
        objective:
          'Create second.txt containing exactly SECOND_MODEL_OK followed by one newline. Change no other file.',
        acceptance: ['second.txt has the exact requested single line'],
        delegation: singleDelegation,
        key: `second-${Date.now()}`,
      }),
    ]);
    const failures = parallel.filter((result) => result.status === 'rejected');
    if (failures.length > 0)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Model matrix execution failed; no reasoning fallback was attempted',
      );
    const [primary, second] = parallel.map((result) => result.value);
    const primarySession = await savedSession(runtime, primary.record.session_id);
    const secondSession = await savedSession(runtime, second.record.session_id);
    const primaryFile = await worktreeProof(
      primary.record,
      fixture,
      'primary.txt',
      'PRIMARY_MODEL_OK\n',
    );
    const secondFile = await worktreeProof(
      second.record,
      fixture,
      'second.txt',
      'SECOND_MODEL_OK\n',
    );

    process.stderr.write('[matrix] Synchronous internal subagent run\n');
    const multiAgent = await runTask(client, {
      profile: 'primary-route',
      objective:
        'You must call the subagent tool exactly twice, explicitly passing run_in_background:false to both calls. Ask one child to return exactly ALPHA+ including the literal plus sign, and another child to return exactly BETA. Wait for both successful foreground results, concatenate their outputs verbatim in that order, and create multi-agent.txt containing exactly ALPHA+BETA followed by one newline. Do not solve the child assignments yourself. Change no other file.',
      acceptance: [
        'two synchronous successful subagent tool calls are recorded',
        'multi-agent.txt contains exactly ALPHA+BETA and one newline',
      ],
      delegation: {
        strategy: 'auto',
        reason: 'The ALPHA and BETA assignments are independent and can be delegated separately.',
        roles: ['alpha', 'beta'],
      },
      key: `multi-agent-${Date.now()}`,
    });
    const multiSession = await savedSession(runtime, multiAgent.record.session_id);
    const multiFile = await worktreeProof(
      multiAgent.record,
      fixture,
      'multi-agent.txt',
      'ALPHA+BETA\n',
    );

    process.stderr.write('[matrix] Continue primary task in the same session\n');
    const firstRunId = primary.result.run_id;
    const firstSessionId = primary.record.session_id;
    const continuationArguments = {
      protocol_version: 'bridge.dsh.dev/v1alpha1',
      task_id: primary.task.task_id,
      feedback:
        'Change primary.txt so it contains exactly PRIMARY_MODEL_CONTINUED followed by one newline. Change no other file.',
      expected_run_id: firstRunId,
      idempotency_key: `continue-${Date.now()}`,
    };
    const continuationReceipt = structured(
      await client.callTool({
        name: 'continue_task',
        arguments: continuationArguments,
      }),
    );
    const retriedContinuation = structured(
      await client.callTool({
        name: 'continue_task',
        arguments: continuationArguments,
      }),
    );
    const continuedTask = await waitTerminal(client, primary.task.task_id);
    const { result: continuedResult } = structured(
      await client.callTool({
        name: 'get_task_result',
        arguments: { protocol_version: 'bridge.dsh.dev/v1alpha1', task_id: primary.task.task_id },
      }),
    );
    const continuedPatch = await readPatch(client, continuedResult);
    const continuedRecord = await taskRecord(primary.task.task_id);
    const continuedSession = await savedSession(
      runtime,
      continuedRecord.session_id,
      primarySession.last_event_seq,
    );
    const continuedFile = await worktreeProof(
      continuedRecord,
      fixture,
      'primary.txt',
      'PRIMARY_MODEL_CONTINUED\n',
    );
    const overlap =
      [
        primary.task.started_at,
        primary.task.finished_at,
        second.task.started_at,
        second.task.finished_at,
      ].every(
        (timestamp) => typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)),
      ) &&
      new Date(primary.task.started_at ?? 0).getTime() <=
        new Date(second.task.finished_at ?? 0).getTime() &&
      new Date(second.task.started_at ?? 0).getTime() <=
        new Date(primary.task.finished_at ?? 0).getTime();
    const mainStatus = (await git(['status', '--porcelain=v1', '--untracked-files=all'])).stdout
      .split('\n')
      .filter((line) => line && !line.includes('bridge.yaml') && !line.includes('.bridge-matrix'));
    const matches = (session, route) =>
      session.routes.length > 0 && session.routes.every((actual) => routeMatches(actual, route));
    const checks = {
      continuation_retry_is_idempotent:
        isDeepStrictEqual(continuationReceipt, retriedContinuation) &&
        continuedRecord.result_history?.length === 1,
      primary_model_completed:
        primary.task.status === 'completed' && primaryFile.exact_bytes && primaryFile.isolated,
      second_model_completed:
        second.task.status === 'completed' && secondFile.exact_bytes && secondFile.isolated,
      distinct_requested_models_routed:
        matches(primarySession, routes.primary) && matches(secondSession, routes.second),
      concurrent_agent_windows_overlap: overlap,
      internal_multi_agent_completed:
        multiAgent.task.status === 'completed' &&
        multiFile.exact_bytes &&
        multiFile.isolated &&
        matches(multiSession, routes.primary) &&
        multiSession.subagent_calls === 2 &&
        multiSession.children.every((child) => child.foreground_requested && child.completed) &&
        multiSession.children.some((child) => child.output?.trim() === 'ALPHA+') &&
        multiSession.children.some((child) => child.output?.trim() === 'BETA') &&
        multiAgent.result.delegation_decision?.resolved_strategy === 'multi' &&
        multiAgent.result.delegation_evidence?.observed?.subagent_calls === 2 &&
        multiAgent.result.delegation_evidence?.children_completed === 2,
      continuous_same_session:
        continuedTask.status === 'completed' &&
        continuationReceipt.task_id === primary.task.task_id &&
        firstSessionId === continuedRecord.session_id &&
        firstRunId !== continuedResult.run_id &&
        continuedFile.exact_bytes &&
        continuedFile.isolated &&
        matches(continuedSession, routes.primary),
      continuation_history_retained:
        continuedRecord.result_history?.length === 1 &&
        continuedRecord.result_history[0].run_id === firstRunId,
      continuation_has_no_old_subagent_evidence:
        continuedSession.subagent_calls === 0 &&
        continuedResult.delegation_evidence?.observed?.subagent_calls === 0,
      all_artifact_hashes_verified:
        primary.hash_verified &&
        second.hash_verified &&
        multiAgent.hash_verified &&
        continuedPatch.hash_verified,
      all_sessions_v4: [primarySession, secondSession, multiSession, continuedSession].every(
        (session) => session.header.version === 4,
      ),
      main_worktree_unchanged: mainStatus.length === 0,
    };
    const evidence = {
      schema: 'dsh-codex-bridge/model-matrix-evidence/v3',
      bridge_version: server.version,
      dsh_version: runtime.dsh_version,
      runtime,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      requested_models: routes,
      discovered_routes: discoveredRoutes,
      primary: { ...compact(primary), route: primarySession.route, worktree_proof: primaryFile },
      second: { ...compact(second), route: secondSession.route, worktree_proof: secondFile },
      multi_agent: {
        ...compact(multiAgent),
        route: multiSession.route,
        subagent_calls: multiSession.subagent_calls,
        children: multiSession.children,
        worktree_proof: multiFile,
      },
      continuation: {
        task_id: continuedTask.task_id,
        first_run_id: firstRunId,
        second_run_id: continuedResult.run_id,
        first_session_id: firstSessionId,
        second_session_id: continuedRecord.session_id,
        result_history_count: continuedRecord.result_history?.length ?? 0,
        patch_sha256: continuedPatch.artifact.sha256,
        route: continuedSession.route,
        worktree_proof: continuedFile,
      },
      checks,
    };
    for (const [name, session] of Object.entries({
      primary: primarySession,
      second: secondSession,
      multi: multiSession,
      continued: continuedSession,
    }))
      await writeEvidence(
        evidenceDir,
        `${name}.session.v4.json`,
        `${JSON.stringify(session, null, 2)}\n`,
      );
    for (const [name, run] of Object.entries({
      primary,
      second,
      multi: multiAgent,
      continued: continuedPatch,
    }))
      await writeEvidence(evidenceDir, `${name}.patch`, run.patch);
    const evidencePath = await writeEvidence(
      evidenceDir,
      'model-matrix.json',
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({ ...evidence, evidence_path: evidencePath }, null, 2)}\n`,
    );
    succeeded = Object.values(checks).every(Boolean);
    if (!succeeded) throw new Error(`Model matrix checks failed: ${JSON.stringify(checks)}`);
  } finally {
    await client.close().catch(() => undefined);
    if (succeeded) await rm(fixture, { recursive: true, force: true });
  }
}

await main().catch(async (error) => {
  const failure = {
    schema: 'dsh-codex-bridge/model-matrix-evidence/v3',
    bridge_version: BRIDGE_VERSION,
    dsh_version: runtime?.dsh_version,
    expected_dsh_version: DSH_VERSION,
    runtime,
    requested_models: routes,
    completed_at: new Date().toISOString(),
    fixture,
    error: error instanceof Error ? error.message : String(error),
    stderr_tail: stderrLines.slice(-50),
  };
  const failurePath = await writeEvidence(
    evidenceDir,
    'model-matrix.failure.json',
    `${JSON.stringify(failure, null, 2)}\n`,
  );
  process.stderr.write(`${failure.error}\nEvidence: ${failurePath}\n`);
  process.exitCode = 1;
});
