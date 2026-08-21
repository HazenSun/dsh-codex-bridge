import { z } from 'zod';

import {
  IdentifierSchema,
  IsoTimestampSchema,
  LongTextSchema,
  NonNegativeIntSchema,
  ShortTextSchema,
  TaskIdSchema,
} from './constants.js';

/**
 * The strategy requested by the host. `auto` leaves the single-vs-multi
 * decision to the host/bridge router; the other values are explicit user
 * overrides.
 */
export const DelegationStrategy = {
  auto: 'auto',
  single: 'single',
  multi: 'multi',
} as const;
export type DelegationStrategy = (typeof DelegationStrategy)[keyof typeof DelegationStrategy];
export const DelegationStrategySchema = z.enum([
  DelegationStrategy.auto,
  DelegationStrategy.single,
  DelegationStrategy.multi,
]);

/** A strategy after `auto` has been resolved into an execution plan. */
export const ResolvedDelegationStrategySchema = z.enum([
  DelegationStrategy.single,
  DelegationStrategy.multi,
]);
export type ResolvedDelegationStrategy = z.infer<typeof ResolvedDelegationStrategySchema>;

/** Role identifiers are resolved against the selected Profile's role map. */
export const DelegationRoleIdSchema = IdentifierSchema;
export type DelegationRoleId = z.infer<typeof DelegationRoleIdSchema>;

const UniqueRoleIdsSchema = z
  .array(DelegationRoleIdSchema)
  .max(32)
  .superRefine((roles, context) => {
    if (new Set(roles).size !== roles.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'delegation roles must be unique',
      });
    }
  });

/**
 * Optional Codex routing hints carried by `delegate_task`.
 *
 * The field itself remains optional so v1alpha1 callers that predate the
 * routing contract continue to validate. When present, omitted strategy and
 * roles normalize to the safe automatic/empty values.
 */
export const DelegationRequestSchema = z
  .object({
    strategy: DelegationStrategySchema.default(DelegationStrategy.auto),
    reason: ShortTextSchema.optional(),
    roles: UniqueRoleIdsSchema.default([]),
  })
  .strict();
export type DelegationRequest = z.infer<typeof DelegationRequestSchema>;

/** Normalize an omitted legacy routing block to the automatic strategy. */
export function normalizeDelegationRequest(
  request?: z.input<typeof DelegationRequestSchema>,
): DelegationRequest {
  return DelegationRequestSchema.parse(request ?? {});
}

export const DelegationDecisionSourceSchema = z.enum(['codex', 'bridge', 'dsh']);
export type DelegationDecisionSource = z.infer<typeof DelegationDecisionSourceSchema>;

/**
 * The parsed decision recorded by the bridge. `strategy` is the original
 * request (including `auto`), while `resolved_strategy` is the strategy that
 * was actually selected. Keeping both makes automatic routing auditable.
 */
export const DelegationDecisionSchema = z
  .object({
    strategy: DelegationStrategySchema,
    resolved_strategy: ResolvedDelegationStrategySchema,
    reason: LongTextSchema,
    roles: UniqueRoleIdsSchema,
    decided_by: DelegationDecisionSourceSchema,
    decided_at: IsoTimestampSchema,
  })
  .strict()
  .superRefine((decision, context) => {
    if (
      decision.strategy !== DelegationStrategy.auto &&
      decision.strategy !== decision.resolved_strategy
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resolved_strategy'],
        message: 'resolved_strategy must match an explicit strategy request',
      });
    }
  });
export type DelegationDecision = z.infer<typeof DelegationDecisionSchema>;

/** Normalized form of the runtime's observed sub-agent/tool counters. */
export const DelegationObservedEvidenceSchema = z
  .object({
    subagent_calls: NonNegativeIntSchema.max(128),
    tool_names: z.array(ShortTextSchema).max(256),
  })
  .strict();
export type DelegationObservedEvidence = z.infer<typeof DelegationObservedEvidenceSchema>;

/**
 * Runtime evidence for a parsed decision. Child ids and counts are retained
 * on the public wire so a caller can verify that a requested multi-agent plan
 * actually spawned and completed work.
 */
export const DelegationEvidenceSchema = z
  .object({
    children_requested: NonNegativeIntSchema.max(128),
    children_completed: NonNegativeIntSchema.max(128),
    children_failed: NonNegativeIntSchema.max(128).default(0),
    child_task_ids: z.array(TaskIdSchema).max(128).default([]),
    roles: UniqueRoleIdsSchema.default([]),
    observed: DelegationObservedEvidenceSchema.optional(),
    source: DelegationDecisionSourceSchema,
    summary: ShortTextSchema.optional(),
    recorded_at: IsoTimestampSchema,
  })
  .strict()
  .superRefine((evidence, context) => {
    if (evidence.children_completed + evidence.children_failed > evidence.children_requested) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['children_completed'],
        message: 'completed and failed children cannot exceed children_requested',
      });
    }
    if (evidence.child_task_ids.length > evidence.children_requested) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['child_task_ids'],
        message: 'child_task_ids cannot exceed children_requested',
      });
    }
  });
export type DelegationEvidence = z.infer<typeof DelegationEvidenceSchema>;
