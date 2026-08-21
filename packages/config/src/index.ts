import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import {
  IdentifierSchema,
  ProfileSchema,
  PROTOCOL_VERSION,
  ProtocolVersionSchema,
  type Profile,
  type ProfileSummary,
} from '@dsh-codex-bridge/protocol';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const LogLevelSchema = z.enum(['silent', 'error', 'warn', 'info', 'debug']);

export const ProjectConfigSchema = z
  .object({
    project_id: IdentifierSchema,
    root: z.string().min(1),
    default_profile: IdentifierSchema.optional(),
  })
  .strict();
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const BridgeConfigSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    data_root: z.string().min(1),
    log_level: LogLevelSchema.default('info'),
    projects: z.array(ProjectConfigSchema).min(1).max(256),
    profiles: z.array(ProfileSchema).min(1).max(256),
  })
  .strict()
  .superRefine((config, context) => {
    const unique = (values: readonly string[], path: 'projects' | 'profiles'): void => {
      const seen = new Set<string>();
      for (const [index, value] of values.entries()) {
        if (seen.has(value)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [path, index],
            message: `duplicate identifier: ${value}`,
          });
        }
        seen.add(value);
      }
    };
    unique(
      config.projects.map((project) => project.project_id),
      'projects',
    );
    unique(
      config.profiles.map((profile) => profile.profile_id),
      'profiles',
    );
    const profileIds = new Set(config.profiles.map((profile) => profile.profile_id));
    for (const [index, project] of config.projects.entries()) {
      if (project.default_profile !== undefined && !profileIds.has(project.default_profile)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['projects', index, 'default_profile'],
          message: `unknown profile: ${project.default_profile}`,
        });
      }
    }
  });
export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

export class ConfigRegistry {
  readonly #config: BridgeConfig;

  constructor(config: BridgeConfig) {
    this.#config = BridgeConfigSchema.parse(config);
  }

  get value(): BridgeConfig {
    return this.#config;
  }

  project(projectId: string): ProjectConfig {
    const project = this.#config.projects.find((entry) => entry.project_id === projectId);
    if (project === undefined) throw new Error(`Unknown project: ${projectId}`);
    return project;
  }

  profile(profileId: string): Profile {
    const profile = this.#config.profiles.find((entry) => entry.profile_id === profileId);
    if (profile === undefined) throw new Error(`Unknown profile: ${profileId}`);
    return profile;
  }

  profileSummaries(): ProfileSummary[] {
    return this.#config.profiles.map((profile) => ({
      protocol_version: PROTOCOL_VERSION,
      profile_id: profile.profile_id,
      description: profile.description,
      capabilities: profile.capabilities ?? {
        supports_followup: true,
        supports_cancel: true,
        supports_subagents: profile.delegation.max_children > 0,
        supported_workspace_modes: [profile.workspace.mode],
      },
      delegation: {
        max_depth: profile.delegation.max_depth,
        max_children: profile.delegation.max_children,
        roles: Object.keys(profile.delegation.roles).sort(),
      },
      max_tokens: profile.dsh.max_tokens,
      timeout_seconds: profile.policy.timeout_seconds,
      workspace_modes: profile.capabilities?.supported_workspace_modes ?? [profile.workspace.mode],
    }));
  }
}

function absoluteFrom(base: string, value: string): string {
  return isAbsolute(value) ? value : resolve(base, value);
}

export async function loadBridgeConfig(path: string): Promise<ConfigRegistry> {
  const configPath = resolve(path);
  const raw = parseYaml(await readFile(configPath, 'utf8')) as unknown;
  const parsed = BridgeConfigSchema.parse(raw);
  const base = dirname(configPath);
  const hydrated = {
    ...parsed,
    data_root: absoluteFrom(base, parsed.data_root),
    projects: await Promise.all(
      parsed.projects.map(async (project) => ({
        ...project,
        root: await realpath(absoluteFrom(base, project.root)),
      })),
    ),
    profiles: await Promise.all(
      parsed.profiles.map(async (profile) => ({
        ...profile,
        workspace: {
          ...profile.workspace,
          allowed_roots: await Promise.all(
            profile.workspace.allowed_roots.map(async (root) => realpath(absoluteFrom(base, root))),
          ),
        },
      })),
    ),
  };
  return new ConfigRegistry(BridgeConfigSchema.parse(hydrated));
}

export function resolveConfigPath(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  return resolve(cwd, environment['DSH_BRIDGE_CONFIG'] ?? 'bridge.yaml');
}
