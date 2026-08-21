import { z } from 'zod';

import {
  IdentifierSchema,
  IsoTimestampSchema,
  JsonObjectSchema,
  LongTextSchema,
  MetadataSchema,
  NonNegativeIntSchema,
  PercentageSchema,
  ProfileIdSchema,
  ProjectIdSchema,
  ProtocolVersionSchema,
  RunIdSchema,
  ShortTextSchema,
  TaskIdSchema,
  TraceIdSchema,
  WorkspaceIdSchema,
} from './constants.js';
import { BridgeErrorSchema, ProtocolError } from './errors.js';
import {
  DelegationDecisionSchema,
  DelegationEvidenceSchema,
  DelegationRequestSchema,
} from './delegation.js';

export const TaskStatus = {
  validating: 'validating',
  queued: 'queued',
  preparing_workspace: 'preparing_workspace',
  running: 'running',
  waiting_input: 'waiting_input',
  collecting: 'collecting',
  cancelling: 'cancelling',
  completed: 'completed',
  partial: 'partial',
  cancelled: 'cancelled',
  timed_out: 'timed_out',
  interrupted: 'interrupted',
  failed: 'failed',
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];
export const TaskStatusSchema = z.enum([
  TaskStatus.validating,
  TaskStatus.queued,
  TaskStatus.preparing_workspace,
  TaskStatus.running,
  TaskStatus.waiting_input,
  TaskStatus.collecting,
  TaskStatus.cancelling,
  TaskStatus.completed,
  TaskStatus.partial,
  TaskStatus.cancelled,
  TaskStatus.timed_out,
  TaskStatus.interrupted,
  TaskStatus.failed,
]);

export const TerminalTaskStatusSchema = z.enum([
  TaskStatus.completed,
  TaskStatus.partial,
  TaskStatus.cancelled,
  TaskStatus.timed_out,
  TaskStatus.interrupted,
  TaskStatus.failed,
]);
export type TerminalTaskStatus = z.infer<typeof TerminalTaskStatusSchema>;

/**
 * A terminal status closes the current run interval and makes its evidence
 * queryable. Completed, partial and failed tasks may still be continued: the
 * next run gets a fresh run_id while the previous result remains immutable.
 */
const transitionTargets: Record<TaskStatus, readonly TaskStatus[]> = {
  validating: [TaskStatus.queued, TaskStatus.failed],
  queued: [TaskStatus.preparing_workspace, TaskStatus.cancelled],
  preparing_workspace: [TaskStatus.running, TaskStatus.failed],
  running: [
    TaskStatus.waiting_input,
    TaskStatus.collecting,
    TaskStatus.cancelling,
    TaskStatus.timed_out,
    TaskStatus.interrupted,
  ],
  waiting_input: [TaskStatus.running],
  collecting: [TaskStatus.completed, TaskStatus.partial],
  cancelling: [TaskStatus.cancelled],
  completed: [TaskStatus.queued],
  partial: [TaskStatus.queued],
  cancelled: [],
  timed_out: [],
  interrupted: [TaskStatus.queued],
  failed: [TaskStatus.queued],
};

export const TASK_STATUS_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> =
  transitionTargets;

export function isTerminalTaskStatus(status: TaskStatus): status is TerminalTaskStatus {
  return TerminalTaskStatusSchema.safeParse(status).success;
}

export function canTransitionTaskStatus(from: TaskStatus, to: TaskStatus): boolean {
  return transitionTargets[from].includes(to);
}

export function assertTaskStatusTransition(
  from: TaskStatus,
  to: TaskStatus,
): asserts to is TaskStatus {
  if (!canTransitionTaskStatus(from, to)) {
    throw new ProtocolError(
      'TASK_INVALID_TRANSITION',
      `Task status cannot transition from ${from} to ${to}`,
      {
        details: { from, to },
      },
    );
  }
}

export const TaskOriginSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export type TaskOrigin = z.infer<typeof TaskOriginSchema>;

export const TaskAcceptanceCriterionSchema = z
  .object({
    criterion_id: IdentifierSchema,
    description: LongTextSchema,
  })
  .strict();
export type TaskAcceptanceCriterion = z.infer<typeof TaskAcceptanceCriterionSchema>;

export const TaskProgressSchema = z
  .object({
    message: ShortTextSchema.optional(),
    percent: PercentageSchema.optional(),
    updated_at: IsoTimestampSchema,
  })
  .strict();
export type TaskProgress = z.infer<typeof TaskProgressSchema>;

export const WorkspaceRequestSchema = z
  .object({
    mode: z.enum(['isolated_worktree', 'patch_only']).optional(),
    base_ref: IdentifierSchema.optional(),
  })
  .strict();
export type WorkspaceRequest = z.infer<typeof WorkspaceRequestSchema>;

export const TaskContextSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    task_id: TaskIdSchema,
    trace_id: TraceIdSchema,
    origin: TaskOriginSchema,
    delegation_depth: NonNegativeIntSchema.max(32),
    project_id: ProjectIdSchema,
    workspace_id: WorkspaceIdSchema,
    profile_id: ProfileIdSchema,
  })
  .strict();
export type TaskContext = z.infer<typeof TaskContextSchema>;

export const DelegateTaskInputSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    trace_id: TraceIdSchema.optional(),
    origin: TaskOriginSchema.optional(),
    delegation_depth: NonNegativeIntSchema.max(32).optional(),
    project_id: ProjectIdSchema,
    profile_id: ProfileIdSchema,
    objective: LongTextSchema,
    acceptance_criteria: z.array(LongTextSchema).max(128).default([]),
    workspace: WorkspaceRequestSchema.optional(),
    /** Optional Codex routing hints; omitted inputs retain v1alpha1 behavior. */
    delegation: DelegationRequestSchema.optional(),
    idempotency_key: IdentifierSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type DelegateTaskInput = z.infer<typeof DelegateTaskInputSchema>;

export const TaskSchema = z
  .object({
    ...TaskContextSchema.shape,
    objective: LongTextSchema,
    acceptance_criteria: z.array(LongTextSchema).max(128),
    status: TaskStatusSchema,
    run_id: RunIdSchema.optional(),
    created_at: IsoTimestampSchema,
    updated_at: IsoTimestampSchema,
    started_at: IsoTimestampSchema.optional(),
    finished_at: IsoTimestampSchema.optional(),
    progress: TaskProgressSchema.optional(),
    /** Original routing hints, when supplied by the Codex caller. */
    delegation: DelegationRequestSchema.optional(),
    /** Parsed single/multi decision and runtime evidence, when available. */
    delegation_decision: DelegationDecisionSchema.optional(),
    delegation_evidence: DelegationEvidenceSchema.optional(),
    error: BridgeErrorSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type Task = z.infer<typeof TaskSchema>;

export const TaskDispatchStatusSchema = z.enum([
  TaskStatus.validating,
  TaskStatus.queued,
  TaskStatus.preparing_workspace,
  TaskStatus.running,
]);
export type TaskDispatchStatus = z.infer<typeof TaskDispatchStatusSchema>;

export const TaskDispatchReceiptSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    task_id: TaskIdSchema,
    trace_id: TraceIdSchema,
    project_id: ProjectIdSchema,
    workspace_id: WorkspaceIdSchema,
    profile_id: ProfileIdSchema,
    status: TaskDispatchStatusSchema,
    created_at: IsoTimestampSchema,
  })
  .strict();
export type TaskDispatchReceipt = z.infer<typeof TaskDispatchReceiptSchema>;

export const GetTaskInputSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    task_id: TaskIdSchema,
  })
  .strict();
export type GetTaskInput = z.infer<typeof GetTaskInputSchema>;

export const GetTaskOutputSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    task: TaskSchema,
  })
  .strict();
export type GetTaskOutput = z.infer<typeof GetTaskOutputSchema>;

export const ContinueTaskInputSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    task_id: TaskIdSchema,
    feedback: LongTextSchema,
    acceptance_criteria: z.array(LongTextSchema).max(128).optional(),
    expected_run_id: RunIdSchema.optional(),
    idempotency_key: IdentifierSchema.optional(),
  })
  .strict();
export type ContinueTaskInput = z.infer<typeof ContinueTaskInputSchema>;

export const CancelTaskInputSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    task_id: TaskIdSchema,
    reason: ShortTextSchema.optional(),
  })
  .strict();
export type CancelTaskInput = z.infer<typeof CancelTaskInputSchema>;

export const TaskOperationReceiptSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    task_id: TaskIdSchema,
    trace_id: TraceIdSchema,
    status: TaskStatusSchema,
    accepted_at: IsoTimestampSchema,
  })
  .strict();
export type TaskOperationReceipt = z.infer<typeof TaskOperationReceiptSchema>;

export const TaskMetadataSchema = z
  .object({
    task_id: TaskIdSchema,
    run_id: RunIdSchema.optional(),
    metadata: JsonObjectSchema.optional(),
  })
  .strict();
export type TaskMetadata = z.infer<typeof TaskMetadataSchema>;
