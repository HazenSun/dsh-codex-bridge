import { spawn, execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const expectedVersion = '0.2.0-rc.2';
const configPath = resolve(
  process.env.DSH_BRIDGE_RUNTIME_CONFIG ??
    resolve(
      process.env.CODEX_HOME ?? resolve(homedir(), '.codex'),
      'dsh-codex-bridge',
      'runtime.json',
    ),
);

async function launch() {
  let saved;
  try {
    saved = JSON.parse(await readFile(configPath, 'utf8'));
    if (
      typeof saved !== 'object' ||
      saved === null ||
      typeof saved.command !== 'string' ||
      typeof saved.dsh_home !== 'string'
    )
      throw new Error('Bridge runtime configuration is invalid; rerun dsh-bridge setup.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const command = process.env.DSH_BRIDGE_DSH_BIN ?? saved?.command ?? 'dsh';
  const env = {
    ...process.env,
    PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
    DSH_HOME: process.env.DSH_HOME ?? saved?.dsh_home ?? resolve(homedir(), '.dsh'),
    DSH_TELEMETRY_DISABLED: '1',
  };
  const { stdout } = await promisify(execFile)(command, ['--version'], { env, timeout: 10_000 });
  if (stdout.trim() !== expectedVersion) {
    throw new Error(
      `Bridge requires DSH ${expectedVersion}. Rerun setup with --dsh-bin <absolute-path>.`,
    );
  }
  const child = spawn(command, ['--profile', 'codex-bridge'], { env, stdio: 'inherit' });
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => child.kill(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  child.once('error', () => {
    process.stderr.write('DSH Bridge could not start its configured runtime. Rerun setup.\n');
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    for (const [name, handler] of handlers) process.removeListener(name, handler);
    process.exitCode = code ?? (signal === 'SIGTERM' || signal === 'SIGINT' ? 0 : 1);
  });
}

await launch().catch((error) => {
  process.stderr.write(`DSH Bridge launcher: ${error.message}\n`);
  process.exitCode = 1;
});
