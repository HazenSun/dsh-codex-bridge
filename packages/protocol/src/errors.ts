import { z } from 'zod';

import {
  JsonObjectSchema,
  type JsonObject,
  ProtocolVersionSchema,
  PROTOCOL_VERSION,
} from './constants.js';

/** Stable machine-readable errors exposed by every Bridge host adapter. */
export const BridgeErrorCodeSchema = z.enum([
  'INVALID_REQUEST',
  'UNSUPPORTED_PROTOCOL_VERSION',
  'PROFILE_NOT_FOUND',
  'PROFILE_INVALID',
  'PROJECT_NOT_FOUND',
  'WORKSPACE_NOT_ALLOWED',
  'WORKSPACE_NOT_FOUND',
  'WORKSPACE_BUSY',
  'TASK_NOT_FOUND',
  'TASK_INVALID_TRANSITION',
  'TASK_ALREADY_TERMINAL',
  'TASK_ALREADY_RUNNING',
  'TASK_CANCELLED',
  'TASK_TIMED_OUT',
  'TASK_INTERRUPTED',
  'ARTIFACT_NOT_FOUND',
  'ARTIFACT_RANGE_INVALID',
  'ARTIFACT_HASH_MISMATCH',
  'ARTIFACT_TOO_LARGE',
  'MODEL_NOT_FOUND',
  'REASONING_UNSUPPORTED',
  'RATE_LIMITED',
  'BACKEND_UNAVAILABLE',
  'BACKEND_ERROR',
  'PERMISSION_DENIED',
  'RECURSION_LIMIT',
  'RESOURCE_LIMIT',
  'INTERNAL_ERROR',
]);
export type BridgeErrorCode = z.infer<typeof BridgeErrorCodeSchema>;

export const BridgeErrorSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    code: BridgeErrorCodeSchema,
    message: z.string().min(1).max(4_096),
    retryable: z.boolean(),
    details: JsonObjectSchema.optional(),
  })
  .strict();
export type BridgeError = z.infer<typeof BridgeErrorSchema>;

export type ProtocolErrorOptions = {
  retryable?: boolean;
  details?: JsonObject;
  cause?: unknown;
};

/**
 * Error type used at package boundaries. It can be serialised without leaking
 * provider credentials or host-specific exception objects.
 */
export class ProtocolError extends Error {
  readonly code: BridgeErrorCode;
  readonly retryable: boolean;
  readonly details?: JsonObject;

  constructor(code: BridgeErrorCode, message: string, options: ProtocolErrorOptions = {}) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.details !== undefined) {
      this.details = options.details;
    }
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  toJSON(): BridgeError {
    const error: BridgeError = {
      protocol_version: PROTOCOL_VERSION,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.details !== undefined) {
      error.details = this.details;
    }
    return BridgeErrorSchema.parse(error);
  }

  static fromZodError(error: z.ZodError): ProtocolError {
    const details: JsonObject = {
      issues: error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.map((segment) => String(segment)),
        message: issue.message,
      })),
    };
    return new ProtocolError('INVALID_REQUEST', 'Protocol validation failed', { details });
  }
}

/** Parse a wire value and normalise validation failures to ProtocolError. */
export function parseProtocol<Output>(schema: z.ZodType<Output>, value: unknown): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw ProtocolError.fromZodError(parsed.error);
  }
  return parsed.data;
}

export function isProtocolError(error: unknown): error is ProtocolError {
  return error instanceof ProtocolError;
}

/** Convert arbitrary adapter failures to a safe, stable wire error. */
export function toProtocolError(error: unknown): ProtocolError {
  if (error instanceof ProtocolError) {
    return error;
  }
  if (error instanceof z.ZodError) {
    return ProtocolError.fromZodError(error);
  }
  const message = error instanceof Error ? error.message : 'Unexpected protocol failure';
  return new ProtocolError('INTERNAL_ERROR', message, { cause: error });
}
