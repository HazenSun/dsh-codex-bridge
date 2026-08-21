import { z } from 'zod';

import {
  IdentifierSchema,
  LongTextSchema,
  MetadataSchema,
  NonNegativeIntSchema,
  PositiveIntSchema,
  ProfileIdSchema,
  ProtocolVersionSchema,
  PROTOCOL_VERSION,
  ShortTextSchema,
} from './constants.js';

export const ReasoningEffortSchema = IdentifierSchema;
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const NetworkPolicySchema = z.enum(['off', 'restricted', 'full']);
export type NetworkPolicy = z.infer<typeof NetworkPolicySchema>;

export const WorkspaceModeSchema = z.enum(['isolated_worktree', 'patch_only']);
export type WorkspaceMode = z.infer<typeof WorkspaceModeSchema>;

/** A provider/model route. Provider credentials never cross this boundary. */
export const ModelRouteSchema = z
  .object({
    provider: IdentifierSchema,
    model: IdentifierSchema,
    reasoning_effort: ReasoningEffortSchema.optional(),
    max_tokens: PositiveIntSchema.max(1_000_000).optional(),
  })
  .strict();
export type ModelRoute = z.infer<typeof ModelRouteSchema>;

export const DelegationRoleSchema = ModelRouteSchema.extend({
  description: ShortTextSchema.optional(),
}).strict();
export type DelegationRole = z.infer<typeof DelegationRoleSchema>;

export const DelegationPolicySchema = z
  .object({
    max_depth: NonNegativeIntSchema.max(32).default(0),
    max_children: NonNegativeIntSchema.max(128).default(0),
    roles: z
      .record(IdentifierSchema, DelegationRoleSchema)
      .refine((roles) => Object.keys(roles).length <= 32, 'delegation policy has too many roles')
      .default({}),
  })
  .strict();
export type DelegationPolicy = z.infer<typeof DelegationPolicySchema>;

export const DshProfileConfigSchema = z
  .object({
    provider: IdentifierSchema,
    model: IdentifierSchema,
    reasoning_effort: ReasoningEffortSchema.optional(),
    agent_preset: IdentifierSchema,
    max_tokens: PositiveIntSchema.max(1_000_000),
  })
  .strict();
export type DshProfileConfig = z.infer<typeof DshProfileConfigSchema>;

export const WorkspacePolicySchema = z
  .object({
    mode: WorkspaceModeSchema,
    allowed_roots: z.array(ShortTextSchema).max(64).default([]),
  })
  .strict();
export type WorkspacePolicy = z.infer<typeof WorkspacePolicySchema>;

export const ExecutionPolicySchema = z
  .object({
    network: NetworkPolicySchema,
    allowed_domains: z.array(ShortTextSchema).max(256).default([]),
    denied_paths: z.array(ShortTextSchema).max(256).default([]),
    timeout_seconds: PositiveIntSchema.max(86_400).default(1_800),
    max_artifact_bytes: PositiveIntSchema.max(1_073_741_824).default(10_485_760),
    max_output_bytes: PositiveIntSchema.max(1_073_741_824).default(10_485_760),
    max_files: PositiveIntSchema.max(100_000).default(10_000),
    disk_quota_bytes: PositiveIntSchema.max(1_099_511_627_776).default(1_073_741_824),
  })
  .strict();
export type ExecutionPolicy = z.infer<typeof ExecutionPolicySchema>;

export const ProfileCapabilitiesSchema = z
  .object({
    supports_followup: z.boolean(),
    supports_cancel: z.boolean(),
    supports_subagents: z.boolean(),
    supported_workspace_modes: z.array(WorkspaceModeSchema).min(1).max(2),
  })
  .strict();
export type ProfileCapabilities = z.infer<typeof ProfileCapabilitiesSchema>;

/** Safe routing limits returned to Codex without provider credentials or endpoints. */
export const DelegationSummarySchema = z
  .object({
    max_depth: NonNegativeIntSchema.max(32),
    max_children: NonNegativeIntSchema.max(128),
    roles: z.array(IdentifierSchema).max(32),
  })
  .strict();
export type DelegationSummary = z.infer<typeof DelegationSummarySchema>;

/** Profile fields shared by config documents and resolved wire profiles. */
export const ProfileDefinitionSchema = z
  .object({
    description: LongTextSchema,
    dsh: DshProfileConfigSchema,
    delegation: DelegationPolicySchema,
    workspace: WorkspacePolicySchema,
    policy: ExecutionPolicySchema,
    capabilities: ProfileCapabilitiesSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type ProfileDefinition = z.infer<typeof ProfileDefinitionSchema>;

/** Fully resolved profile definition used by the task engine. */
export const ProfileSchema = ProfileDefinitionSchema.extend({
  protocol_version: ProtocolVersionSchema,
  profile_id: ProfileIdSchema,
}).strict();
export type Profile = z.infer<typeof ProfileSchema>;

/** A safe summary returned by list_profiles; no internal endpoints or secrets. */
export const ProfileSummarySchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    profile_id: ProfileIdSchema,
    description: LongTextSchema,
    capabilities: ProfileCapabilitiesSchema,
    delegation: DelegationSummarySchema,
    max_tokens: PositiveIntSchema.max(1_000_000),
    timeout_seconds: PositiveIntSchema.max(86_400),
    workspace_modes: z.array(WorkspaceModeSchema).min(1).max(2),
  })
  .strict();
export type ProfileSummary = z.infer<typeof ProfileSummarySchema>;

export const ProfileRegistrySchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    profiles: z.array(ProfileSummarySchema).max(256),
  })
  .strict();
export type ProfileRegistry = z.infer<typeof ProfileRegistrySchema>;

export const ProfileConfigDocumentSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    profiles: z
      .record(ProfileIdSchema, ProfileDefinitionSchema)
      .refine(
        (profiles) => Object.keys(profiles).length <= 256,
        'profile document has too many profiles',
      ),
  })
  .strict();
export type ProfileConfigDocument = z.infer<typeof ProfileConfigDocumentSchema>;

export const DEFAULT_PROFILE_PROTOCOL_VERSION = PROTOCOL_VERSION;
