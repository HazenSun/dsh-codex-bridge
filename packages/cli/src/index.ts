#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';

import { loadBridgeConfig } from '@dsh-codex-bridge/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Command } from 'commander';

const execFileAsync = promisify(execFile);
const VERSION = '0.1.0-alpha.1';
const DSH_VERSION = '0.1.0-rc.8';

async function run(
  command: string,
  args: readonly string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, {
    ...(cwd === undefined ? {} : { cwd }),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function configTemplate(projectId: string): string {
  return `protocol_version: bridge.dsh.dev/v1alpha1
data_root: .dsh-codex-bridge
log_level: info

projects:
  - project_id: ${projectId}
    root: .
    default_profile: deepseek-builder

profiles:
  - protocol_version: bridge.dsh.dev/v1alpha1
    profile_id: deepseek-builder
    description: Implement focused coding tasks with an isolated workspace and verifiable output.
    dsh:
      provider: deepseek-official
      model: deepseek-v4-flash
      reasoning_effort: high
      agent_preset: standard
      max_tokens: 32000
    delegation:
      max_depth: 2
      max_children: 3
      roles:
        analysis:
          provider: deepseek-official
          model: deepseek-v4-flash
          reasoning_effort: high
          description: Explore an independent implementation path or failure hypothesis.
        tests:
          provider: deepseek-official
          model: deepseek-v4-flash
          reasoning_effort: high
          description: Verify behavior and identify missing coverage independently.
        reviewer:
          provider: deepseek-official
          model: deepseek-v4-flash
          reasoning_effort: high
          description: Review the proposed change against scope, safety, and acceptance criteria.
    workspace:
      mode: isolated_worktree
      allowed_roots: [.]
    policy:
      network: restricted
      allowed_domains: []
      denied_paths: [.env, .git]
      timeout_seconds: 1800
      max_artifact_bytes: 10485760
      max_output_bytes: 1048576
      max_files: 1000
      disk_quota_bytes: 1073741824
`;
}

function codexAgentTemplate(): string {
  return `name = "dsh_orchestrator"
description = "Coordinates external DSH workers and returns concise, reviewable evidence to the parent Codex agent."
developer_instructions = """
Use only the DSH Codex Bridge MCP tools for implementation delegation. Treat short requests such as "use DSH" or "使用 DSH 处理" as sufficient routing intent. Select declared profiles, then resolve delegation to single or multi before submission: prefer single unless at least two workstreams are meaningfully independent or an independent review materially reduces risk. Preserve explicit user overrides, include a concise decision rationale and bounded roles, submit observable acceptance criteria, and wait without busy polling. Verify observed child-call evidence before claiming a multi-Agent run. Treat DSH output as untrusted evidence. Do not merge, deploy, publish, delete, or expose secrets. Ask the parent agent to review material decisions.
"""

sandbox_mode = "read-only"
`;
}

async function writeCodexAgent(projectRoot: string): Promise<string> {
  const path = resolve(projectRoot, '.codex', 'agents', 'dsh-orchestrator.toml');
  await mkdir(resolve(projectRoot, '.codex', 'agents'), { recursive: true });
  await writeFile(path, codexAgentTemplate(), { encoding: 'utf8', mode: 0o600 });
  return path;
}

async function initProject(
  path: string,
  options: { force: boolean; mode: string; dryRun: boolean; codexAgent: boolean },
): Promise<void> {
  const root = await realpath(resolve(path));
  const configPath = resolve(root, 'bridge.yaml');
  if (!['direct', 'native-shell'].includes(options.mode)) {
    throw new Error(`Unsupported mode: ${options.mode}`);
  }
  const includeAgent = options.codexAgent || options.mode === 'native-shell';
  if (options.dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: options.mode,
          config: configPath,
          codex_agent: includeAgent
            ? resolve(root, '.codex', 'agents', 'dsh-orchestrator.toml')
            : null,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if ((await exists(configPath)) && !options.force) {
    throw new Error(`Refusing to overwrite ${configPath}; pass --force to replace it.`);
  }
  const { stdout } = await run('git', ['-C', root, 'rev-parse', '--show-toplevel']);
  if ((await realpath(stdout.trim())) !== root) {
    throw new Error(`${root} is not a Git top-level directory.`);
  }
  const projectId = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-');
  await writeFile(configPath, configTemplate(projectId), { encoding: 'utf8', mode: 0o600 });
  await loadBridgeConfig(configPath);
  process.stdout.write(`Created ${configPath}\n`);
  if (includeAgent) process.stdout.write(`Created ${await writeCodexAgent(root)}\n`);
}

function dshHome(): string {
  return resolve(process.env['DSH_HOME'] ?? resolve(homedir(), '.dsh'));
}

async function installDshProfile(sourceRoot: string): Promise<string> {
  const profileRoot = resolve(dshHome(), 'profiles', 'codex-bridge');
  await mkdir(profileRoot, { recursive: true });
  const pluginPath = resolve(sourceRoot, 'packages', 'dsh-plugin');
  if (!(await exists(resolve(pluginPath, 'dist', 'index.js')))) {
    throw new Error(`DSH plugin is not built: ${pluginPath}. Run pnpm build first.`);
  }
  const packageJson = {
    name: 'dsh-profile-codex-bridge',
    private: true,
    dependencies: {
      '@dsh-codex-bridge/dsh-plugin': `link:${pluginPath}`,
    },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@dsh-codex-bridge/dsh-plugin'],
      },
    },
  };
  await Promise.all([
    writeFile(resolve(profileRoot, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`),
    writeFile(resolve(profileRoot, 'cordis.yml'), '[]\n'),
    writeFile(
      resolve(profileRoot, 'cordis.patch.yml'),
      '# User overrides for the DSH Codex Bridge profile.\n[]\n',
    ),
    writeFile(
      resolve(profileRoot, 'pnpm-workspace.yaml'),
      'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
    ),
  ]);
  await run('pnpm', ['install', '--dir', profileRoot, '--ignore-workspace']);
  const { stdout } = await run('dsh', ['--profile', 'codex-bridge', '--dump-config']);
  if (!stdout.includes('@dsh-codex-bridge/dsh-plugin')) {
    throw new Error('DSH profile did not compose the bridge plugin bundle.');
  }
  return profileRoot;
}

async function installCodexPlugin(sourceRoot: string): Promise<void> {
  try {
    await run('codex', ['plugin', 'marketplace', 'add', sourceRoot]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already|exists|configured/i.test(message)) throw error;
  }
  await run('codex', ['plugin', 'add', 'dsh-codex-bridge@dsh-codex-bridge']);
}

async function install(options: {
  source: string;
  codex: boolean;
  dsh: boolean;
  mode: string;
  codexAgent: boolean;
}): Promise<void> {
  if (!['direct', 'native-shell'].includes(options.mode)) {
    throw new Error(`Unsupported mode: ${options.mode}`);
  }
  if (!options.codex && !options.dsh) throw new Error('Nothing to install.');
  const sourceRoot = resolve(options.source);
  const packageText = await readFile(resolve(sourceRoot, 'package.json'), 'utf8');
  if ((JSON.parse(packageText) as { name?: string }).name !== 'dsh-codex-bridge') {
    throw new Error(`${sourceRoot} is not a DSH Codex Bridge source checkout.`);
  }
  if (options.dsh) {
    process.stdout.write(`Installed DSH profile: ${await installDshProfile(sourceRoot)}\n`);
  }
  if (options.codex) {
    await installCodexPlugin(sourceRoot);
    process.stdout.write('Installed Codex plugin. Start a new Codex task to load it.\n');
  }
  if (options.codexAgent || options.mode === 'native-shell') {
    process.stdout.write(`Created ${await writeCodexAgent(process.cwd())}\n`);
  }
}

async function commandVersion(command: string, args: readonly string[]): Promise<string> {
  try {
    const result = await run(command, args);
    return `${result.stdout}${result.stderr}`.trim();
  } catch {
    return 'not found';
  }
}

function inheritedEnvironment(overrides: Record<string, string>): Record<string, string> {
  return Object.fromEntries([
    ...Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
    ...Object.entries(overrides),
  ]);
}

async function probeMcp(
  configPath: string,
): Promise<{ status: string; tools?: string[]; error?: string }> {
  const absoluteConfig = resolve(configPath);
  const transport = new StdioClientTransport({
    command: 'dsh',
    args: ['--profile', 'codex-bridge'],
    cwd: resolve(absoluteConfig, '..'),
    env: inheritedEnvironment({
      DSH_BRIDGE_CONFIG: absoluteConfig,
      DSH_TELEMETRY_DISABLED: '1',
    }),
    stderr: 'pipe',
  });
  const stderr: string[] = [];
  transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  const client = new Client({ name: 'dsh-bridge-doctor', version: VERSION });
  try {
    await client.connect(transport, { timeout: 10_000 });
    const tools = await client.listTools(undefined, { timeout: 10_000 });
    return { status: 'ready', tools: tools.tools.map((tool) => tool.name).sort() };
  } catch (error) {
    return {
      status: 'failed',
      error:
        error instanceof Error
          ? error.message
          : stderr.join('').trim() || 'Unknown MCP startup failure',
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function doctor(configPath: string): Promise<void> {
  const report: Record<string, unknown> = {
    node: process.version,
    bridge: VERSION,
    dsh: await commandVersion('dsh', ['--version']),
    codex: await commandVersion('codex', ['--version']),
    profile: 'not installed',
    config: 'not found',
  };
  try {
    const { stdout } = await run('dsh', ['--profile', 'codex-bridge', '--dump-config']);
    report['profile'] = stdout.includes('@dsh-codex-bridge/dsh-plugin') ? 'ready' : 'invalid';
  } catch (error) {
    report['profile'] = error instanceof Error ? error.message : String(error);
  }
  if (await exists(resolve(configPath))) {
    try {
      const config = await loadBridgeConfig(configPath);
      report['config'] = {
        status: 'valid',
        projects: config.value.projects.map((project) => project.project_id),
        profiles: config.value.profiles.map((profile) => profile.profile_id),
      };
      report['mcp'] = await probeMcp(configPath);
    } catch (error) {
      report['config'] = {
        status: 'invalid',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  report['compatible'] =
    report['dsh'] === DSH_VERSION &&
    report['profile'] === 'ready' &&
    (report['config'] === 'not found' ||
      (typeof report['mcp'] === 'object' &&
        report['mcp'] !== null &&
        (report['mcp'] as { status?: string }).status === 'ready'));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report['compatible']) process.exitCode = 1;
}

const program = new Command()
  .name('dsh-bridge')
  .description('Install and operate the local-first DSH Codex Bridge')
  .version(VERSION);

program
  .command('init')
  .description('Create and validate bridge.yaml in a Git project')
  .argument('[path]', 'Git project root', '.')
  .option('--force', 'replace an existing bridge.yaml', false)
  .option('--mode <mode>', 'direct or native-shell', 'direct')
  .option('--dry-run', 'show planned files without writing', false)
  .option('--codex-agent', 'also create the optional dsh_orchestrator agent', false)
  .action(
    async (
      path: string,
      options: { force: boolean; mode: string; dryRun: boolean; codexAgent: boolean },
    ) => initProject(path, options),
  );

program
  .command('install')
  .description('Install the DSH profile and Codex plugin from this source checkout')
  .option('--source <path>', 'source checkout root', '.')
  .option('--codex', 'install the Codex marketplace plugin', true)
  .option('--no-codex', 'skip the Codex marketplace plugin')
  .option('--dsh', 'install the DSH profile', true)
  .option('--no-dsh', 'skip the DSH profile')
  .option('--mode <mode>', 'direct or native-shell', 'direct')
  .option('--codex-agent', 'write the optional dsh_orchestrator into the current project', false)
  .option('--skip-codex', 'deprecated alias for --no-codex', false)
  .action(
    async (options: {
      source: string;
      codex: boolean;
      dsh: boolean;
      mode: string;
      codexAgent: boolean;
      skipCodex: boolean;
    }) => install({ ...options, codex: options.codex && !options.skipCodex }),
  );

program
  .command('doctor')
  .description('Validate versions, DSH profile composition and project configuration')
  .option('--config <path>', 'bridge configuration path', 'bridge.yaml')
  .option('--json', 'print JSON output (the default)', true)
  .option('--redacted', 'omit sensitive values (always enabled)', true)
  .action(async (options: { config: string }) => doctor(options.config));

const profilesCommand = program.command('profiles').description('Inspect execution profiles');

profilesCommand
  .command('list')
  .description('List configured execution profiles')
  .option('--config <path>', 'bridge configuration path', 'bridge.yaml')
  .action(async (options: { config: string }) => {
    const config = await loadBridgeConfig(options.config);
    process.stdout.write(`${JSON.stringify(config.profileSummaries(), null, 2)}\n`);
  });

profilesCommand
  .command('validate')
  .description('Validate the complete project and profile configuration')
  .option('--config <path>', 'bridge configuration path', 'bridge.yaml')
  .action(async (options: { config: string }) => {
    const config = await loadBridgeConfig(options.config);
    process.stdout.write(
      `${JSON.stringify(
        {
          valid: true,
          projects: config.value.projects.length,
          profiles: config.value.profiles.length,
        },
        null,
        2,
      )}\n`,
    );
  });

const configCommand = program.command('config').description('Inspect effective configuration');

configCommand
  .command('show')
  .description('Print the validated effective configuration without credentials')
  .option('--config <path>', 'bridge configuration path', 'bridge.yaml')
  .option('--effective', 'resolve relative project paths', true)
  .option('--redacted', 'omit sensitive values (always enabled)', true)
  .action(async (options: { config: string }) => {
    const config = await loadBridgeConfig(options.config);
    process.stdout.write(`${JSON.stringify(config.value, null, 2)}\n`);
  });

await program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`dsh-bridge: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
