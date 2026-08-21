import { execFile } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await mkdtemp(join(tmpdir(), 'dsh-model-matrix-'));
const evidencePath = resolve(
  process.env.DSH_BRIDGE_EVIDENCE_DIR ?? resolve(root, 'tests/e2e/evidence'),
  'model-matrix.json',
);
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

function profileYaml({ id, provider, model, effort }) {
  return `  - protocol_version: bridge.dsh.dev/v1alpha1
    profile_id: ${id}
    description: Model matrix profile for ${provider}/${model}.
    dsh:
      provider: ${provider}
      model: ${model}
${effort === undefined ? '' : `      reasoning_effort: ${effort}\n`}      agent_preset: standard
      max_tokens: 12000
    delegation:
      max_depth: 2
      max_children: 3
      roles:
        alpha:
          provider: ${provider}
          model: ${model}
${effort === undefined ? '' : `          reasoning_effort: ${effort}\n`}          description: Return the first independently assigned fragment.
        beta:
          provider: ${provider}
          model: ${model}
${effort === undefined ? '' : `          reasoning_effort: ${effort}\n`}          description: Return the second independently assigned fragment.
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
  const profiles = [
    {
      id: 'kimi-code-high',
      provider: 'moonshotai-cn',
      model: 'kimi-k2.7-code',
      effort: 'high',
    },
    {
      id: 'kimi-code-default',
      provider: 'moonshotai-cn',
      model: 'kimi-k2.7-code',
    },
    {
      id: 'deepseek-flash-high',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      effort: 'high',
    },
  ];
  await writeFile(
    join(fixture, 'bridge.yaml'),
    `protocol_version: bridge.dsh.dev/v1alpha1
data_root: .bridge-matrix
log_level: info
projects:
  - project_id: matrix
    root: .
    default_profile: deepseek-flash-high
profiles:
${profiles.map(profileYaml).join('')}`,
  );
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
    if (
      ['completed', 'partial', 'cancelled', 'timed_out', 'interrupted', 'failed'].includes(
        output.task.status,
      )
    ) {
      return output.task;
    }
  }
  throw new Error(`Task ${taskId} did not become terminal`);
}

async function readPatch(client, result) {
  const artifact = result.artifacts.artifacts.find((entry) => entry.kind === 'patch');
  if (artifact === undefined) return { artifact: undefined, patch: '' };
  const output = structured(
    await client.callTool({
      name: 'read_task_artifact',
      arguments: {
        protocol_version: 'bridge.dsh.dev/v1alpha1',
        task_id: result.task_id,
        artifact_id: artifact.artifact_id,
        offset: 0,
        limit: Math.max(1, Math.min(artifact.bytes, 1_048_576)),
        expected_sha256: artifact.sha256,
      },
    }),
  );
  return { artifact, patch: output.data };
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
        ...(delegation === undefined ? {} : { delegation }),
        idempotency_key: key,
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
  const patch = await readPatch(client, result);
  return { receipt, task, result, ...patch, record: await taskRecord(receipt.task_id) };
}

async function sessionEvidence(sessionId) {
  if (typeof sessionId !== 'string') return { route: undefined, subagent_calls: 0 };
  const sessionsRoot = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions');
  const paths = await readdir(sessionsRoot, { recursive: true });
  const relative = paths.find(
    (path) => typeof path === 'string' && path.endsWith(`${sessionId}/session.jsonl.zstd`),
  );
  if (relative === undefined) return { route: undefined, subagent_calls: 0 };
  const { stdout } = await execFileAsync('zstd', ['-dc', resolve(sessionsRoot, relative)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const events = stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const header = events.find((event) => event.type === 'request/header');
  const subagentCalls = events.filter(
    (event) => event.type === 'tool/call' && event.data?.name === 'subagent',
  ).length;
  return {
    route: header?.data?.header?.config,
    subagent_calls: subagentCalls,
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
    patch_sha256: run.artifact?.sha256,
  };
}

async function main() {
  await setupFixture();
  const transport = new StdioClientTransport({
    command: 'dsh',
    args: ['--profile', 'codex-bridge'],
    cwd: fixture,
    env: environment({
      DSH_BRIDGE_CONFIG: join(fixture, 'bridge.yaml'),
      DSH_TELEMETRY_DISABLED: '1',
    }),
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => stderrLines.push(...String(chunk).split('\n')));
  const client = new Client({ name: 'dsh-model-matrix', version: '0.1.0-alpha.2' });
  let succeeded = false;
  try {
    await client.connect(transport, { timeout: 15_000 });
    const startedAt = new Date().toISOString();
    process.stderr.write('[matrix] Kimi high + DeepSeek high concurrent run\n');
    const [kimiHigh, deepseek] = await Promise.all([
      runTask(client, {
        profile: 'kimi-code-high',
        objective:
          'Create kimi.txt containing exactly KIMI_2_7_CODE_HIGH_OK followed by one newline.',
        acceptance: ['kimi.txt has the exact requested single line'],
        delegation: {
          strategy: 'single',
          reason: 'One local file write has no independent workstreams.',
          roles: [],
        },
        key: `kimi-high-${Date.now()}`,
      }),
      runTask(client, {
        profile: 'deepseek-flash-high',
        objective:
          'Create deepseek.txt containing exactly DEEPSEEK_V4_FLASH_HIGH_OK followed by one newline.',
        acceptance: ['deepseek.txt has the exact requested single line'],
        delegation: {
          strategy: 'single',
          reason: 'One local file write has no independent workstreams.',
          roles: [],
        },
        key: `deepseek-high-${Date.now()}`,
      }),
    ]);

    let kimi = kimiHigh;
    let kimiFallbackUsed = false;
    if (kimiHigh.task.status !== 'completed') {
      process.stderr.write('[matrix] Kimi high rejected; retrying model default reasoning\n');
      kimiFallbackUsed = true;
      kimi = await runTask(client, {
        profile: 'kimi-code-default',
        objective:
          'Create kimi.txt containing exactly KIMI_2_7_CODE_DEFAULT_OK followed by one newline.',
        acceptance: ['kimi.txt has the exact requested single line'],
        delegation: {
          strategy: 'single',
          reason: 'One local file write has no independent workstreams.',
          roles: [],
        },
        key: `kimi-default-${Date.now()}`,
      });
    }

    process.stderr.write('[matrix] DeepSeek internal multi-agent run\n');
    const multiAgent = await runTask(client, {
      profile: 'deepseek-flash-high',
      objective:
        'You must call the subagent tool exactly twice: ask one child to return exactly ALPHA+ including the literal plus sign, and another child to return exactly BETA. After both finish, concatenate their outputs verbatim in that order and create multi-agent.txt containing exactly ALPHA+BETA followed by one newline. Do not solve the child assignments yourself.',
      acceptance: [
        'two subagent tool calls are recorded',
        'multi-agent.txt contains exactly ALPHA+BETA and one newline',
      ],
      delegation: {
        strategy: 'auto',
        reason: 'The ALPHA and BETA assignments are independent and can be delegated separately.',
        roles: ['alpha', 'beta'],
      },
      key: `multi-agent-${Date.now()}`,
    });

    process.stderr.write('[matrix] Continue DeepSeek task in same session\n');
    const firstDeepseekRunId = deepseek.result.run_id;
    const firstDeepseekSession = deepseek.record.session_id;
    structured(
      await client.callTool({
        name: 'continue_task',
        arguments: {
          protocol_version: 'bridge.dsh.dev/v1alpha1',
          task_id: deepseek.task.task_id,
          feedback:
            'Change deepseek.txt so it contains exactly DEEPSEEK_V4_FLASH_HIGH_CONTINUED followed by one newline. Change no other file.',
          expected_run_id: firstDeepseekRunId,
          idempotency_key: `continue-${Date.now()}`,
        },
      }),
    );
    const continuedTask = await waitTerminal(client, deepseek.task.task_id);
    const continuedResult = structured(
      await client.callTool({
        name: 'get_task_result',
        arguments: {
          protocol_version: 'bridge.dsh.dev/v1alpha1',
          task_id: deepseek.task.task_id,
        },
      }),
    ).result;
    const continuedPatch = await readPatch(client, continuedResult);
    const continuedRecord = await taskRecord(deepseek.task.task_id);

    const kimiSession = await sessionEvidence(kimi.record.session_id);
    const deepseekSession = await sessionEvidence(continuedRecord.session_id);
    const multiSession = await sessionEvidence(multiAgent.record.session_id);
    const overlap =
      new Date(kimiHigh.task.started_at ?? 0).getTime() <=
        new Date(deepseek.task.finished_at ?? 0).getTime() &&
      new Date(deepseek.task.started_at ?? 0).getTime() <=
        new Date(kimiHigh.task.finished_at ?? 0).getTime();
    const mainStatus = (await git(['status', '--porcelain=v1', '--untracked-files=all'])).stdout
      .split('\n')
      .filter((line) => line && !line.includes('bridge.yaml') && !line.includes('.bridge-matrix'));
    const checks = {
      kimi_model_completed:
        kimi.task.status === 'completed' && kimi.patch.includes('KIMI_2_7_CODE'),
      deepseek_high_completed:
        deepseek.task.status === 'completed' &&
        deepseek.patch.includes('DEEPSEEK_V4_FLASH_HIGH_OK'),
      different_models_routed:
        kimiSession.route?.provider === 'moonshotai-cn' &&
        kimiSession.route?.model === 'kimi-k2.7-code' &&
        deepseekSession.route?.provider === 'deepseek-official' &&
        deepseekSession.route?.model === 'deepseek-v4-flash' &&
        deepseekSession.route?.reasoningEffort === 'high',
      concurrent_agent_windows_overlap: overlap,
      internal_multi_agent_completed:
        multiAgent.task.status === 'completed' &&
        multiAgent.patch.includes('ALPHA+BETA') &&
        multiSession.subagent_calls >= 2 &&
        multiAgent.result.delegation_decision?.resolved_strategy === 'multi' &&
        multiAgent.result.delegation_evidence?.observed?.subagent_calls >= 2 &&
        multiAgent.result.delegation_evidence?.children_completed >= 2,
      continuous_same_session:
        continuedTask.status === 'completed' &&
        firstDeepseekSession === continuedRecord.session_id &&
        firstDeepseekRunId !== continuedResult.run_id &&
        continuedPatch.patch.includes('DEEPSEEK_V4_FLASH_HIGH_CONTINUED'),
      main_worktree_unchanged: mainStatus.length === 0,
    };
    const evidence = {
      schema: 'dsh-codex-bridge/model-matrix-evidence/v2',
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      requested_models: {
        kimi: { provider: 'moonshotai-cn', model: 'kimi-k2.7-code', reasoning_effort: 'high' },
        deepseek: {
          provider: 'deepseek-official',
          model: 'deepseek-v4-flash',
          reasoning_effort: 'high',
        },
      },
      kimi_high_attempt: compact(kimiHigh),
      kimi_fallback_used: kimiFallbackUsed,
      kimi_effective: { ...compact(kimi), route: kimiSession.route },
      deepseek: { ...compact(deepseek), route: deepseekSession.route },
      multi_agent: {
        ...compact(multiAgent),
        route: multiSession.route,
        subagent_calls: multiSession.subagent_calls,
      },
      continuation: {
        task_id: continuedTask.task_id,
        first_run_id: firstDeepseekRunId,
        second_run_id: continuedResult.run_id,
        first_session_id: firstDeepseekSession,
        second_session_id: continuedRecord.session_id,
        result_history_count: continuedRecord.result_history?.length ?? 0,
        patch_sha256: continuedPatch.artifact?.sha256,
      },
      checks,
    };
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    succeeded = Object.values(checks).every(Boolean);
    if (!succeeded) process.exitCode = 1;
  } finally {
    await client.close().catch(() => undefined);
    if (succeeded) await rm(fixture, { recursive: true, force: true });
  }
}

await main().catch(async (error) => {
  const failure = {
    schema: 'dsh-codex-bridge/model-matrix-evidence/v2',
    completed_at: new Date().toISOString(),
    fixture,
    error: error instanceof Error ? error.message : String(error),
    stderr_tail: stderrLines.filter(Boolean).slice(-50),
  };
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(failure, null, 2)}\n`);
  process.stderr.write(`${failure.error}\n`);
  process.exitCode = 1;
});
