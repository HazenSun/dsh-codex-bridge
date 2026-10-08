import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));

describe('persisted DSH launch selection', () => {
  it('binary overrides preserve the saved Home, while an explicit Home wins independently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-launch-contract-'));
    try {
      const savedHome = join(root, 'saved-home');
      const overrideHome = join(root, 'override-home');
      const binary = join(root, 'dsh-fake');
      const callsPath = join(root, 'calls.jsonl');
      await writeFile(
        binary,
        `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.DSH_TEST_CALLS, JSON.stringify({home:process.env.DSH_HOME,args:process.argv.slice(2)})+'\\n');
console.log(process.argv.includes('--version') ? '0.1.6-alpha.1' : '@dsh-codex-bridge/dsh-plugin');
`,
        { mode: 0o700 },
      );
      const config = join(root, 'runtime.json');
      await writeFile(
        config,
        JSON.stringify({ command: '/must-not-be-used', dsh_home: savedHome }),
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        DSH_BRIDGE_RUNTIME_CONFIG: config,
        DSH_BRIDGE_DSH_BIN: binary,
        DSH_TEST_CALLS: callsPath,
      };
      delete env['DSH_HOME'];
      for (const home of [undefined, overrideHome]) {
        const result = await execFileAsync(
          process.execPath,
          [cli, 'doctor', '--config', join(root, 'missing.yaml')],
          {
            env: { ...env, ...(home === undefined ? {} : { DSH_HOME: home }) },
            encoding: 'utf8',
          },
        ).catch((error: unknown) => {
          if (
            typeof error === 'object' &&
            error !== null &&
            'stdout' in error &&
            typeof error.stdout === 'string'
          ) {
            return { stdout: error.stdout };
          }
          throw error;
        });
        const report: unknown = JSON.parse(result.stdout);
        expect(report).toMatchObject({
          compatible: false,
          dsh_command: binary,
          expected_dsh: '0.2.0-rc.2',
        });
      }
      const calls: Array<{ home: string; args: string[] }> = (await readFile(callsPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { home: string; args: string[] });
      const compositionCalls = calls.filter((call) => call.args.includes('--dump-config'));
      expect(compositionCalls.map((call) => call.home)).toEqual([savedHome, overrideHome]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an unsupported runtime before installing a DSH Profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-install-contract-'));
    try {
      const binary = join(root, 'dsh-fake');
      const dshHome = join(root, 'dsh-home');
      await mkdir(dshHome);
      await writeFile(binary, '#!/usr/bin/env node\nconsole.log("0.1.6-alpha.1");\n', {
        mode: 0o700,
      });
      await expect(
        execFileAsync(
          process.execPath,
          [
            cli,
            'install',
            '--source',
            fileURLToPath(new URL('../../../', import.meta.url)),
            '--no-codex',
            '--dsh-bin',
            binary,
          ],
          {
            env: {
              ...process.env,
              DSH_HOME: dshHome,
              DSH_BRIDGE_RUNTIME_CONFIG: join(root, 'none.json'),
            },
            encoding: 'utf8',
          },
        ),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('requires 0.2.0-rc.2') as unknown,
      });
      await expect(
        readFile(join(dshHome, 'profiles/codex-bridge/package.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses an unmanaged Codex MCP server before changing the saved runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-install-contract-'));
    try {
      const binary = join(root, 'codex');
      await writeFile(
        binary,
        '#!/usr/bin/env node\nconsole.log(JSON.stringify({transport:{type:"streamable_http",url:"https://example.test/mcp"}}));\n',
        { mode: 0o700 },
      );
      const config = join(root, 'runtime.json');
      const baseline = JSON.stringify({ command: '/existing/dsh', dsh_home: '/existing/home' });
      await writeFile(config, baseline);
      await expect(
        execFileAsync(
          process.execPath,
          [
            cli,
            'install',
            '--source',
            fileURLToPath(new URL('../../../', import.meta.url)),
            '--no-dsh',
          ],
          {
            env: {
              ...process.env,
              PATH: [root, process.env['PATH'] ?? ''].join(delimiter),
              DSH_BRIDGE_RUNTIME_CONFIG: config,
            },
            encoding: 'utf8',
          },
        ),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('Refusing to replace an unmanaged MCP') as unknown,
      });
      expect(await readFile(config, 'utf8')).toBe(baseline);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
