import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, basename, resolve } from 'node:path';

import {
  IdentifierSchema,
  ProfileSchema,
  PROTOCOL_VERSION,
  ProtocolVersionSchema,
  type ProfileDefinition,
  type Profile,
  type ProfileSummary,
} from '@dsh-codex-bridge/protocol';
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from 'yaml';
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

/** A lowercase SHA-256 digest of the exact configuration file bytes. */
export type ConfigRevision = string;

export const ConfigRevisionSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256 configuration revision');

export type ProfileChangeOperation = 'add' | 'update' | 'remove' | 'set-default';

/**
 * A recursive partial profile definition used by the update operation. Arrays
 * are replaced as a whole; object values are merged recursively.
 */
export type DeepPartial<T> = T extends readonly (infer Item)[]
  ? readonly DeepPartial<Item>[]
  : T extends object
    ? { [Key in keyof T]?: DeepPartial<T[Key]> | undefined }
    : T;

export type ProfileDefinitionChanges = DeepPartial<ProfileDefinition>;

export interface AddProfileChange {
  readonly operation: 'add';
  readonly profile: Profile;
  readonly set_default_for?: readonly string[];
}

export interface UpdateProfileChange {
  readonly operation: 'update';
  readonly profile_id: string;
  /** Prefer `changes` for a partial update; a full `profile` is also accepted. */
  readonly changes?: ProfileDefinitionChanges;
  readonly profile?: Profile;
}

export interface RemoveProfileChange {
  readonly operation: 'remove';
  readonly profile_id: string;
  readonly replacement_profile_id?: string;
  /** JSON/protocol spelling accepted at the package boundary. */
  readonly replacement_default_profile_id?: string;
}

export interface SetDefaultProfileChange {
  readonly operation: 'set-default';
  readonly profile_id: string;
  readonly project_id?: string;
}

/** Protocol-facing underscore spelling accepted by the normalizer. */
export interface SetDefaultProfileChangeAlias {
  readonly operation: 'set_default';
  readonly profile_id: string;
  readonly project_id: string;
}

export type ProfileChangeRequest =
  | AddProfileChange
  | UpdateProfileChange
  | RemoveProfileChange
  | SetDefaultProfileChange
  | SetDefaultProfileChangeAlias;

type CanonicalProfileChangeRequest =
  AddProfileChange | UpdateProfileChange | RemoveProfileChange | SetDefaultProfileChange;

/** A single safe, displayable change in a preview. */
export interface ConfigDiffEntry {
  readonly path: string;
  readonly kind: 'added' | 'removed' | 'changed';
  readonly before: unknown;
  readonly after: unknown;
}

export interface ProfileChangePreview {
  readonly operation: ProfileChangeOperation;
  readonly profile_id: string;
  readonly project_id?: string;
  readonly changed: boolean;
  /** Parsed configuration before the proposed mutation. */
  readonly before: BridgeConfig;
  /** Parsed configuration after the proposed mutation. */
  readonly after: BridgeConfig;
  readonly diff: readonly ConfigDiffEntry[];
  readonly diff_text: string;
  readonly summary: string;
  readonly summary_lines: readonly string[];
}

export interface ConfigSnapshot {
  readonly config_path: string;
  readonly raw: string;
  readonly revision: ConfigRevision;
  readonly config_revision: ConfigRevision;
  readonly config: BridgeConfig;
}

export interface ApplyProfileChangeOptions {
  /** Required optimistic-concurrency guard. */
  readonly expectedRevision?: ConfigRevision;
  /** JSON/protocol spelling accepted at the package boundary. */
  readonly expected_revision?: ConfigRevision;
  /** Number of backups to retain, including the newly-created backup. */
  readonly maxBackups?: number;
}

export interface AppliedProfileChange {
  readonly config_path: string;
  readonly previous_revision: ConfigRevision;
  readonly revision: ConfigRevision;
  readonly config_revision: ConfigRevision;
  readonly backup_path: string;
  readonly preview: ProfileChangePreview;
}

export interface RollbackOptions {
  /** Required optimistic-concurrency guard. */
  readonly expectedRevision?: ConfigRevision;
  /** JSON/protocol spelling accepted at the package boundary. */
  readonly expected_revision?: ConfigRevision;
  /** Number of backups to retain, including the newly-created backup. */
  readonly maxBackups?: number;
}

export interface RollbackResult {
  readonly config_path: string;
  readonly previous_revision: ConfigRevision;
  readonly revision: ConfigRevision;
  readonly config_revision: ConfigRevision;
  readonly restored_backup_path: string;
  readonly backup_path: string;
  readonly preview: ProfileChangePreview;
}

export const DEFAULT_CONFIG_BACKUP_LIMIT = 10;

const PROFILE_CHANGE_OPERATION_SCHEMA = z.enum(['add', 'update', 'remove', 'set-default']);
const ProfileChangeRequestSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('add'),
      profile: ProfileSchema,
      set_default_for: z.array(IdentifierSchema).max(256).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('update'),
      profile_id: IdentifierSchema,
      changes: z.record(z.unknown()).optional(),
      profile: ProfileSchema.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('remove'),
      profile_id: IdentifierSchema,
      replacement_profile_id: IdentifierSchema.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('set-default'),
      profile_id: IdentifierSchema,
      project_id: IdentifierSchema.optional(),
    })
    .strict(),
]);

/**
 * A write error that is safe for callers to turn into a retryable response.
 * It intentionally includes revisions but never includes configuration values.
 */
export class ConfigRevisionConflictError extends Error {
  readonly code = 'CONFIG_REVISION_CONFLICT' as const;
  readonly expectedRevision: ConfigRevision;
  readonly actualRevision: ConfigRevision;

  constructor(expectedRevision: ConfigRevision, actualRevision: ConfigRevision) {
    super(
      `Configuration revision conflict: expected ${expectedRevision}, current ${actualRevision}`,
    );
    this.name = 'ConfigRevisionConflictError';
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class SensitiveConfigFieldError extends Error {
  readonly code = 'SENSITIVE_CONFIG_FIELD' as const;
  readonly fieldPath: string;

  constructor(fieldPath: string) {
    super(`Sensitive configuration field is not accepted: ${fieldPath}`);
    this.name = 'SensitiveConfigFieldError';
    this.fieldPath = fieldPath;
  }
}

/** Remove common credential forms before an error crosses the CLI/MCP boundary. */
export function redactSensitiveText(input: string): string {
  return input
    .replace(
      /(^|\r?\n)([^\S\r\n]*(?:authorization|cookie|x-api-key|x-auth-token)[^\S\r\n]*:[^\S\r\n]*)([^\r\n]*)/gim,
      '$1$2[REDACTED]',
    )
    .replace(/\bbearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|rk|pk|gsk)-[A-Za-z0-9_-]{16,}\b/gi, '[REDACTED]')
    .replace(/\bAIza[\w-]{20,}\b/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gi, '[REDACTED]')
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      '$1[REDACTED]',
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSensitiveFieldName(name: string): boolean {
  const normalized = name.replace(/[-_\s]/g, '').toLowerCase();
  // max_tokens is a safe execution limit and must not be treated as a token.
  if (normalized === 'maxtokens') return false;
  return (
    normalized.includes('token') ||
    normalized.includes('apikey') ||
    normalized.includes('accesskey') ||
    normalized.includes('privatekey') ||
    normalized.includes('secret') ||
    normalized.includes('credential') ||
    normalized.includes('password') ||
    normalized.includes('passphrase') ||
    normalized.includes('authorization') ||
    normalized === 'auth' ||
    normalized.includes('cookie') ||
    normalized.includes('endpoint') ||
    normalized === 'bearer'
  );
}

function looksLikeCredentialValue(value: string): boolean {
  return (
    /^bearer\s+/i.test(value) ||
    /^-----begin [^-]*private key-----/i.test(value) ||
    /^(?:sk|rk|pk|gsk)-[A-Za-z0-9_-]{16,}$/i.test(value) ||
    /^AIza[\w-]{20,}$/i.test(value) ||
    /^gh[pousr]_[A-Za-z0-9_]{20,}$/i.test(value) ||
    /^xox[baprs]-[A-Za-z0-9-]{20,}$/i.test(value)
  );
}

/**
 * Walk an input without returning or logging its values. This is deliberately
 * applied to both the existing document and proposed changes: metadata is
 * extensible in the runtime schema, but it is not a safe place for secrets.
 */
function assertNoSensitiveFields(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveFields(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'string') {
    if (looksLikeCredentialValue(value)) throw new SensitiveConfigFieldError(path);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (isSensitiveFieldName(key)) throw new SensitiveConfigFieldError(childPath);
    assertNoSensitiveFields(child, childPath);
  }
}

function cloneConfig(config: BridgeConfig): BridgeConfig {
  return structuredClone(config);
}

function deepMerge(base: unknown, changes: unknown): unknown {
  if (!isRecord(base) || !isRecord(changes)) return structuredClone(changes);
  const merged: Record<string, unknown> = structuredClone(base);
  for (const [key, value] of Object.entries(changes)) {
    merged[key] = key in merged ? deepMerge(merged[key], value) : structuredClone(value);
  }
  return merged;
}

function normalizeOperation(operation: string): ProfileChangeOperation {
  if (operation === 'set_default') return 'set-default';
  return PROFILE_CHANGE_OPERATION_SCHEMA.parse(operation);
}

function normalizeProfileChangeRequest(
  request: ProfileChangeRequest,
): CanonicalProfileChangeRequest {
  if (!isRecord(request)) throw new Error('Profile change request must be an object');
  const operation = normalizeOperation(String(request.operation));
  let normalized = { ...request, operation } as CanonicalProfileChangeRequest;
  assertNoSensitiveFields(normalized);
  if (normalized.operation === 'update') {
    if (normalized.profile !== undefined) {
      const fullProfile = ProfileSchema.parse(normalized.profile);
      if (fullProfile.profile_id !== normalized.profile_id) {
        throw new Error('replacement profile_id must match profile.profile_id');
      }
    }
  }
  if (
    normalized.operation === 'remove' &&
    normalized.replacement_profile_id === undefined &&
    normalized.replacement_default_profile_id !== undefined
  ) {
    normalized = {
      operation: 'remove',
      profile_id: normalized.profile_id,
      replacement_profile_id: normalized.replacement_default_profile_id,
    };
  }
  // zod performs strict validation and rejects unknown request-level fields.
  const parsed = ProfileChangeRequestSchema.parse(normalized) as CanonicalProfileChangeRequest;
  if (
    parsed.operation === 'update' &&
    (parsed.changes === undefined) === (parsed.profile === undefined)
  ) {
    throw new Error('An update must provide exactly one of profile or changes');
  }
  return parsed;
}

function profileById(config: BridgeConfig, profileId: string): Profile {
  const profile = config.profiles.find((candidate) => candidate.profile_id === profileId);
  if (profile === undefined) throw new Error(`Unknown profile: ${profileId}`);
  return profile;
}

function projectForDefaultChange(
  config: BridgeConfig,
  projectId: string | undefined,
): ProjectConfig {
  if (projectId !== undefined) {
    const project = config.projects.find((candidate) => candidate.project_id === projectId);
    if (project === undefined) throw new Error(`Unknown project: ${projectId}`);
    return project;
  }
  if (config.projects.length !== 1) {
    throw new Error('project_id is required when the configuration has multiple projects');
  }
  const project = config.projects[0];
  if (project === undefined) throw new Error('Configuration has no project');
  return project;
}

function applyPureProfileChange(
  before: BridgeConfig,
  request: ProfileChangeRequest,
): { after: BridgeConfig; profileId: string; projectId?: string } {
  const after = cloneConfig(before);
  const normalized = normalizeProfileChangeRequest(request);
  assertNoSensitiveFields(normalized);

  if (normalized.operation === 'add') {
    if (after.profiles.some((profile) => profile.profile_id === normalized.profile.profile_id)) {
      throw new Error(`Profile already exists: ${normalized.profile.profile_id}`);
    }
    const profile = ProfileSchema.parse(normalized.profile);
    after.profiles.push(profile);
    if (normalized.set_default_for !== undefined) {
      const requestedProjects = new Set(normalized.set_default_for);
      for (const projectId of requestedProjects) {
        if (!after.projects.some((project) => project.project_id === projectId)) {
          throw new Error(`Unknown project: ${projectId}`);
        }
      }
      after.projects = after.projects.map((project) =>
        requestedProjects.has(project.project_id)
          ? { ...project, default_profile: profile.profile_id }
          : project,
      );
    }
    return { after: BridgeConfigSchema.parse(after), profileId: profile.profile_id };
  }

  if (normalized.operation === 'update') {
    const index = after.profiles.findIndex(
      (profile) => profile.profile_id === normalized.profile_id,
    );
    if (index < 0) throw new Error(`Unknown profile: ${normalized.profile_id}`);
    if (normalized.profile !== undefined) {
      after.profiles[index] = ProfileSchema.parse(normalized.profile);
      return { after: BridgeConfigSchema.parse(after), profileId: normalized.profile_id };
    }
    const changes = normalized.changes;
    if (changes === undefined) throw new Error('An update must provide profile or changes');
    if ('profile_id' in changes || 'protocol_version' in changes) {
      throw new Error('profile_id and protocol_version cannot be changed by an update');
    }
    const current = after.profiles[index];
    if (current === undefined) throw new Error(`Unknown profile: ${normalized.profile_id}`);
    const merged = deepMerge(current, changes);
    after.profiles[index] = ProfileSchema.parse(merged);
    return { after: BridgeConfigSchema.parse(after), profileId: normalized.profile_id };
  }

  if (normalized.operation === 'set-default') {
    profileById(after, normalized.profile_id);
    const project = projectForDefaultChange(after, normalized.project_id);
    const index = after.projects.findIndex(
      (candidate) => candidate.project_id === project.project_id,
    );
    if (index < 0) throw new Error(`Unknown project: ${project.project_id}`);
    after.projects[index] = { ...project, default_profile: normalized.profile_id };
    return {
      after: BridgeConfigSchema.parse(after),
      profileId: normalized.profile_id,
      projectId: project.project_id,
    };
  }

  const index = after.profiles.findIndex((profile) => profile.profile_id === normalized.profile_id);
  if (index < 0) throw new Error(`Unknown profile: ${normalized.profile_id}`);
  const replacementId = normalized.replacement_profile_id;
  if (replacementId !== undefined) {
    if (replacementId === normalized.profile_id) {
      throw new Error('replacement_profile_id must differ from the removed profile');
    }
    profileById(after, replacementId);
  }
  const defaultProjects = after.projects.filter(
    (project) => project.default_profile === normalized.profile_id,
  );
  if (defaultProjects.length > 0 && replacementId === undefined) {
    throw new Error(
      `Cannot remove default profile ${normalized.profile_id} without replacement_profile_id`,
    );
  }
  after.profiles.splice(index, 1);
  if (replacementId !== undefined) {
    after.projects = after.projects.map((project) =>
      project.default_profile === normalized.profile_id
        ? { ...project, default_profile: replacementId }
        : project,
    );
  }
  return { after: BridgeConfigSchema.parse(after), profileId: normalized.profile_id };
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function collectDiff(
  before: unknown,
  after: unknown,
  path: string,
  entries: ConfigDiffEntry[],
): void {
  if (Object.is(before, after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      const childPath = `${path}[${index}]`;
      if (index >= before.length) {
        entries.push({ path: childPath, kind: 'added', before: undefined, after: after[index] });
      } else if (index >= after.length) {
        entries.push({ path: childPath, kind: 'removed', before: before[index], after: undefined });
      } else {
        collectDiff(before[index], after[index], childPath, entries);
      }
    }
    return;
  }
  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      const childPath = path === '$' ? `$.${key}` : `${path}.${key}`;
      if (!hasOwn(before, key)) {
        entries.push({ path: childPath, kind: 'added', before: undefined, after: after[key] });
      } else if (!hasOwn(after, key)) {
        entries.push({ path: childPath, kind: 'removed', before: before[key], after: undefined });
      } else {
        collectDiff(before[key], after[key], childPath, entries);
      }
    }
    return;
  }
  entries.push({ path, kind: 'changed', before, after });
}

function displayValue(value: unknown): string {
  if (value === undefined) return '∅';
  const serialized = JSON.stringify(value);
  return serialized === undefined ? '<unserializable>' : serialized;
}

function renderDiff(entries: readonly ConfigDiffEntry[]): string {
  return entries
    .map((entry) => {
      if (entry.kind === 'added') return `+ ${entry.path}: ${displayValue(entry.after)}`;
      if (entry.kind === 'removed') return `- ${entry.path}: ${displayValue(entry.before)}`;
      return `~ ${entry.path}: ${displayValue(entry.before)} → ${displayValue(entry.after)}`;
    })
    .join('\n');
}

function summarizeDiff(
  operation: ProfileChangeOperation,
  profileId: string,
  projectId: string | undefined,
  entries: readonly ConfigDiffEntry[],
): { summary: string; lines: string[] } {
  const target =
    projectId === undefined
      ? `profile ${profileId}`
      : `profile ${profileId} for project ${projectId}`;
  if (entries.length === 0) return { summary: `No changes to ${target}.`, lines: [] };
  const verb =
    operation === 'add'
      ? 'Add'
      : operation === 'remove'
        ? 'Remove'
        : operation === 'set-default'
          ? 'Set default'
          : 'Update';
  const lines = [`${verb} ${target} (${entries.length} change${entries.length === 1 ? '' : 's'}).`];
  return { summary: lines[0] ?? '', lines };
}

/**
 * Purely computes a proposed profile mutation. Neither the input object nor
 * the filesystem is changed. The returned values are detached copies.
 */
export function previewProfileChange(
  config: BridgeConfig,
  request: ProfileChangeRequest,
): ProfileChangePreview {
  const before = BridgeConfigSchema.parse(cloneConfig(config));
  assertNoSensitiveFields(before);
  const result = applyPureProfileChange(before, request);
  const after = BridgeConfigSchema.parse(cloneConfig(result.after));
  assertNoSensitiveFields(after);
  const diff: ConfigDiffEntry[] = [];
  collectDiff(before, after, '$', diff);
  const summary = summarizeDiff(
    normalizeOperation(String(request.operation)),
    result.profileId,
    result.projectId,
    diff,
  );
  return {
    operation: normalizeOperation(String(request.operation)),
    profile_id: result.profileId,
    ...(result.projectId === undefined ? {} : { project_id: result.projectId }),
    changed: diff.length > 0,
    before: cloneConfig(before),
    after: cloneConfig(after),
    diff,
    diff_text: renderDiff(diff),
    summary: summary.summary,
    summary_lines: summary.lines,
  };
}

export function calculateConfigRevision(input: string | Uint8Array): ConfigRevision {
  return createHash('sha256').update(input).digest('hex');
}

export const computeConfigRevision = calculateConfigRevision;

function parseConfigText(raw: string): BridgeConfig {
  const parsed = BridgeConfigSchema.parse(parseYaml(raw) as unknown);
  assertNoSensitiveFields(parsed);
  return parsed;
}

function flattenObjectLeaves(
  value: unknown,
  path: readonly (string | number)[] = [],
): Array<{
  path: readonly (string | number)[];
  value: unknown;
}> {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    return [{ path, value }];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    flattenObjectLeaves(child, [...path, key]),
  );
}

/**
 * Apply only the requested AST edits to retain comments and the ordering of
 * untouched YAML keys. The result is still schema-validated by the caller.
 */
function serializeProfileMutation(
  raw: string,
  request: ProfileChangeRequest,
  before: BridgeConfig,
  expectedAfter: BridgeConfig,
): string {
  const normalized = normalizeProfileChangeRequest(request);
  const document = parseDocument(raw);
  const profiles = document.get('profiles', true) as {
    add(value: unknown): void;
    delete(key: number): boolean;
  };
  if (profiles === undefined || typeof profiles.add !== 'function') {
    throw new Error('Configuration document does not contain an editable profiles sequence');
  }
  if (normalized.operation === 'add') {
    profiles.add(document.createNode(normalized.profile));
    if (normalized.set_default_for !== undefined) {
      const requestedProjects = new Set(normalized.set_default_for);
      before.projects.forEach((project, projectIndex) => {
        if (requestedProjects.has(project.project_id)) {
          document.setIn(
            ['projects', projectIndex, 'default_profile'],
            normalized.profile.profile_id,
          );
        }
      });
    }
  } else if (normalized.operation === 'update') {
    const index = before.profiles.findIndex(
      (profile) => profile.profile_id === normalized.profile_id,
    );
    if (index < 0) throw new Error(`Unknown profile: ${normalized.profile_id}`);
    if (normalized.profile !== undefined) {
      document.setIn(['profiles', index], normalized.profile);
    } else {
      const changes = normalized.changes;
      if (changes === undefined) throw new Error('An update must provide profile or changes');
      for (const leaf of flattenObjectLeaves(changes)) {
        document.setIn(['profiles', index, ...leaf.path], leaf.value);
      }
    }
  } else if (normalized.operation === 'remove') {
    const index = before.profiles.findIndex(
      (profile) => profile.profile_id === normalized.profile_id,
    );
    if (index < 0) throw new Error(`Unknown profile: ${normalized.profile_id}`);
    if (!profiles.delete(index))
      throw new Error(`Unable to remove profile: ${normalized.profile_id}`);
    if (normalized.replacement_profile_id !== undefined) {
      before.projects.forEach((project, projectIndex) => {
        if (project.default_profile === normalized.profile_id) {
          document.setIn(
            ['projects', projectIndex, 'default_profile'],
            normalized.replacement_profile_id,
          );
        }
      });
    }
  } else {
    const project = projectForDefaultChange(before, normalized.project_id);
    document.setIn(
      [
        'projects',
        before.projects.findIndex((candidate) => candidate.project_id === project.project_id),
        'default_profile',
      ],
      normalized.profile_id,
    );
  }
  const output = document.toString();
  const parsedOutput = parseConfigText(output);
  if (JSON.stringify(parsedOutput) !== JSON.stringify(expectedAfter)) {
    // AST edits deliberately preserve untouched source. If a YAML feature
    // prevents an exact round-trip, fall back to a canonical serialization
    // that still has the same schema-validated semantic value.
    return stringifyYaml(expectedAfter);
  }
  return output;
}

export async function readConfigSnapshot(configPath: string): Promise<ConfigSnapshot> {
  const resolvedPath = resolve(configPath);
  const bytes = await readFile(resolvedPath);
  const raw = bytes.toString('utf8');
  return {
    config_path: resolvedPath,
    raw,
    revision: calculateConfigRevision(bytes),
    config_revision: calculateConfigRevision(bytes),
    config: parseConfigText(raw),
  };
}

export const readBridgeConfigSnapshot = readConfigSnapshot;

export async function getConfigRevision(configPath: string): Promise<ConfigRevision> {
  return calculateConfigRevision(await readFile(resolve(configPath)));
}

function assertExpectedRevision(value: string): void {
  ConfigRevisionSchema.parse(value);
}

function requiredExpectedRevision(
  options: Pick<ApplyProfileChangeOptions, 'expectedRevision' | 'expected_revision'>,
): ConfigRevision {
  if (
    options.expectedRevision !== undefined &&
    options.expected_revision !== undefined &&
    options.expectedRevision !== options.expected_revision
  ) {
    throw new Error('expectedRevision and expected_revision must match');
  }
  const expected = options.expectedRevision ?? options.expected_revision;
  if (expected === undefined)
    throw new Error('expectedRevision is required for configuration writes');
  assertExpectedRevision(expected);
  return expected;
}

function normalizeBackupLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_CONFIG_BACKUP_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('maxBackups must be a positive integer');
  }
  return limit;
}

function assertRevisionMatches(expected: ConfigRevision, actual: ConfigRevision): void {
  if (expected !== actual) throw new ConfigRevisionConflictError(expected, actual);
}

function backupDirectory(configPath: string): string {
  return join(dirname(configPath), '.dsh-codex-bridge', 'config-backups');
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } catch (error) {
    // Directory fsync is not available on every supported filesystem. The
    // file itself has already been fsynced, so tolerate only platform-level
    // "not supported" errors here.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') throw error;
  } finally {
    await handle.close();
  }
}

async function atomicWriteFile(filePath: string, content: string | Uint8Array): Promise<void> {
  const directory = dirname(filePath);
  const fileName = basename(filePath);
  let temporaryPath = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    temporaryPath = join(
      directory,
      `.${fileName}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`,
    );
    try {
      const handle = await open(temporaryPath, 'wx', 0o600);
      try {
        await handle.chmod(0o600);
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, filePath);
      await syncDirectory(directory);
      return;
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' && attempt < 4) continue;
      throw error;
    }
  }
  throw new Error(`Unable to allocate an atomic temporary file for ${filePath}`);
}

async function createConfigBackup(
  configPath: string,
  raw: string,
  revision: ConfigRevision,
  maxBackups: number,
): Promise<string> {
  if (!Number.isInteger(maxBackups) || maxBackups < 1) {
    throw new Error('maxBackups must be a positive integer');
  }
  const directory = backupDirectory(configPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const backupPath = join(
    directory,
    `config-${Date.now()}-${randomBytes(6).toString('hex')}-${revision}.yaml`,
  );
  await atomicWriteFile(backupPath, raw);
  await chmod(backupPath, 0o600);
  await pruneConfigBackups(directory, maxBackups);
  return backupPath;
}

async function listBackupEntries(directory: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const entries: Array<{ path: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.endsWith('.yaml')) continue;
    const path = join(directory, name);
    const info = await stat(path);
    if (info.isFile()) entries.push({ path, mtimeMs: info.mtimeMs });
  }
  entries.sort(
    (left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path),
  );
  return entries.map((entry) => entry.path);
}

async function pruneConfigBackups(directory: string, maxBackups: number): Promise<void> {
  const paths = await listBackupEntries(directory);
  for (const path of paths.slice(maxBackups)) await rm(path, { force: true });
}

const mutationQueues = new Map<string, Promise<void>>();

async function acquireMutationFileLock(configPath: string): Promise<() => Promise<void>> {
  const lockPath = `${resolve(configPath)}.dsh-bridge.lock`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
    );
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (handle !== undefined) await rm(lockPath, { force: true }).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `Configuration is locked by another Bridge process: ${lockPath}. Retry after that operation finishes; remove a stale lock only after confirming no Bridge write is running.`,
      );
    }
    throw error;
  }
  const heldHandle = handle;
  return async () => {
    await heldHandle.close().catch(() => undefined);
    await rm(lockPath, { force: true });
  };
}

async function withMutationLock<T>(configPath: string, action: () => Promise<T>): Promise<T> {
  const key = resolve(configPath);
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const next = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  const queued = previous.then(() => next);
  mutationQueues.set(key, queued);
  await previous;
  let releaseFileLock: (() => Promise<void>) | undefined;
  try {
    releaseFileLock = await acquireMutationFileLock(key);
    return await action();
  } finally {
    try {
      await releaseFileLock?.();
    } finally {
      release?.();
      if (mutationQueues.get(key) === queued) mutationQueues.delete(key);
    }
  }
}

async function verifyWrittenConfig(
  configPath: string,
  expectedConfig: BridgeConfig,
): Promise<ConfigSnapshot> {
  const snapshot = await readConfigSnapshot(configPath);
  // Parse and compare through the schema, never trust the serialized text.
  const parsedExpected = BridgeConfigSchema.parse(expectedConfig);
  const parsedWritten = BridgeConfigSchema.parse(snapshot.config);
  if (JSON.stringify(parsedWritten) !== JSON.stringify(parsedExpected)) {
    throw new Error('Written configuration did not round-trip through BridgeConfigSchema');
  }
  return snapshot;
}

async function restoreIfRevisionStillMatches(
  configPath: string,
  writtenRevision: ConfigRevision,
  raw: string,
): Promise<void> {
  try {
    const currentRevision = await getConfigRevision(configPath);
    if (currentRevision === writtenRevision) await atomicWriteFile(configPath, raw);
  } catch {
    // Preserve the original write/verification error. If the file disappeared
    // or changed concurrently, do not risk overwriting an unknown revision.
  }
}

export async function applyProfileChange(
  configPath: string,
  request: ProfileChangeRequest,
  options: ApplyProfileChangeOptions,
): Promise<AppliedProfileChange> {
  const expectedRevision = requiredExpectedRevision(options);
  const maxBackups = normalizeBackupLimit(options.maxBackups);
  return withMutationLock(configPath, async () => {
    const snapshot = await readConfigSnapshot(configPath);
    assertRevisionMatches(expectedRevision, snapshot.revision);
    const preview = previewProfileChange(snapshot.config, request);
    if (!preview.changed) {
      return {
        config_path: snapshot.config_path,
        previous_revision: snapshot.revision,
        revision: snapshot.revision,
        config_revision: snapshot.revision,
        backup_path: '',
        preview,
      };
    }
    // Check once more immediately before the backup/write boundary. This
    // closes the common external-edit race without ever overwriting a newer
    // revision silently.
    const currentRevision = await getConfigRevision(snapshot.config_path);
    assertRevisionMatches(expectedRevision, currentRevision);
    // Validate the exact bytes that are about to be written. The YAML AST
    // path retains comments and ordering where the source permits it.
    const serializedOutput = serializeProfileMutation(
      snapshot.raw,
      request,
      snapshot.config,
      preview.after,
    );
    const serializedConfig = parseConfigText(serializedOutput);
    const serializedRevision = calculateConfigRevision(serializedOutput);
    const backupPath = await createConfigBackup(
      snapshot.config_path,
      snapshot.raw,
      snapshot.revision,
      maxBackups,
    );
    const revisionAfterBackup = await getConfigRevision(snapshot.config_path);
    assertRevisionMatches(expectedRevision, revisionAfterBackup);
    try {
      await atomicWriteFile(snapshot.config_path, serializedOutput);
      const written = await verifyWrittenConfig(snapshot.config_path, serializedConfig);
      return {
        config_path: snapshot.config_path,
        previous_revision: snapshot.revision,
        revision: written.revision,
        config_revision: written.revision,
        backup_path: backupPath,
        preview,
      };
    } catch (error) {
      // The pre-write file is a validated snapshot; restore it if a final
      // verification unexpectedly fails, while preserving the backup for a
      // later explicit rollback.
      await restoreIfRevisionStillMatches(snapshot.config_path, serializedRevision, snapshot.raw);
      throw error;
    }
  });
}

export const applyConfigChange = applyProfileChange;

export async function listConfigBackups(configPath: string): Promise<readonly string[]> {
  return listBackupEntries(backupDirectory(resolve(configPath)));
}

export async function rollbackConfig(
  configPath: string,
  options: RollbackOptions,
): Promise<RollbackResult> {
  const expectedRevision = requiredExpectedRevision(options);
  const maxBackups = normalizeBackupLimit(options.maxBackups);
  return withMutationLock(configPath, async () => {
    const snapshot = await readConfigSnapshot(configPath);
    assertRevisionMatches(expectedRevision, snapshot.revision);
    const backups = await listBackupEntries(backupDirectory(snapshot.config_path));
    const restoredBackupPath = backups[0];
    if (restoredBackupPath === undefined) throw new Error('No configuration backup available');
    const restoredRaw = (await readFile(restoredBackupPath)).toString('utf8');
    const restoredConfig = parseConfigText(restoredRaw);
    const diff: ConfigDiffEntry[] = [];
    collectDiff(snapshot.config, restoredConfig, '$', diff);
    const summary = summarizeDiff('update', 'rollback', undefined, diff);
    const preview: ProfileChangePreview = {
      operation: 'update',
      profile_id: 'rollback',
      changed: diff.length > 0,
      before: cloneConfig(snapshot.config),
      after: cloneConfig(restoredConfig),
      diff,
      diff_text: renderDiff(diff),
      summary: `Rollback ${snapshot.config_path} to ${basename(restoredBackupPath)} (${diff.length} change${diff.length === 1 ? '' : 's'}).`,
      summary_lines: summary.lines,
    };
    const currentRevision = await getConfigRevision(snapshot.config_path);
    assertRevisionMatches(expectedRevision, currentRevision);
    const backupPath = await createConfigBackup(
      snapshot.config_path,
      snapshot.raw,
      snapshot.revision,
      maxBackups,
    );
    const revisionAfterBackup = await getConfigRevision(snapshot.config_path);
    assertRevisionMatches(expectedRevision, revisionAfterBackup);
    try {
      await atomicWriteFile(snapshot.config_path, restoredRaw);
      const written = await verifyWrittenConfig(snapshot.config_path, restoredConfig);
      return {
        config_path: snapshot.config_path,
        previous_revision: snapshot.revision,
        revision: written.revision,
        config_revision: written.revision,
        restored_backup_path: restoredBackupPath,
        backup_path: backupPath,
        preview,
      };
    } catch (error) {
      await restoreIfRevisionStillMatches(
        snapshot.config_path,
        calculateConfigRevision(restoredRaw),
        snapshot.raw,
      );
      throw error;
    }
  });
}

export const rollbackProfileChange = rollbackConfig;
