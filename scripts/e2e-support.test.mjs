import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  confirmRoutes,
  evidenceDirectory,
  parseV4Session,
  readPatch,
  requestedRoutes,
  routeMatches,
  sha256,
  structured,
  summarizeSession,
  worktreeProof,
  writeEvidence,
} from './e2e-support.mjs';

test('E2E routes retain the exact requested efforts and both configurable model identities', () => {
  assert.deepEqual(requestedRoutes({}), {
    primary: { provider: 'deepseek-official', model: 'deepseek-flash', reasoning_effort: 'high' },
    second: { provider: 'moonshotai-cn', model: 'kimi-k2.7-code', reasoning_effort: 'high' },
  });
  const routes = requestedRoutes({
    DSH_BRIDGE_E2E_MODEL: 'deepseek-v4-flash',
    DSH_BRIDGE_E2E_EFFORT: 'xhigh',
    DSH_BRIDGE_E2E_SECOND_PROVIDER: 'deepseek-official',
    DSH_BRIDGE_E2E_SECOND_MODEL: 'deepseek-v4-pro',
    DSH_BRIDGE_E2E_SECOND_EFFORT: 'high',
  });
  assert.equal(routes.primary.reasoning_effort, 'xhigh');
  assert.equal(routes.second.provider, 'deepseek-official');
  assert.equal(routes.second.model, 'deepseek-v4-pro');
  assert.throws(() => requestedRoutes({ DSH_BRIDGE_E2E_EFFORT: '' }), /Invalid explicit/);
  assert.throws(
    () => requestedRoutes({ DSH_BRIDGE_E2E_MODEL: 'valid\nprovider: invalid' }),
    /Invalid explicit/,
  );
});

test('discovery requires configured exact models and explicitly advertised efforts without fallback', () => {
  const routes = requestedRoutes({
    DSH_BRIDGE_E2E_SECOND_PROVIDER: 'deepseek-official',
    DSH_BRIDGE_E2E_SECOND_MODEL: 'deepseek-v4-pro',
  });
  const provider = {
    provider: 'deepseek-official',
    configured: true,
    models: [
      { model: 'deepseek-flash', reasoning_efforts: ['high'] },
      { model: 'deepseek-v4-pro', reasoning_efforts: ['high'] },
    ],
  };
  const confirmed = confirmRoutes({ providers: [provider] }, routes);
  assert.equal(confirmed.primary.confirmed, true);
  assert.equal(confirmed.second.model, 'deepseek-v4-pro');
  assert.throws(
    () => confirmRoutes({ providers: [{ ...provider, configured: false }] }, routes),
    /not configured/,
  );
  assert.throws(
    () => confirmRoutes({ providers: [{ ...provider, models: [provider.models[0]] }] }, routes),
    /second route/,
  );
  assert.throws(
    () =>
      confirmRoutes(
        {
          providers: [
            {
              ...provider,
              models: provider.models.map((model) => ({ ...model, reasoning_efforts: ['low'] })),
            },
          ],
        },
        routes,
      ),
    /reasoning effort was not confirmed/,
  );
  assert.equal(
    routeMatches(
      { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' },
      routes.primary,
    ),
    false,
  );
});

test('Session V4 decode verifies identity/version and drives the selected public decoder', () => {
  const header = { type: 'session', version: 4, id: 'bridge-fixture' };
  const events = [{ type: 'turn/start', seq: 0, data: { turn: 1 } }];
  const calls = [];
  const catalog = {
    currentVersion: 4,
    createRestore(actualHeader, options) {
      assert.deepEqual(actualHeader, header);
      assert.deepEqual(options, { recovery: 'strict', validation: 'current' });
      return {
        decodeRow(row) {
          calls.push(row);
        },
        finish() {
          return { header, events };
        },
      };
    },
  };
  const source = [header, ...events].map((record) => JSON.stringify(record)).join('\n');
  assert.deepEqual(parseV4Session(source, 'bridge-fixture', catalog).events, events);
  assert.deepEqual(calls, events);
  assert.throws(() => parseV4Session(source, 'other-session', catalog), /exact Session V4 header/);
  assert.throws(
    () => parseV4Session(source.replace('"version":4', '"version":3'), 'bridge-fixture', catalog),
    /exact Session V4 header/,
  );
  assert.throws(
    () => parseV4Session(source, 'bridge-fixture', { ...catalog, currentVersion: 3 }),
    /no Session V4 decoder/,
  );
});

test('foreground child evidence uses V4 message identities and stays inside the run interval', () => {
  const route = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' };
  const events = [
    {
      seq: 0,
      type: 'tool/call',
      data: { callId: 'old', name: 'subagent', arguments: '{"run_in_background":false}' },
    },
    { seq: 1, type: 'request/header', data: { header: { config: route } } },
    {
      seq: 2,
      type: 'tool/call',
      data: { callId: 'one', name: 'subagent', arguments: '{"run_in_background":false}' },
    },
    {
      seq: 3,
      type: 'tool/result',
      data: {
        message: { toolCallId: 'one', isError: false, content: [{ type: 'text', text: 'ALPHA+' }] },
      },
    },
    {
      seq: 4,
      type: 'tool/call',
      data: { callId: 'two', name: 'subagent_fork', arguments: '{"run_in_background":false}' },
    },
    {
      seq: 5,
      type: 'tool/result',
      data: { message: { toolCallId: 'two', isError: true, content: [] } },
    },
    {
      seq: 6,
      type: 'tool/call',
      data: { callId: 'later', name: 'subagent', arguments: '{"run_in_background":true}' },
    },
  ];
  const summary = summarizeSession(events, 1, 6);
  assert.deepEqual(summary.route, route);
  assert.equal(summary.subagent_calls, 2);
  assert.deepEqual(
    summary.children.map((child) => [child.foreground_requested, child.completed, child.output]),
    [
      [true, true, 'ALPHA+'],
      [true, false, ''],
    ],
  );
  assert.equal(summarizeSession(events, 6).children[0].foreground_requested, false);
  assert.equal(summarizeSession(events, 6).children[0].completed, false);
});

test('MCP error results fail before any structured success data can be consumed', () => {
  assert.deepEqual(structured({ structuredContent: { ok: true } }), { ok: true });
  assert.throws(
    () =>
      structured({
        isError: true,
        structuredContent: { ok: true },
        content: [{ type: 'text', text: 'rejected' }],
      }),
    /MCP tool failed: rejected/,
  );
});

test('patch readback verifies both manifest digest and the actual byte size', async () => {
  const patch = 'diff --git a/proof.txt b/proof.txt\n+PROOF\n';
  const artifact = {
    kind: 'patch',
    artifact_id: 'patch-one',
    bytes: Buffer.byteLength(patch),
    sha256: sha256(patch),
  };
  const result = { task_id: 'task-one', artifacts: { artifacts: [artifact] } };
  const client = {
    async callTool() {
      return { structuredContent: { data: patch } };
    },
  };
  assert.equal((await readPatch(client, result)).hash_verified, true);
  await assert.rejects(
    readPatch(client, {
      ...result,
      artifacts: { artifacts: [{ ...artifact, bytes: artifact.bytes + 1 }] },
    }),
    /hash\/size/,
  );
  await assert.rejects(
    readPatch(
      {
        async callTool() {
          return { structuredContent: { data: 'different' } };
        },
      },
      result,
    ),
    /hash\/size/,
  );
});

test('worktree proof canonicalizes path aliases while retaining strict isolation and byte checks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-e2e-worktree-alias-'));
  const project = join(directory, 'project');
  const worktree = join(directory, 'worktree');
  const alias = join(directory, 'project-alias');
  try {
    await mkdir(project);
    await mkdir(worktree);
    await symlink(project, alias, 'dir');
    await writeFile(join(worktree, 'proof.txt'), 'PROOF\n');
    const record = {
      workspace: { path: worktree, projectRoot: await realpath(project), baseSha: 'a'.repeat(40) },
    };
    const proof = await worktreeProof(record, alias, 'proof.txt', 'PROOF\n');
    assert.equal(proof.isolated, true);
    assert.equal(proof.exact_bytes, true);
    assert.equal(proof.content_sha256, sha256(Buffer.from('PROOF\n')));

    await writeFile(join(project, 'proof.txt'), 'PROOF\n');
    const sourceAlias = await worktreeProof(
      { workspace: { ...record.workspace, path: alias } },
      project,
      'proof.txt',
      'PROOF\n',
    );
    assert.equal(sourceAlias.isolated, false);

    await writeFile(join(worktree, 'proof.txt'), 'PROOF');
    const missingNewline = await worktreeProof(record, alias, 'proof.txt', 'PROOF\n');
    assert.equal(missingNewline.exact_bytes, false);
    assert.equal(missingNewline.content_sha256, sha256(Buffer.from('PROOF')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('receipts default outside the repository and refuse to replace prior evidence', async () => {
  const directory = await evidenceDirectory('dsh-e2e-support-test', {});
  const override = await mkdtemp(join(tmpdir(), 'dsh-e2e-support-override-'));
  try {
    assert.equal(dirname(directory), tmpdir());
    assert.equal(
      await evidenceDirectory('unused', { DSH_BRIDGE_EVIDENCE_DIR: override }),
      override,
    );
    const path = await writeEvidence(directory, 'receipt.json', 'first\n');
    await assert.rejects(writeEvidence(directory, 'receipt.json', 'replacement\n'), {
      code: 'EEXIST',
    });
    assert.equal(await readFile(path, 'utf8'), 'first\n');
    await assert.rejects(
      writeEvidence(directory, '../receipt.json', 'invalid'),
      /must be a filename/,
    );
    assert.equal(sha256('first\n'), sha256(await readFile(path)));
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(override, { recursive: true, force: true });
  }
});
