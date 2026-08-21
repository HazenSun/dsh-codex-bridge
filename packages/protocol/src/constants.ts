import { z } from 'zod';

/** The only protocol version implemented by this package. */
export const PROTOCOL_VERSION = 'bridge.dsh.dev/v1alpha1' as const;

/** A versioned wire value shared by every request, response and record. */
export const ProtocolVersionSchema = z.literal(PROTOCOL_VERSION);
export type ProtocolVersion = z.infer<typeof ProtocolVersionSchema>;

/**
 * Host-neutral identifiers deliberately permit provider-specific prefixes,
 * while excluding whitespace and path separators.
 */
export const IdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'must be a safe protocol identifier');
export type Identifier = z.infer<typeof IdentifierSchema>;

export const ProfileIdSchema = IdentifierSchema;
export type ProfileId = z.infer<typeof ProfileIdSchema>;

/**
 * Provider-owned model ids may contain catalog namespaces such as
 * `vendor/model` while remaining bounded, printable and safe to serialize.
 * Model ids are never used as filesystem paths by the Bridge.
 */
export const ModelIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/, 'must be a safe provider-owned model identifier');
export type ModelId = z.infer<typeof ModelIdSchema>;

export const TaskIdSchema = IdentifierSchema;
export type TaskId = z.infer<typeof TaskIdSchema>;

export const RunIdSchema = IdentifierSchema;
export type RunId = z.infer<typeof RunIdSchema>;

export const TraceIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'must be a safe trace identifier');
export type TraceId = z.infer<typeof TraceIdSchema>;

export const ProjectIdSchema = IdentifierSchema;
export type ProjectId = z.infer<typeof ProjectIdSchema>;

export const WorkspaceIdSchema = IdentifierSchema;
export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;

export const ArtifactIdSchema = IdentifierSchema;
export type ArtifactId = z.infer<typeof ArtifactIdSchema>;

export const NonEmptyTextSchema = z.string().trim().min(1);
export const ShortTextSchema = NonEmptyTextSchema.max(4_096);
export const LongTextSchema = NonEmptyTextSchema.max(100_000);

export const NonNegativeIntSchema = z.number().int().nonnegative();
export const PositiveIntSchema = z.number().int().positive();
export const NonNegativeFiniteNumberSchema = z.number().finite().nonnegative();

export const PercentageSchema = z.number().int().min(0).max(100);

export const IsoTimestampSchema = z.string().datetime({ offset: true });
export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;

export const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256 hex digest');
export type Sha256 = z.infer<typeof Sha256Schema>;

export const MediaTypeSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9!#$%&'*+.^_`|~-]*\/[A-Za-z0-9][A-Za-z0-9!#$%&'*+.^_`|~-]*(?:;.*)?$/,
  );
export type MediaType = z.infer<typeof MediaTypeSchema>;

export const JsonPrimitiveSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export type JsonPrimitive = z.infer<typeof JsonPrimitiveSchema>;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Recursive JSON schema used for safe, serialisable error details/metadata. */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonPrimitiveSchema, z.array(JsonValueSchema), z.record(JsonValueSchema)]),
);

export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(JsonValueSchema);

export const MetadataSchema = z
  .record(JsonValueSchema)
  .refine((value) => Object.keys(value).length <= 64, 'metadata has too many keys');
