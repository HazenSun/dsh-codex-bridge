import { z } from 'zod';

import {
  IdentifierSchema,
  LongTextSchema,
  ModelIdSchema,
  ProfileIdSchema,
  ProtocolVersionSchema,
  ShortTextSchema,
} from './constants.js';
import { ProfileSchema } from './profile.js';

const ProfileUpdateSchema = z
  .object({
    description: LongTextSchema.optional(),
    dsh: ProfileSchema.shape.dsh.partial().strict().optional(),
    delegation: ProfileSchema.shape.delegation.partial().strict().optional(),
    workspace: ProfileSchema.shape.workspace.partial().strict().optional(),
    policy: ProfileSchema.shape.policy.partial().strict().optional(),
    capabilities: ProfileSchema.shape.capabilities.unwrap().partial().strict().optional(),
    metadata: ProfileSchema.shape.metadata.unwrap().optional(),
  })
  .strict();

export const ConfigRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export type ConfigRevision = z.infer<typeof ConfigRevisionSchema>;

export const SetupStateSchema = z.enum([
  'needs_dsh',
  'needs_dsh_profile',
  'needs_project_config',
  'needs_provider',
  'needs_execution_profile',
  'ready',
  'degraded',
  'upgrade_required',
]);
export type SetupState = z.infer<typeof SetupStateSchema>;

export const SetupCheckSchema = z
  .object({
    name: IdentifierSchema,
    status: z.enum(['ok', 'missing', 'invalid', 'skipped']),
    message: LongTextSchema.optional(),
  })
  .strict();
export type SetupCheck = z.infer<typeof SetupCheckSchema>;

export const SetupStatusSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    state: SetupStateSchema,
    config_path: LongTextSchema,
    config_revision: ConfigRevisionSchema.optional(),
    restart_required: z.boolean(),
    checks: z.array(SetupCheckSchema).max(32),
    next_actions: z.array(ShortTextSchema).max(16),
  })
  .strict();
export type SetupStatus = z.infer<typeof SetupStatusSchema>;

export const DshModelSummarySchema = z
  .object({
    model: ModelIdSchema,
    name: ShortTextSchema,
    description: LongTextSchema.optional(),
    input_modalities: z
      .array(z.enum(['text', 'image']))
      .max(2)
      .optional(),
    reasoning_efforts: z.array(IdentifierSchema).max(32).optional(),
    default_reasoning_effort: IdentifierSchema.optional(),
    context_window: z.number().int().positive().optional(),
    default_max_tokens: z.number().int().positive().optional(),
  })
  .strict();
export type DshModelSummary = z.infer<typeof DshModelSummarySchema>;

export const DshProviderSummarySchema = z
  .object({
    provider: IdentifierSchema,
    name: ShortTextSchema,
    configured: z.boolean(),
    models: z.array(DshModelSummarySchema).max(2048),
  })
  .strict();
export type DshProviderSummary = z.infer<typeof DshProviderSummarySchema>;

export const DshModelCatalogSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    providers: z.array(DshProviderSummarySchema).max(256),
  })
  .strict();
export type DshModelCatalog = z.infer<typeof DshModelCatalogSchema>;

export const ProfileChangeSchema = z
  .discriminatedUnion('operation', [
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
        profile_id: ProfileIdSchema,
        profile: ProfileSchema.optional(),
        changes: ProfileUpdateSchema.optional(),
      })
      .strict(),
    z
      .object({
        operation: z.literal('remove'),
        profile_id: ProfileIdSchema,
        replacement_default_profile_id: ProfileIdSchema.optional(),
      })
      .strict(),
    z
      .object({
        operation: z.literal('set_default'),
        project_id: IdentifierSchema,
        profile_id: ProfileIdSchema,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (
      value.operation === 'update' &&
      (value.profile === undefined) === (value.changes === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an update must provide exactly one of profile or changes',
        path: ['changes'],
      });
    }
    if (
      value.operation === 'update' &&
      value.profile !== undefined &&
      value.profile_id !== value.profile.profile_id
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'replacement profile_id must match profile.profile_id',
        path: ['profile', 'profile_id'],
      });
    }
  });
export type ProfileChange = z.infer<typeof ProfileChangeSchema>;

export const ProfileChangePreviewSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    config_path: LongTextSchema,
    before_revision: ConfigRevisionSchema,
    change: ProfileChangeSchema,
    summary: LongTextSchema,
    diff: LongTextSchema,
  })
  .strict();
export type ProfileChangePreview = z.infer<typeof ProfileChangePreviewSchema>;

export const ProfileChangeResultSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    config_path: LongTextSchema,
    previous_revision: ConfigRevisionSchema,
    config_revision: ConfigRevisionSchema,
    changed: z.boolean(),
    restart_required: z.boolean(),
  })
  .strict();
export type ProfileChangeResult = z.infer<typeof ProfileChangeResultSchema>;

export const RollbackConfigResultSchema = ProfileChangeResultSchema.extend({
  restored_from: ShortTextSchema,
}).strict();
export type RollbackConfigResult = z.infer<typeof RollbackConfigResultSchema>;
