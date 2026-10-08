import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export const execFileAsync = promisify(execFile);
export const BRIDGE_VERSION = '0.1.0-alpha.3';
export const DSH_VERSION = '0.2.0-rc.2';
export const PROTOCOL_VERSION = 'bridge.dsh.dev/v1alpha1';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function environment(overrides = {}, base = process.env) {
  return Object.fromEntries([
    ...Object.entries(base).filter((entry) => typeof entry[1] === 'string'),
    ...Object.entries(overrides),
  ]);
}

export function structured(result) {
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (result.isError === true) throw new Error(`MCP tool failed: ${text ?? 'no error text'}`);
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (typeof text !== 'string') throw new Error('MCP result contained no structured content');
  return JSON.parse(text);
}

export function requestedRoutes(env = process.env) {
  function route(prefix, defaults) {
    const value = {
      provider: env[`${prefix}_PROVIDER`] ?? defaults.provider,
      model: env[`${prefix}_MODEL`] ?? defaults.model,
      reasoning_effort: env[`${prefix}_EFFORT`] ?? 'high',
    };
    for (const [field, text] of Object.entries(value)) {
      if (typeof text !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(text)) {
        throw new Error(`Invalid explicit E2E ${field}: ${JSON.stringify(text)}`);
      }
    }
    return value;
  }
  return {
    primary: route('DSH_BRIDGE_E2E', { provider: 'deepseek-official', model: 'deepseek-flash' }),
    second: route('DSH_BRIDGE_E2E_SECOND', { provider: 'moonshotai-cn', model: 'kimi-k2.7-code' }),
  };
}

export async function evidenceDirectory(prefix, env = process.env) {
  const directory =
    env.DSH_BRIDGE_EVIDENCE_DIR === undefined
      ? await mkdtemp(join(tmpdir(), `${prefix}-evidence-`))
      : resolve(env.DSH_BRIDGE_EVIDENCE_DIR);
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function writeEvidence(directory, name, value) {
  if (name !== name.split(/[\\/]/).at(-1)) throw new Error('Evidence name must be a filename');
  const path = join(directory, name);
  // A repeated run must never replace a previous receipt, including tracked historical evidence.
  await writeFile(path, value, { flag: 'wx', mode: 0o600 });
  return path;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function executable(command, env) {
  const candidates =
    isAbsolute(command) || command.includes(sep)
      ? [resolve(command)]
      : (env.PATH ?? '').split(delimiter).map((directory) => resolve(directory || '.', command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    }
  }
  throw new Error(`DSH executable was not found: ${command}`);
}

export async function readRuntime(env = process.env) {
  const requestedCommand = env.DSH_BRIDGE_DSH_BIN ?? 'dsh';
  const command = await executable(requestedCommand, env);
  const { stdout } = await execFileAsync(command, ['--version'], {
    env: environment({}, env),
    encoding: 'utf8',
    timeout: 15_000,
  });
  const version = stdout.trim();
  if (version !== DSH_VERSION) throw new Error(`Expected DSH ${DSH_VERSION}, observed ${version}`);
  const bridge = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (bridge.version !== BRIDGE_VERSION)
    throw new Error(`Expected Bridge ${BRIDGE_VERSION}, observed ${bridge.version}`);
  return {
    requested_command: requestedCommand,
    command,
    executable_sha256: sha256(await readFile(command)),
    dsh_version: version,
    bridge_version: bridge.version,
  };
}

export async function verifyConnection(client, runtime, env = process.env) {
  const current = await readRuntime({ ...env, DSH_BRIDGE_DSH_BIN: runtime.command });
  if (current.executable_sha256 !== runtime.executable_sha256)
    throw new Error('DSH executable changed during E2E');
  const server = client.getServerVersion();
  if (server?.name !== 'dsh-codex-bridge' || server.version !== BRIDGE_VERSION) {
    throw new Error(`Unexpected live MCP server: ${JSON.stringify(server)}`);
  }
  return server;
}

export function confirmRoutes(catalog, routes) {
  return Object.fromEntries(
    Object.entries(routes).map(([label, route]) => {
      const provider = catalog.providers?.find(
        (candidate) => candidate.provider === route.provider,
      );
      const model = provider?.models.find((candidate) => candidate.model === route.model);
      if (provider?.configured !== true || model === undefined) {
        throw new Error(
          `Required ${label} route is not configured/discovered: ${route.provider}/${route.model}`,
        );
      }
      if (!model.reasoning_efforts?.includes(route.reasoning_effort)) {
        throw new Error(
          `Required ${label} reasoning effort was not confirmed: ${route.provider}/${route.model}/${route.reasoning_effort}`,
        );
      }
      return [label, { ...route, confirmed: true, reasoning_efforts: model.reasoning_efforts }];
    }),
  );
}

export async function discoverRoutes(client, routes) {
  const catalog = structured(
    await client.callTool(
      {
        name: 'discover_dsh_models',
        arguments: { protocol_version: PROTOCOL_VERSION, include_details: true },
      },
      undefined,
      { timeout: 60_000 },
    ),
  );
  return confirmRoutes(catalog, routes);
}

export function routeMatches(actual, expected) {
  return (
    actual?.provider === expected.provider &&
    actual?.model === expected.model &&
    actual?.reasoningEffort === expected.reasoning_effort
  );
}

export function parseV4Session(source, sessionId, catalog) {
  const records = source
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const header = records[0];
  if (header?.type !== 'session' || header.version !== 4 || header.id !== sessionId) {
    throw new Error(`Expected exact Session V4 header for ${sessionId}`);
  }
  if (catalog.currentVersion !== 4)
    throw new Error('The selected runtime has no Session V4 decoder');
  const restore = catalog.createRestore(header, { recovery: 'strict', validation: 'current' });
  for (const record of records.slice(1)) restore.decodeRow(record);
  const decoded = restore.finish();
  if (decoded.header.id !== sessionId || decoded.header.version !== 4)
    throw new Error('Session decoder returned a different identity/format');
  return decoded;
}

export function summarizeSession(events, fromSeq = 0, toSeqExclusive = events.length) {
  const interval = events.filter((event) => event.seq >= fromSeq && event.seq < toSeqExclusive);
  const routes = interval
    .filter((event) => event.type === 'request/header')
    .map((event) => event.data.header.config);
  const calls = interval.filter(
    (event) => event.type === 'tool/call' && /^subagent(?:_|$)/.test(event.data.name),
  );
  const results = interval.filter((event) => event.type === 'tool/result');
  const children = calls.map((event) => {
    const args = JSON.parse(event.data.arguments);
    const result = results.find((result) => result.data.message.toolCallId === event.data.callId);
    return {
      call_id: event.data.callId,
      tool_name: event.data.name,
      foreground_requested: args.run_in_background === false,
      completed:
        result !== undefined &&
        result.data.message.isError !== true &&
        result.data.error === undefined,
      output: result?.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join(''),
    };
  });
  return {
    first_event_seq: fromSeq,
    last_event_seq: toSeqExclusive,
    route: routes.at(-1),
    routes,
    subagent_calls: calls.length,
    children,
  };
}

export async function savedSession(runtime, sessionId, fromSeq = 0, env = process.env) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sessionId))
    throw new Error('Invalid saved session identity');
  const sessionsRoot = resolve(env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions');
  const projects = await readdir(sessionsRoot, { withFileTypes: true });
  const matches = [];
  for (const project of projects.filter((entry) => entry.isDirectory())) {
    for (const filename of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
      const candidate = join(sessionsRoot, project.name, sessionId, filename);
      try {
        if ((await lstat(candidate)).isFile()) matches.push(candidate);
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      }
    }
  }
  if (matches.length !== 1)
    throw new Error(`Expected one saved V4 log for ${sessionId}, found ${matches.length}`);
  const path = matches[0];
  const source = path.endsWith('.zstd')
    ? (
        await execFileAsync('zstd', ['-dc', path], {
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          timeout: 15_000,
        })
      ).stdout
    : await readFile(path, 'utf8');
  // Resolve the public decoder from the exact selected DSH installation, never a different global version.
  const require = createRequire(runtime.command);
  const metadata = require('@deepseek-ai/dsh-session-format-catalog/package.json');
  if (metadata.version !== runtime.dsh_version)
    throw new Error('Session decoder and selected DSH versions differ');
  const { sessionFormatCatalog } = await import(
    pathToFileURL(require.resolve('@deepseek-ai/dsh-session-format-catalog')).href
  );
  const decoded = parseV4Session(source, sessionId, sessionFormatCatalog);
  return {
    path,
    source_sha256: sha256(source),
    header: decoded.header,
    events: decoded.events,
    ...summarizeSession(decoded.events, fromSeq),
  };
}

export async function readPatch(client, result) {
  const artifact = result.artifacts.artifacts.find((entry) => entry.kind === 'patch');
  if (artifact === undefined) throw new Error('Result has no patch artifact');
  if (artifact.bytes > 1_048_576) throw new Error('E2E patch exceeds its bounded artifact limit');
  const output = structured(
    await client.callTool({
      name: 'read_task_artifact',
      arguments: {
        protocol_version: PROTOCOL_VERSION,
        task_id: result.task_id,
        artifact_id: artifact.artifact_id,
        offset: 0,
        limit: Math.max(1, artifact.bytes),
        expected_sha256: artifact.sha256,
      },
    }),
  );
  if (sha256(output.data) !== artifact.sha256 || Buffer.byteLength(output.data) !== artifact.bytes)
    throw new Error('Patch hash/size readback differs from its manifest');
  return { artifact, patch: output.data, hash_verified: true };
}

export async function worktreeProof(record, fixture, filename, expected) {
  if (record.workspace?.path === undefined) throw new Error('Task has no isolated worktree record');
  const [worktreePath, projectRoot, fixtureRoot] = await Promise.all([
    realpath(record.workspace.path),
    realpath(record.workspace.projectRoot),
    realpath(fixture),
  ]);
  const content = await readFile(join(worktreePath, filename));
  return {
    isolated: worktreePath !== fixtureRoot && projectRoot === fixtureRoot,
    base_sha: record.workspace.baseSha,
    exact_bytes: content.equals(Buffer.from(expected, 'utf8')),
    content_sha256: sha256(content),
  };
}

export async function waitTerminal(client, taskId) {
  for (let attempt = 0; attempt < 36; attempt += 1) {
    const { task } = structured(
      await client.callTool(
        {
          name: 'wait_task',
          arguments: { protocol_version: PROTOCOL_VERSION, task_id: taskId, timeout_seconds: 10 },
        },
        undefined,
        { timeout: 20_000 },
      ),
    );
    if (
      ['completed', 'partial', 'cancelled', 'timed_out', 'interrupted', 'failed'].includes(
        task.status,
      )
    )
      return task;
  }
  throw new Error(`Task ${taskId} did not become terminal`);
}
