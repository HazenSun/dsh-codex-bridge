import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, URL } from 'node:url';

const launcher = fileURLToPath(
  new URL('../plugins/dsh-codex-bridge/scripts/launch-dsh.mjs', import.meta.url),
);

async function runLauncher(env) {
  const child = spawn(process.execPath, [launcher], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.stdout.on('data', (chunk) => (stdout += chunk));
  const timer = setTimeout(() => child.kill('SIGTERM'), 10_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    return { code, stderr, stdout };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
}

test('packaged launcher uses the selected Codex Home without shell DSH exports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-launcher-'));
  try {
    const binary = join(root, 'dsh-fake');
    const config = join(root, 'dsh-codex-bridge', 'runtime.json');
    const observed = join(root, 'launch.json');
    await writeFile(
      binary,
      `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) console.log('0.2.0-rc.2');
else fs.writeFileSync(process.env.DSH_LAUNCH_OBSERVED, JSON.stringify({args:process.argv.slice(2),home:process.env.DSH_HOME}));
`,
      { mode: 0o700 },
    );
    await mkdir(join(root, 'dsh-codex-bridge'));
    await writeFile(config, JSON.stringify({ command: binary, dsh_home: join(root, 'selected') }));
    const env = {
      ...process.env,
      CODEX_HOME: root,
      DSH_LAUNCH_OBSERVED: observed,
    };
    delete env.DSH_HOME;
    delete env.DSH_BRIDGE_DSH_BIN;
    delete env.DSH_BRIDGE_RUNTIME_CONFIG;
    const result = await runLauncher(env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '', 'launcher must not contaminate STDIO MCP with diagnostics');
    assert.deepEqual(JSON.parse(await readFile(observed, 'utf8')), {
      args: ['--profile', 'codex-bridge'],
      home: join(root, 'selected'),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packaged launcher rejects an unsupported runtime before starting its Profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-launcher-'));
  try {
    const binary = join(root, 'dsh-fake');
    const config = join(root, 'runtime.json');
    await writeFile(binary, '#!/usr/bin/env node\nconsole.log("0.1.6-alpha.1");\n', {
      mode: 0o700,
    });
    await writeFile(config, JSON.stringify({ command: binary, dsh_home: root }));
    const env = { ...process.env, DSH_BRIDGE_RUNTIME_CONFIG: config };
    delete env.DSH_HOME;
    delete env.DSH_BRIDGE_DSH_BIN;
    const result = await runLauncher(env);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /requires DSH 0\.2\.0-rc\.2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
