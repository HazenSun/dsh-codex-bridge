import { z } from 'zod';

import {
  ReadTaskArtifactInputSchema,
  ReadTaskArtifactOutputSchema,
  type ReadTaskArtifactInput,
  type ReadTaskArtifactOutput,
} from './artifact.js';
import {
  IdentifierSchema,
  IsoTimestampSchema,
  NonNegativeIntSchema,
  ProtocolVersionSchema,
  PROTOCOL_VERSION,
  ShortTextSchema,
  TaskIdSchema,
} from './constants.js';
import { BridgeErrorSchema, type BridgeError } from './errors.js';
import { ProfileRegistrySchema, type ProfileRegistry } from './profile.js';
import {
  CancelTaskInputSchema,
  ContinueTaskInputSchema,
  DelegateTaskInputSchema,
  GetTaskInputSchema,
  GetTaskOutputSchema,
  TaskDispatchReceiptSchema,
  TaskOperationReceiptSchema,
  type CancelTaskInput,
  type ContinueTaskInput,
  type DelegateTaskInput,
  type GetTaskInput,
  type GetTaskOutput,
  type TaskDispatchReceipt,
  type TaskOperationReceipt,
} from './task.js';
import { GetTaskResultOutputSchema, type GetTaskResultOutput } from './result.js';
import {
  ConfigRevisionSchema,
  DshModelCatalogSchema,
  ProfileChangePreviewSchema,
  ProfileChangeResultSchema,
  ProfileChangeSchema,
  RollbackConfigResultSchema,
  SetupStatusSchema,
  type DshModelCatalog,
  type ProfileChangePreview,
  type ProfileChangeResult,
  type RollbackConfigResult,
  type SetupStatus,
} from './setup.js';

export const GetSetupStatusInputSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
  })
  .strict();
export type GetSetupStatusInput = z.infer<typeof GetSetupStatusInputSchema>;
export const GetSetupStatusOutputSchema = SetupStatusSchema;
export type GetSetupStatusOutput = SetupStatus;

export const DiscoverDshModelsInputSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    provider: IdentifierSchema.optional(),
    include_details: z.boolean().optional(),
  })
  .strict();
export type DiscoverDshModelsInput = z.infer<typeof DiscoverDshModelsInputSchema>;
export const DiscoverDshModelsOutputSchema = DshModelCatalogSchema;
export type DiscoverDshModelsOutput = DshModelCatalog;

export const PreviewProfileChangeInputSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    change: ProfileChangeSchema,
  })
  .strict();
export type PreviewProfileChangeInput = z.infer<typeof PreviewProfileChangeInputSchema>;
export const PreviewProfileChangeOutputSchema = ProfileChangePreviewSchema;
export type PreviewProfileChangeOutput = ProfileChangePreview;

export const ApplyProfileChangeInputSchema = PreviewProfileChangeInputSchema.extend({
  expected_revision: ConfigRevisionSchema,
}).strict();
export type ApplyProfileChangeInput = z.infer<typeof ApplyProfileChangeInputSchema>;
export const ApplyProfileChangeOutputSchema = ProfileChangeResultSchema;
export type ApplyProfileChangeOutput = ProfileChangeResult;

export const RollbackProfileChangeInputSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    expected_revision: ConfigRevisionSchema,
  })
  .strict();
export type RollbackProfileChangeInput = z.infer<typeof RollbackProfileChangeInputSchema>;
export const RollbackProfileChangeOutputSchema = RollbackConfigResultSchema;
export type RollbackProfileChangeOutput = RollbackConfigResult;

export const ListProfilesInputSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    include_capabilities: z.boolean().optional(),
  })
  .strict();
export type ListProfilesInput = z.infer<typeof ListProfilesInputSchema>;

export const ListProfilesOutputSchema = ProfileRegistrySchema;
export type ListProfilesOutput = ProfileRegistry;

export const DelegateTaskOutputSchema = TaskDispatchReceiptSchema;
export type DelegateTaskOutput = TaskDispatchReceipt;

export const GetTaskResultInputSchema = GetTaskInputSchema;
export type GetTaskResultInput = GetTaskInput;

export const ContinueTaskOutputSchema = TaskDispatchReceiptSchema;
export type ContinueTaskOutput = TaskDispatchReceipt;

export const CancelTaskOutputSchema = TaskOperationReceiptSchema;
export type CancelTaskOutput = TaskOperationReceipt;

export const ReadArtifactOutputSchema = ReadTaskArtifactOutputSchema;
export type ReadArtifactOutput = ReadTaskArtifactOutput;

export const McpErrorOutputSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    error: BridgeErrorSchema,
  })
  .strict();
export type McpErrorOutput = z.infer<typeof McpErrorOutputSchema>;

export const WaitTaskInputSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    task_id: TaskIdSchema,
    timeout_seconds: z.number().int().min(0).max(30),
  })
  .strict();
export type WaitTaskInput = z.infer<typeof WaitTaskInputSchema>;

export const WaitTaskOutputSchema = GetTaskOutputSchema;
export type WaitTaskOutput = GetTaskOutput;

export const CleanupTaskInputSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    task_id: TaskIdSchema,
    retain_artifacts: z.boolean().optional(),
  })
  .strict();
export type CleanupTaskInput = z.infer<typeof CleanupTaskInputSchema>;

export const CleanupTaskOutputSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    task_id: TaskIdSchema,
    cleaned: z.boolean(),
    artifacts_retained: z.boolean(),
    cleaned_at: IsoTimestampSchema,
  })
  .strict();
export type CleanupTaskOutput = z.infer<typeof CleanupTaskOutputSchema>;

export const DoctorInputSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
  })
  .strict();
export type DoctorInput = z.infer<typeof DoctorInputSchema>;

export const DoctorCheckStatusSchema = z.enum(['ok', 'degraded', 'failed', 'skipped']);
export type DoctorCheckStatus = z.infer<typeof DoctorCheckStatusSchema>;

export const DoctorCheckSchema = z
  .object({
    name: IdentifierSchema,
    status: DoctorCheckStatusSchema,
    message: ShortTextSchema.optional(),
    latency_ms: NonNegativeIntSchema.optional(),
  })
  .strict();
export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;

export const DoctorOutputSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    status: z.enum(['healthy', 'degraded', 'unavailable']),
    checks: z.array(DoctorCheckSchema).max(64),
    generated_at: IsoTimestampSchema,
  })
  .strict();
export type DoctorOutput = z.infer<typeof DoctorOutputSchema>;

/**
 * Tool schemas are exported as a named registry so MCP adapters can bind them
 * without inventing a second source of truth for request/response validation.
 */
export const MCP_TOOL_SCHEMAS = {
  get_setup_status: {
    input: GetSetupStatusInputSchema,
    output: GetSetupStatusOutputSchema,
  },
  discover_dsh_models: {
    input: DiscoverDshModelsInputSchema,
    output: DiscoverDshModelsOutputSchema,
  },
  preview_profile_change: {
    input: PreviewProfileChangeInputSchema,
    output: PreviewProfileChangeOutputSchema,
  },
  apply_profile_change: {
    input: ApplyProfileChangeInputSchema,
    output: ApplyProfileChangeOutputSchema,
  },
  rollback_profile_change: {
    input: RollbackProfileChangeInputSchema,
    output: RollbackProfileChangeOutputSchema,
  },
  list_profiles: {
    input: ListProfilesInputSchema,
    output: ListProfilesOutputSchema,
  },
  delegate_task: {
    input: DelegateTaskInputSchema,
    output: DelegateTaskOutputSchema,
  },
  get_task: {
    input: GetTaskInputSchema,
    output: GetTaskOutputSchema,
  },
  get_task_result: {
    input: GetTaskResultInputSchema,
    output: GetTaskResultOutputSchema,
  },
  read_task_artifact: {
    input: ReadTaskArtifactInputSchema,
    output: ReadTaskArtifactOutputSchema,
  },
  continue_task: {
    input: ContinueTaskInputSchema,
    output: ContinueTaskOutputSchema,
  },
  cancel_task: {
    input: CancelTaskInputSchema,
    output: CancelTaskOutputSchema,
  },
  wait_task: {
    input: WaitTaskInputSchema,
    output: WaitTaskOutputSchema,
  },
  cleanup_task: {
    input: CleanupTaskInputSchema,
    output: CleanupTaskOutputSchema,
  },
  doctor: {
    input: DoctorInputSchema,
    output: DoctorOutputSchema,
  },
} as const;

export type McpToolName = keyof typeof MCP_TOOL_SCHEMAS;

export type McpToolInputMap = {
  get_setup_status: GetSetupStatusInput;
  discover_dsh_models: DiscoverDshModelsInput;
  preview_profile_change: PreviewProfileChangeInput;
  apply_profile_change: ApplyProfileChangeInput;
  rollback_profile_change: RollbackProfileChangeInput;
  list_profiles: ListProfilesInput;
  delegate_task: DelegateTaskInput;
  get_task: GetTaskInput;
  get_task_result: GetTaskResultInput;
  read_task_artifact: ReadTaskArtifactInput;
  continue_task: ContinueTaskInput;
  cancel_task: CancelTaskInput;
  wait_task: WaitTaskInput;
  cleanup_task: CleanupTaskInput;
  doctor: DoctorInput;
};

export type McpToolOutputMap = {
  get_setup_status: GetSetupStatusOutput;
  discover_dsh_models: DiscoverDshModelsOutput;
  preview_profile_change: PreviewProfileChangeOutput;
  apply_profile_change: ApplyProfileChangeOutput;
  rollback_profile_change: RollbackProfileChangeOutput;
  list_profiles: ListProfilesOutput;
  delegate_task: DelegateTaskOutput;
  get_task: GetTaskOutput;
  get_task_result: GetTaskResultOutput;
  read_task_artifact: ReadArtifactOutput;
  continue_task: ContinueTaskOutput;
  cancel_task: CancelTaskOutput;
  wait_task: WaitTaskOutput;
  cleanup_task: CleanupTaskOutput;
  doctor: DoctorOutput;
};

export function makeMcpErrorOutput(error: BridgeError): McpErrorOutput {
  return McpErrorOutputSchema.parse({
    protocol_version: PROTOCOL_VERSION,
    error,
  });
}
