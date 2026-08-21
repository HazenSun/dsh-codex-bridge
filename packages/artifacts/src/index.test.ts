import { createHash } from 'node:crypto';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ArtifactNotFoundError,
  ArtifactPathError,
  ArtifactRangeError,
  ArtifactStore,
  ArtifactStoreIntegrityError,
  ArtifactTaskIdError,
} from './index.js';
import type { ArtifactSizeLimitError } from './index.js';

const created: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-artifacts-'));
  created.push(root);
  return root;
}

afterEach(async () => {
  for (const root of created.splice(0)) {
    await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }));
  }
});

describe('ArtifactStore', () => {
  it('writes a task manifest and content-addressed object atomically', async () => {
    const root = await fixture();
    const store = new ArtifactStore({ rootDir: root });
    const descriptor = await store.putText(
      'task-001',
      'patch.diff',
      'diff --git a/a b/a\n+changed\n',
    );
    const digest = createHash('sha256').update('diff --git a/a b/a\n+changed\n').digest('hex');
    const manifest = await store.getManifest('task-001');

    expect(descriptor.artifactId).toBe(digest);
    expect(descriptor.sha256).toBe(digest);
    expect(descriptor.path).toBe('patch.diff');
    expect(manifest.total_bytes).toBe(Buffer.byteLength('diff --git a/a b/a\n+changed\n'));
    expect(manifest.artifacts).toHaveLength(1);
    expect(await readFile(join(root, 'tasks', 'task-001', 'objects', digest), 'utf8')).toContain(
      '+changed',
    );
    expect(await readFile(join(root, 'tasks', 'task-001', 'manifest.json'), 'utf8')).toContain(
      'ArtifactManifest',
    );
  });

  it('supports the protocol-shaped root/put/manifest/read API', async () => {
    const root = await fixture();
    const store = new ArtifactStore({ root });
    const reference = await store.put('task-001', {
      kind: 'test_report',
      name: 'tests/results.json',
      mediaType: 'application/json',
      data: '{"passed":true}',
    });
    const manifest = await store.manifest('task-001');
    const page = await store.read('task-001', reference.artifactId, {
      offset: 0,
      limit: 8,
      expectedSha256: reference.sha256,
      encoding: 'utf8',
    });

    expect(reference).toMatchObject({
      kind: 'test_report',
      name: 'tests/results.json',
      path: 'tests/results.json',
      mediaType: 'application/json',
      byteLength: 15,
    });
    expect(manifest.artifacts[0]).toMatchObject({ artifact_id: reference.artifactId });
    expect(page).toMatchObject({ artifactId: reference.artifactId, text: '{"passed', eof: false });
  });

  it('deduplicates bytes while allowing separate logical paths', async () => {
    const root = await fixture();
    const store = new ArtifactStore({ rootDir: root });
    const first = await store.putText('task-001', 'logs/one.log', 'same\n');
    const second = await store.putText('task-001', 'logs/two.log', 'same\n');
    const manifest = await store.getManifest('task-001');

    expect(first.artifactId).toBe(second.artifactId);
    expect(manifest.artifacts.map((artifact) => artifact.name)).toEqual([
      'logs/one.log',
      'logs/two.log',
    ]);
    expect(manifest.total_bytes).toBe(10);
  });

  it('replaces a logical path without retaining stale task bytes', async () => {
    const root = await fixture();
    const store = new ArtifactStore({ rootDir: root });
    await store.putText('task-001', 'result.txt', 'old');
    const next = await store.putText('task-001', 'result.txt', 'newer');
    const manifest = await store.getManifest('task-001');

    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]?.artifact_id).toBe(next.artifactId);
    expect(manifest.total_bytes).toBe(5);
    await expect(store.readText('task-001', 'result.txt')).resolves.toBe('newer');
  });

  it('redacts sensitive JSON, env, and authorization fields before hashing', async () => {
    const root = await fixture();
    const store = new ArtifactStore({ rootDir: root });
    const input = [
      '{"token":"super-secret","nested":{"api_key":"key-value"}}',
      'password = plain-password',
      'Authorization: Bearer abc.def',
      '  Cookie : session=private-cookie',
      '',
      'x-api-key: private-api-key',
    ].join('\n');
    const descriptor = await store.putText('task-001', 'logs/debug.log', input);
    const output = await store.readText('task-001', 'logs/debug.log');

    expect(descriptor.redactionApplied).toBe(true);
    expect(output).not.toContain('super-secret');
    expect(output).not.toContain('key-value');
    expect(output).not.toContain('plain-password');
    expect(output).not.toContain('abc.def');
    expect(output).not.toContain('private-cookie');
    expect(output).not.toContain('private-api-key');
    expect(output.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it('keeps binary data byte-for-byte and does not redact it', async () => {
    const root = await fixture();
    const store = new ArtifactStore({ rootDir: root });
    const input = new Uint8Array([0, 1, 2, 255, 4]);
    const descriptor = await store.put('task-001', 'bundle.bin', input);
    const output = await store.read('task-001', descriptor.artifactId);

    expect(descriptor.redactionApplied).toBe(false);
    expect([...output.bytes]).toEqual([...input]);
  });

  it('supports bounded pagination and explicit exclusive ranges', async () => {
    const root = await fixture();
    const store = new ArtifactStore({ rootDir: root });
    await store.putText('task-001', 'report.txt', '0123456789');

    await expect(
      store.read('task-001', 'report.txt', { offset: 2, limit: 4, encoding: 'utf8' }),
    ).resolves.toMatchObject({
      text: '2345',
      offset: 2,
      end: 6,
      totalBytes: 10,
      eof: false,
    });
    await expect(store.readRange('task-001', 'report.txt', 6, 10)).resolves.toMatchObject({
      offset: 6,
      end: 10,
      eof: true,
    });
    await expect(store.readText('task-001', 'report.txt', { start: 6, end: 10 })).resolves.toBe(
      '6789',
    );
  });

  it('rejects traversal, absolute, malformed, and unknown references', async () => {
    const root = await fixture();
    const store = new ArtifactStore({ rootDir: root });

    await expect(store.putText('../escape', 'x.txt', 'x')).rejects.toBeInstanceOf(
      ArtifactTaskIdError,
    );
    await expect(store.putText('task-001', '../escape', 'x')).rejects.toBeInstanceOf(
      ArtifactPathError,
    );
    await expect(store.putText('task-001', '/tmp/escape', 'x')).rejects.toBeInstanceOf(
      ArtifactPathError,
    );
    await expect(store.putText('task-001', 'a\\b', 'x')).rejects.toBeInstanceOf(ArtifactPathError);
    await expect(store.readText('task-001', '../manifest.json')).rejects.toBeInstanceOf(
      ArtifactPathError,
    );
    await expect(store.readText('task-001', 'missing.txt')).rejects.toBeInstanceOf(
      ArtifactNotFoundError,
    );
  });

  it('enforces per-artifact and per-task size limits', async () => {
    const root = await fixture();
    const store = new ArtifactStore({ rootDir: root, maxArtifactBytes: 4, maxTaskBytes: 6 });

    await expect(store.putText('task-001', 'too-big.txt', '12345')).rejects.toMatchObject({
      code: 'ARTIFACT_SIZE_LIMIT',
    } satisfies Partial<ArtifactSizeLimitError>);
    await store.putText('task-001', 'one.txt', '1234');
    await expect(store.putText('task-001', 'two.txt', '567')).rejects.toMatchObject({
      code: 'TASK_SIZE_LIMIT',
    } satisfies Partial<ArtifactSizeLimitError>);
  });

  it('serializes concurrent writes for one task and preserves a valid manifest', async () => {
    const root = await fixture();
    const store = new ArtifactStore({ rootDir: root });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.putText('task-001', `logs/${index}.log`, `line-${index}\n`),
      ),
    );
    const manifest = await store.getManifest('task-001');

    expect(manifest.artifacts).toHaveLength(12);
    expect(manifest.artifacts.every((artifact) => artifact.task_id === 'task-001')).toBe(true);
    expect(manifest.total_bytes).toBeGreaterThan(0);
  });

  it('rejects symlinked task storage directories', async () => {
    const root = await fixture();
    const outside = await fixture();
    const store = new ArtifactStore({ rootDir: root });
    await store.putText('safe-task', 'ok.txt', 'safe');
    await store.removeTask('safe-task');
    await symlink(outside, join(root, 'tasks', 'unsafe-task'));

    await expect(store.putText('unsafe-task', 'x.txt', 'nope')).rejects.toBeInstanceOf(
      ArtifactStoreIntegrityError,
    );
  });

  it('detects tampering with a content-addressed object', async () => {
    const root = await fixture();
    const store = new ArtifactStore({ rootDir: root });
    const descriptor = await store.putText('task-001', 'result.txt', 'original');
    await writeFile(join(root, 'tasks', 'task-001', 'objects', descriptor.artifactId), 'tampered');

    await expect(store.readText('task-001', 'result.txt')).rejects.toBeInstanceOf(
      ArtifactStoreIntegrityError,
    );
  });

  it('rejects invalid ranges and supports task deletion', async () => {
    const root = await fixture();
    const store = new ArtifactStore({ rootDir: root });
    await store.putText('task-001', 'result.txt', '1234');

    await expect(store.read('task-001', 'result.txt', { offset: 5 })).rejects.toBeInstanceOf(
      ArtifactRangeError,
    );
    await expect(store.read('task-001', 'result.txt', { start: 1, end: 5 })).rejects.toBeInstanceOf(
      ArtifactRangeError,
    );
    await store.removeTask('task-001');
    await expect(store.getManifest('task-001')).resolves.toMatchObject({
      artifacts: [],
      total_bytes: 0,
    });
  });
});
