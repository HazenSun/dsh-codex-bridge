import { z } from 'zod';

import { ArtifactManifestSchema } from './artifact.js';
import {
  ArtifactIdSchema,
  IsoTimestampSchema,
  NonNegativeFiniteNumberSchema,
  NonNegativeIntSchema,
  ProtocolVersionSchema,
  RunIdSchema,
  ShortTextSchema,
  TaskIdSchema,
  TraceIdSchema,
} from './constants.js';
import { BridgeErrorSchema } from './errors.js';
import { DelegationDecisionSchema, DelegationEvidenceSchema } from './delegation.js';
import { TerminalTaskStatusSchema } from './task.js';

export const FileChangeStatusSchema = z.enum([
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'type_changed',
  'untracked',
]);
export type FileChangeStatus = z.infer<typeof FileChangeStatusSchema>;

export const ChangedFileSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    status: FileChangeStatusSchema,
    additions: NonNegativeIntSchema,
    deletions: NonNegativeIntSchema,
    binary: z.boolean(),
    previous_path: z.string().min(1).max(4_096).optional(),
  })
  .strict();
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

export const DiffStatSchema = z
  .object({
    files_changed: NonNegativeIntSchema,
    insertions: NonNegativeIntSchema,
    deletions: NonNegativeIntSchema,
    binary_files: NonNegativeIntSchema,
  })
  .strict();
export type DiffStat = z.infer<typeof DiffStatSchema>;

export const AcceptanceResultSchema = z
  .object({
    criterion: ShortTextSchema,
    passed: z.boolean(),
    evidence: ShortTextSchema.optional(),
  })
  .strict();
export type AcceptanceResult = z.infer<typeof AcceptanceResultSchema>;

export const TestStatusSchema = z.enum(['passed', 'failed', 'skipped', 'not_run']);
export type TestStatus = z.infer<typeof TestStatusSchema>;

export const TestSummarySchema = z
  .object({
    name: ShortTextSchema,
    status: TestStatusSchema,
    command: ShortTextSchema.optional(),
    duration_ms: NonNegativeIntSchema.optional(),
    total: NonNegativeIntSchema.optional(),
    passed: NonNegativeIntSchema.optional(),
    failed: NonNegativeIntSchema.optional(),
    skipped: NonNegativeIntSchema.optional(),
    report_artifact_id: ArtifactIdSchema.optional(),
  })
  .strict();
export type TestSummary = z.infer<typeof TestSummarySchema>;

export const ProviderUsageSchema = z
  .object({
    provider: ShortTextSchema,
    model: ShortTextSchema,
    input_tokens: NonNegativeIntSchema.optional(),
    output_tokens: NonNegativeIntSchema.optional(),
    total_tokens: NonNegativeIntSchema.optional(),
    cost_usd: NonNegativeFiniteNumberSchema.optional(),
  })
  .strict();
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;

export const UsageSummarySchema = z
  .object({
    input_tokens: NonNegativeIntSchema.optional(),
    output_tokens: NonNegativeIntSchema.optional(),
    total_tokens: NonNegativeIntSchema.optional(),
    cost_usd: NonNegativeFiniteNumberSchema.optional(),
    providers: z.array(ProviderUsageSchema).max(128),
  })
  .strict();
export type UsageSummary = z.infer<typeof UsageSummarySchema>;

export const TaskResultSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    task_id: TaskIdSchema,
    run_id: RunIdSchema,
    trace_id: TraceIdSchema,
    status: TerminalTaskStatusSchema,
    summary: z.string().min(1).max(100_000),
    acceptance: z.array(AcceptanceResultSchema).max(128),
    changed_files: z.array(ChangedFileSchema).max(100_000),
    diff_stat: DiffStatSchema,
    tests: z.array(TestSummarySchema).max(256),
    warnings: z.array(ShortTextSchema).max(256),
    artifacts: ArtifactManifestSchema,
    /** Parsed routing decision and observed execution evidence, if present. */
    delegation_decision: DelegationDecisionSchema.optional(),
    delegation_evidence: DelegationEvidenceSchema.optional(),
    usage: UsageSummarySchema.optional(),
    started_at: IsoTimestampSchema.optional(),
    completed_at: IsoTimestampSchema,
    error: BridgeErrorSchema.optional(),
  })
  .strict();
export type TaskResult = z.infer<typeof TaskResultSchema>;

/** A narrow result envelope for MCP callers that want versioning explicit. */
export const GetTaskResultOutputSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    result: TaskResultSchema,
  })
  .strict();
export type GetTaskResultOutput = z.infer<typeof GetTaskResultOutputSchema>;

export function hasFailedAcceptance(result: Pick<TaskResult, 'acceptance'>): boolean {
  return result.acceptance.some((criterion) => !criterion.passed);
}

export function hasFailedTests(result: Pick<TaskResult, 'tests'>): boolean {
  return result.tests.some((test) => test.status === 'failed');
}
