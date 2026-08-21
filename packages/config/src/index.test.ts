import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROTOCOL_VERSION } from '@dsh-codex-bridge/protocol';
import { stringify as stringifyYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  BridgeConfigSchema,
  ConfigRegistry,
  ConfigRevisionConflictError,
  SensitiveConfigFieldError,
  applyProfileChange,
  calculateConfigRevision,
  listConfigBackups,
  loadBridgeConfig,
  previewProfileChange,
  readConfigSnapshot,
  redactSensitiveText,
  rollbackConfig,
} from './index.js';

const profile = {
  protocol_version: PROTOCOL_VERSION,
  profile_id: 'builder',
  description: 'Build and verify code.',
  dsh: {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoning_effort: 'high',
    agent_preset: 'standard',
    max_tokens: 32_000,
  },
  delegation: { max_depth: 2, max_children: 3, roles: {} },
  workspace: { mode: 'isolated_worktree' as const, allowed_roots: ['.'] },
  policy: {
    network: 'restricted' as const,
    allowed_domains: [],
    denied_paths: ['.env'],
    timeout_seconds: 1_800,
    max_artifact_bytes: 10_485_760,
    max_output_bytes: 1_048_576,
    max_files: 1_000,
    disk_quota_bytes: 1_073_741_824,
  },
};

const secondProfile = {
  ...profile,
  profile_id: 'reviewer',
  description: 'Review and verify code.',
};

const editableConfig = BridgeConfigSchema.parse({
  protocol_version: PROTOCOL_VERSION,
  data_root: '.bridge',
  projects: [{ project_id: 'sample', root: '.', default_profile: 'builder' }],
  profiles: [profile, secondProfile],
});

async function writeEditableConfig(root: string, config = editableConfig): Promise<string> {
  const path = join(root, 'bridge.yaml');
  await writeFile(path, stringifyYaml(config), { mode: 0o600 });
  return path;
}

describe('BridgeConfig', () => {
  it('rejects an unknown default profile', () => {
    expect(() =>
      BridgeConfigSchema.parse({
        protocol_version: PROTOCOL_VERSION,
        data_root: '.bridge',
        projects: [{ project_id: 'sample', root: '.', default_profile: 'missing' }],
        profiles: [profile],
      }),
    ).toThrow(/unknown profile/);
  });

  it('loads YAML and resolves project and allowed-root paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-config-'));
    await mkdir(join(root, 'project'));
    await writeFile(
      join(root, 'bridge.yaml'),
      [
        `protocol_version: ${PROTOCOL_VERSION}`,
        'data_root: .bridge',
        'projects:',
        '  - project_id: sample',
        '    root: project',
        '    default_profile: builder',
        'profiles:',
        '  - protocol_version: bridge.dsh.dev/v1alpha1',
        '    profile_id: builder',
        '    description: Build and verify code.',
        '    dsh:',
        '      provider: deepseek-official',
        '      model: deepseek-v4-flash',
        '      reasoning_effort: high',
        '      agent_preset: standard',
        '      max_tokens: 32000',
        '    delegation: { max_depth: 2, max_children: 3, roles: {} }',
        '    workspace:',
        '      mode: isolated_worktree',
        '      allowed_roots: [project]',
        '    policy:',
        '      network: restricted',
        '      allowed_domains: []',
        '      denied_paths: [.env]',
        '      timeout_seconds: 1800',
        '      max_artifact_bytes: 10485760',
        '      max_output_bytes: 1048576',
        '      max_files: 1000',
        '      disk_quota_bytes: 1073741824',
      ].join('\n'),
    );

    const registry = await loadBridgeConfig(join(root, 'bridge.yaml'));
    const canonicalProject = await realpath(join(root, 'project'));
    expect(registry.project('sample').root).toBe(canonicalProject);
    expect(registry.profile('builder').workspace.allowed_roots).toEqual([canonicalProject]);
    expect(registry.profileSummaries()[0]?.delegation).toEqual({
      max_depth: 2,
      max_children: 3,
      roles: [],
    });
    expect(registry).toBeInstanceOf(ConfigRegistry);
  });
});

describe('configuration control plane', () => {
  it('computes a stable SHA-256 revision and previews without writing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-control-'));
    const configPath = await writeEditableConfig(root);
    const beforeBytes = await readFile(configPath);
    const snapshot = await readConfigSnapshot(configPath);
    const preview = previewProfileChange(snapshot.config, {
      operation: 'update',
      profile_id: 'builder',
      changes: { dsh: { model: 'deepseek-v4-pro' } },
    });

    expect(snapshot.revision).toBe(calculateConfigRevision(beforeBytes));
    expect(preview.changed).toBe(true);
    expect(
      preview.after.profiles.find((candidate) => candidate.profile_id === 'builder')?.dsh.model,
    ).toBe('deepseek-v4-pro');
    expect(preview.diff_text).toContain('deepseek-v4-pro');
    expect(await readFile(configPath)).toEqual(beforeBytes);
    expect(snapshot.config.profiles[0]?.dsh.model).toBe('deepseek-v4-flash');
  });

  it('applies a revision-guarded change atomically with a 0600 file and bounded backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-control-'));
    const configPath = await writeEditableConfig(root);
    const initial = await readConfigSnapshot(configPath);
    const result = await applyProfileChange(
      configPath,
      {
        operation: 'update',
        profile_id: 'builder',
        changes: { dsh: { model: 'deepseek-v4-pro' } },
      },
      { expectedRevision: initial.revision, maxBackups: 2 },
    );
    const updated = await readConfigSnapshot(configPath);
    const fileMode = (await stat(configPath)).mode & 0o777;
    const backups = await listConfigBackups(configPath);

    expect(result.previous_revision).toBe(initial.revision);
    expect(updated.revision).toBe(result.revision);
    expect(updated.revision).not.toBe(initial.revision);
    expect(fileMode).toBe(0o600);
    expect(backups).toHaveLength(1);
    expect(await readFile(backups[0] as string, 'utf8')).toBe(initial.raw);
    expect(
      updated.config.profiles.find((candidate) => candidate.profile_id === 'builder')?.dsh.model,
    ).toBe('deepseek-v4-pro');
  });

  it('retains source comments while changing only the requested YAML nodes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-control-'));
    const configPath = join(root, 'bridge.yaml');
    const source = `# Keep this operator note.\n${stringifyYaml(editableConfig)}`;
    await writeFile(configPath, source, { mode: 0o600 });
    const initial = await readConfigSnapshot(configPath);

    await applyProfileChange(
      configPath,
      {
        operation: 'update',
        profile_id: 'builder',
        changes: { dsh: { model: 'deepseek-v4-pro' } },
      },
      { expectedRevision: initial.revision },
    );

    const updatedRaw = await readFile(configPath, 'utf8');
    expect(updatedRaw).toContain('# Keep this operator note.');
    expect(updatedRaw).toContain('model: deepseek-v4-pro');
  });

  it('fails closed on a stale revision before creating a backup or writing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-control-'));
    const configPath = await writeEditableConfig(root);
    const before = await readFile(configPath);

    await expect(
      applyProfileChange(
        configPath,
        { operation: 'set-default', profile_id: 'reviewer', project_id: 'sample' },
        { expectedRevision: '0'.repeat(64) },
      ),
    ).rejects.toBeInstanceOf(ConfigRevisionConflictError);
    expect(await readFile(configPath)).toEqual(before);
    expect(await listConfigBackups(configPath)).toHaveLength(0);
  });

  it('rejects a concurrent cross-process lock without changing the configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-control-'));
    const configPath = await writeEditableConfig(root);
    const snapshot = await readConfigSnapshot(configPath);
    const lockPath = `${configPath}.dsh-bridge.lock`;
    await writeFile(lockPath, '{"pid":99999}\n', { mode: 0o600 });
    await expect(
      applyProfileChange(
        configPath,
        {
          operation: 'update',
          profile_id: 'builder',
          changes: { dsh: { model: 'deepseek-v4-pro' } },
        },
        { expectedRevision: snapshot.revision },
      ),
    ).rejects.toThrow(/locked by another Bridge process/);
    expect((await readConfigSnapshot(configPath)).revision).toBe(snapshot.revision);
    await rm(lockPath);
  });

  it('redacts credential forms in boundary error text', () => {
    const syntheticToken = `sk-${'a'.repeat(20)}`;
    const output = redactSensitiveText(
      `Authorization: Bearer secret-value\napi_key=${syntheticToken}`,
    );
    expect(output).not.toContain('secret-value');
    expect(output).not.toContain(syntheticToken);
  });

  it('requires an explicit replacement when removing a default profile', () => {
    expect(() =>
      previewProfileChange(editableConfig, {
        operation: 'remove',
        profile_id: 'builder',
      }),
    ).toThrow(/replacement_profile_id/);
  });

  it('previews add and set-default mutations as pure operations', () => {
    const added = previewProfileChange(editableConfig, {
      operation: 'add',
      profile: {
        ...secondProfile,
        profile_id: 'fast-builder',
        description: 'Fast code changes.',
      },
    });
    expect(added.after.profiles.map((candidate) => candidate.profile_id)).toEqual([
      'builder',
      'reviewer',
      'fast-builder',
    ]);
    expect(added.summary).toMatch(/^Add profile fast-builder/);

    const defaulted = previewProfileChange(editableConfig, {
      operation: 'set_default',
      project_id: 'sample',
      profile_id: 'reviewer',
    });
    expect(defaulted.after.projects[0]?.default_profile).toBe('reviewer');
    expect(defaulted.summary).toMatch(/^Set default profile reviewer/);

    const addWithDefault = previewProfileChange(editableConfig, {
      operation: 'add',
      profile: {
        ...secondProfile,
        profile_id: 'default-reviewer',
        description: 'Default review profile.',
      },
      set_default_for: ['sample'],
    });
    expect(addWithDefault.after.projects[0]?.default_profile).toBe('default-reviewer');
  });

  it('accepts a full-profile update and protocol replacement spelling', () => {
    const fullProfile = {
      ...secondProfile,
      profile_id: 'builder',
      dsh: { ...secondProfile.dsh, model: 'deepseek-v4-pro' },
    };
    const updated = previewProfileChange(editableConfig, {
      operation: 'update',
      profile_id: 'builder',
      profile: fullProfile,
    });
    expect(
      updated.after.profiles.find((candidate) => candidate.profile_id === 'builder')?.dsh.model,
    ).toBe('deepseek-v4-pro');

    const removed = previewProfileChange(editableConfig, {
      operation: 'remove',
      profile_id: 'builder',
      replacement_default_profile_id: 'reviewer',
    });
    expect(removed.after.projects[0]?.default_profile).toBe('reviewer');
  });

  it('replaces defaults while removing a profile when explicitly requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-control-'));
    const configPath = await writeEditableConfig(root);
    const initial = await readConfigSnapshot(configPath);
    const result = await applyProfileChange(
      configPath,
      {
        operation: 'remove',
        profile_id: 'builder',
        replacement_profile_id: 'reviewer',
      },
      { expectedRevision: initial.revision },
    );
    const updated = await readConfigSnapshot(configPath);

    expect(result.preview.diff_text).toContain('reviewer');
    expect(updated.config.profiles.map((candidate) => candidate.profile_id)).toEqual(['reviewer']);
    expect(updated.config.projects[0]?.default_profile).toBe('reviewer');
  });

  it('rejects sensitive fields and invalid schema changes without touching disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-control-'));
    const configPath = await writeEditableConfig(root);
    const initial = await readConfigSnapshot(configPath);

    expect(() =>
      previewProfileChange(editableConfig, {
        operation: 'update',
        profile_id: 'builder',
        changes: { dsh: { api_key: 'not-written' } } as never,
      }),
    ).toThrow(SensitiveConfigFieldError);

    await expect(
      applyProfileChange(
        configPath,
        {
          operation: 'update',
          profile_id: 'builder',
          changes: { dsh: { model: 'not a valid model' } },
        },
        { expectedRevision: initial.revision },
      ),
    ).rejects.toThrow();
    expect(await readFile(configPath, 'utf8')).toBe(initial.raw);
    expect(await listConfigBackups(configPath)).toHaveLength(0);
  });

  it('rolls back the latest validated backup with a revision guard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-control-'));
    const configPath = await writeEditableConfig(root);
    const initial = await readConfigSnapshot(configPath);
    const applied = await applyProfileChange(
      configPath,
      {
        operation: 'update',
        profile_id: 'builder',
        changes: { dsh: { model: 'deepseek-v4-pro' } },
      },
      { expectedRevision: initial.revision },
    );

    const rolledBack = await rollbackConfig(configPath, { expectedRevision: applied.revision });
    const restored = await readConfigSnapshot(configPath);
    expect(rolledBack.restored_backup_path).toBe(applied.backup_path);
    expect(restored.raw).toBe(initial.raw);
    expect(
      restored.config.profiles.find((candidate) => candidate.profile_id === 'builder')?.dsh.model,
    ).toBe('deepseek-v4-flash');
    await expect(
      rollbackConfig(configPath, { expectedRevision: applied.revision }),
    ).rejects.toBeInstanceOf(ConfigRevisionConflictError);
  });

  it('keeps the backup directory bounded across repeated writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-control-'));
    const configPath = await writeEditableConfig(root);
    let snapshot = await readConfigSnapshot(configPath);
    for (const model of ['deepseek-v4-pro', 'deepseek-v4-flash-2', 'deepseek-v4-flash-3']) {
      const applied = await applyProfileChange(
        configPath,
        { operation: 'update', profile_id: 'builder', changes: { dsh: { model } } },
        { expectedRevision: snapshot.revision, maxBackups: 2 },
      );
      snapshot = await readConfigSnapshot(configPath);
      expect(applied.revision).toBe(snapshot.revision);
    }
    expect(await listConfigBackups(configPath)).toHaveLength(2);
  });
});
