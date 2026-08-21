import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROTOCOL_VERSION } from '@dsh-codex-bridge/protocol';
import { describe, expect, it } from 'vitest';

import { BridgeConfigSchema, ConfigRegistry, loadBridgeConfig } from './index.js';

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
