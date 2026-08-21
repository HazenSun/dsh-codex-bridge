import { z } from 'zod';

import {
  ArtifactIdSchema,
  IsoTimestampSchema,
  MediaTypeSchema,
  NonNegativeIntSchema,
  PositiveIntSchema,
  ProtocolVersionSchema,
  Sha256Schema,
  ShortTextSchema,
  TaskIdSchema,
} from './constants.js';

export const ArtifactKindSchema = z.enum([
  'patch',
  'diff_stat',
  'changed_files',
  'test_report',
  'command_log',
  'agent_log',
  'summary',
  'other',
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const ArtifactEncodingSchema = z.enum(['utf8', 'base64']);
export type ArtifactEncoding = z.infer<typeof ArtifactEncodingSchema>;

export const ArtifactRefSchema = z
  .object({
    artifact_id: ArtifactIdSchema,
    task_id: TaskIdSchema,
    kind: ArtifactKindSchema,
    name: ShortTextSchema,
    media_type: MediaTypeSchema,
    encoding: ArtifactEncodingSchema,
    bytes: NonNegativeIntSchema,
    sha256: Sha256Schema,
    uri: z.string().min(1).max(2_048),
    created_at: IsoTimestampSchema,
  })
  .strict();
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const ArtifactManifestSchema = z
  .object({
    artifacts: z.array(ArtifactRefSchema).max(1_024),
    total_bytes: NonNegativeIntSchema,
  })
  .strict();
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;

export const ReadTaskArtifactInputSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    task_id: TaskIdSchema,
    artifact_id: ArtifactIdSchema,
    offset: NonNegativeIntSchema,
    limit: PositiveIntSchema.max(1_048_576),
    expected_sha256: Sha256Schema.optional(),
  })
  .strict();
export type ReadTaskArtifactInput = z.infer<typeof ReadTaskArtifactInputSchema>;

export const ReadTaskArtifactOutputSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    artifact: ArtifactRefSchema,
    offset: NonNegativeIntSchema,
    data: z.string().max(1_048_576),
    next_offset: NonNegativeIntSchema,
    eof: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.eof && value.next_offset < value.offset) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['next_offset'],
        message: 'next_offset cannot move backwards at EOF',
      });
    }
  });
export type ReadTaskArtifactOutput = z.infer<typeof ReadTaskArtifactOutputSchema>;
