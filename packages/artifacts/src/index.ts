import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, lstat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The version of the manifest written by this package. */
export const ARTIFACT_MANIFEST_API_VERSION = 'bridge.dsh.dev/v1alpha1' as const;

/** The default per-artifact limit (10 MiB), matching the bridge profile baseline. */
export const DEFAULT_MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

/** The default aggregate task limit (100 MiB). */
export const DEFAULT_MAX_TASK_BYTES = 100 * 1024 * 1024;

const TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_PROTOCOL_DATA_CHARS = 1_048_576;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });
export type ArtifactBytes = string | Uint8Array;

export const ARTIFACT_PROTOCOL_VERSION = ARTIFACT_MANIFEST_API_VERSION;
export type ArtifactKind =
  | 'patch'
  | 'diff_stat'
  | 'changed_files'
  | 'test_report'
  | 'command_log'
  | 'agent_log'
  | 'summary'
  | 'other';
export type ArtifactEncoding = 'utf8' | 'base64';

export interface ArtifactStoreOptions {
  /** Directory under which task manifests and content objects are stored. */
  readonly rootDir?: string;
  /** Compatibility alias for the protocol/task-engine constructor shape. */
  readonly root?: string;
  /** Maximum size accepted for one redacted artifact. */
  readonly maxArtifactBytes?: number;
  /** Maximum aggregate size of all artifacts referenced by one task. */
  readonly maxTaskBytes?: number;
  /** Enable the conservative text-field redactor. Defaults to true. */
  readonly redactSensitiveFields?: boolean;
  /** Additional case-insensitive field names to redact. */
  readonly sensitiveFields?: readonly string[];
}

export interface PutArtifactOptions {
  /** Stable protocol category, e.g. `patch`, `test-report`, or `log`. */
  readonly kind?: ArtifactKind;
  /** MIME type stored in the manifest. */
  readonly mediaType?: string;
  /** Optional human-readable description. */
  readonly description?: string;
  /** Disable redaction for this artifact only. Defaults to the store setting. */
  readonly redactSensitiveFields?: boolean;
  /** Replace an existing artifact with the same logical path. Defaults to true. */
  readonly replaceExisting?: boolean;
}

export interface ArtifactRef {
  readonly artifact_id: string;
  readonly task_id: string;
  readonly kind: ArtifactKind;
  readonly name: string;
  readonly media_type: string;
  readonly encoding: ArtifactEncoding;
  readonly bytes: number;
  readonly sha256: string;
  readonly uri: string;
  readonly created_at: string;
}

export interface ArtifactDescriptor extends ArtifactRef {
  /** SHA-256 of the bytes persisted in the content-addressed object store. */
  readonly artifactId: string;
  readonly taskId: string;
  /** A safe, task-local logical path such as `patch.diff` or `tests/unit.log`. */
  readonly path: string;
  readonly mediaType: string;
  readonly description?: string;
  readonly sizeBytes: number;
  /** Protocol-friendly alias for `sizeBytes`. */
  readonly byteLength: number;
  readonly createdAt: string;
  readonly redactionApplied: boolean;
}

/** Protocol-facing input accepted by `put(taskId, artifact)`. */
export interface ArtifactInput {
  readonly kind: ArtifactKind;
  readonly name: string;
  readonly mediaType: string;
  readonly description?: string;
  readonly data: ArtifactBytes;
  readonly redactSensitiveFields?: boolean;
}

export interface ArtifactManifest {
  readonly artifacts: readonly ArtifactRef[];
  readonly total_bytes: number;
}

export interface ArtifactReadOptions {
  /** Zero-based byte offset. `start` is accepted as an alias. */
  readonly offset?: number;
  readonly start?: number;
  /** Number of bytes to return. Defaults to the remaining artifact. */
  readonly limit?: number;
  /** Exclusive byte end. This is useful for HTTP-style range handling. */
  readonly end?: number;
  /** Decode the returned bytes as UTF-8 in addition to returning `bytes`. */
  readonly encoding?: 'buffer' | 'utf8';
  /** Verify the persisted object against this digest before returning bytes. */
  readonly expectedSha256?: string;
}

export interface ArtifactReadResult {
  readonly protocol_version: typeof ARTIFACT_PROTOCOL_VERSION;
  readonly artifact: ArtifactRef;
  readonly artifactId: string;
  readonly bytes: Uint8Array;
  /** Protocol field: UTF-8 for text artifacts, base64 for binary artifacts. */
  readonly data: string;
  readonly text?: string;
  readonly offset: number;
  readonly next_offset: number;
  readonly end: number;
  readonly totalBytes: number;
  readonly eof: boolean;
}

export interface StoredArtifact {
  readonly descriptor: ArtifactDescriptor;
  readonly manifest: ArtifactManifest;
}

export class ArtifactStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ArtifactStoreError';
    this.code = code;
  }
}

export class ArtifactPathError extends ArtifactStoreError {
  constructor(path: string) {
    super('ARTIFACT_PATH_INVALID', `Artifact path must be a safe relative path: ${path}`);
    this.name = 'ArtifactPathError';
  }
}

export class ArtifactTaskIdError extends ArtifactStoreError {
  constructor(taskId: string) {
    super('TASK_ID_INVALID', `Task ID is not a safe storage key: ${taskId}`);
    this.name = 'ArtifactTaskIdError';
  }
}

export class ArtifactNotFoundError extends ArtifactStoreError {
  constructor(taskId: string, reference: string) {
    super('ARTIFACT_NOT_FOUND', `Artifact ${reference} was not found for task ${taskId}`);
    this.name = 'ArtifactNotFoundError';
  }
}

export class ArtifactSizeLimitError extends ArtifactStoreError {
  readonly limitBytes: number;
  readonly actualBytes: number;

  constructor(scope: 'artifact' | 'task', actualBytes: number, limitBytes: number) {
    super(
      scope === 'artifact' ? 'ARTIFACT_SIZE_LIMIT' : 'TASK_SIZE_LIMIT',
      `${scope === 'artifact' ? 'Artifact' : 'Task'} size ${actualBytes} bytes exceeds the ${limitBytes}-byte limit`,
    );
    this.name = 'ArtifactSizeLimitError';
    this.limitBytes = limitBytes;
    this.actualBytes = actualBytes;
  }
}

export class ArtifactRangeError extends ArtifactStoreError {
  constructor(offset: number, end: number, totalBytes: number) {
    super(
      'ARTIFACT_RANGE_INVALID',
      `Artifact byte range [${offset}, ${end}) is outside 0..${totalBytes}`,
    );
    this.name = 'ArtifactRangeError';
  }
}

export class ArtifactStoreIntegrityError extends ArtifactStoreError {
  constructor(path: string, message: string) {
    super('ARTIFACT_INTEGRITY_ERROR', `${message}: ${path}`);
    this.name = 'ArtifactStoreIntegrityError';
  }
}

interface InternalArtifactDescriptor extends ArtifactDescriptor {
  readonly description?: string;
}

interface StoredManifest {
  readonly apiVersion: typeof ARTIFACT_MANIFEST_API_VERSION;
  readonly kind: 'ArtifactManifest';
  readonly taskId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly totalBytes: number;
  readonly artifacts: readonly InternalArtifactDescriptor[];
}

type TaskOperation<T> = () => Promise<T>;

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ArtifactStoreError('CONFIG_INVALID', `${name} must be a positive safe integer`);
  }
}

function assertTaskId(taskId: string): void {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new ArtifactTaskIdError(taskId);
  }
}

function normalizeArtifactPath(value: string): string {
  if (
    value.length === 0 ||
    value.includes('\0') ||
    value.includes('\\') ||
    isAbsolute(value) ||
    /^[a-zA-Z]:/.test(value)
  ) {
    throw new ArtifactPathError(value);
  }

  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new ArtifactPathError(value);
  }

  const normalized = segments.join('/');
  if (normalized !== value || normalized.startsWith('../') || normalized === '..') {
    throw new ArtifactPathError(value);
  }
  return normalized;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isLikelyText(bytes: Uint8Array): boolean {
  const sampleLength = Math.min(bytes.byteLength, 8 * 1024);
  for (let index = 0; index < sampleLength; index += 1) {
    if (bytes[index] === 0) return false;
  }
  return true;
}

function redactionFieldPattern(fields: readonly string[]): RegExp {
  const escaped = fields
    .filter((field) => field.length > 0)
    .map((field) => field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return new RegExp(
    `(^|[\\s,{[])(["']?(?:${escaped})["']?)(\\s*[:=]\\s*)(["']?)([^\\r\\n,}]+?)(\\4)(?=\\s*(?:[,}]|$))`,
    'gim',
  );
}

function redactText(text: string, fields: readonly string[]): { text: string; changed: boolean } {
  const fieldPattern = redactionFieldPattern(fields);
  let changed = false;
  let result = text.replace(
    fieldPattern,
    (_match, prefix: string, key: string, separator: string, quote: string) => {
      changed = true;
      return `${prefix}${key}${separator}${quote}[REDACTED]${quote}`;
    },
  );

  // Header-style credentials (notably `Authorization: Bearer ...`) are common
  // in logs and do not have a JSON-like trailing comma to anchor the pattern.
  // Horizontal whitespace is explicit so it cannot overlap with the line-prefix
  // branch and trigger polynomial backtracking on newline-heavy input.
  const headerPattern =
    /(^|\r?\n)([^\S\r\n]*(?:authorization|cookie|x-api-key|x-auth-token)[^\S\r\n]*:[^\S\r\n]*)([^\r\n]*)/gim;
  result = result.replace(headerPattern, (_match, prefix: string, key: string) => {
    changed = true;
    return `${prefix}${key}[REDACTED]`;
  });
  return { text: result, changed };
}

function bytesForInput(input: ArtifactBytes): Uint8Array {
  return typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isWithin(candidate: string, root: string): boolean {
  const segment = relative(root, candidate);
  return (
    segment === '' || (!segment.startsWith(`..${sep}`) && segment !== '..' && !isAbsolute(segment))
  );
}

function descriptorWithOptionalFields(input: {
  readonly taskId: string;
  readonly kind: ArtifactKind;
  readonly path: string;
  readonly artifactId: string;
  readonly mediaType: string;
  readonly encoding: ArtifactEncoding;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly redactionApplied: boolean;
  readonly description?: string;
}): InternalArtifactDescriptor {
  const descriptor: InternalArtifactDescriptor = {
    artifactId: input.artifactId,
    taskId: input.taskId,
    kind: input.kind,
    name: input.path,
    path: input.path,
    mediaType: input.mediaType,
    artifact_id: input.artifactId,
    task_id: input.taskId,
    media_type: input.mediaType,
    encoding: input.encoding,
    bytes: input.sizeBytes,
    uri: `artifact://${encodeURIComponent(input.taskId)}/${input.artifactId}`,
    created_at: input.createdAt,
    sizeBytes: input.sizeBytes,
    byteLength: input.sizeBytes,
    sha256: input.artifactId,
    createdAt: input.createdAt,
    redactionApplied: input.redactionApplied,
    ...(input.description === undefined ? {} : { description: input.description }),
  };
  return descriptor;
}

function publicArtifact(descriptor: ArtifactDescriptor): ArtifactRef {
  return {
    artifact_id: descriptor.artifact_id,
    task_id: descriptor.task_id,
    kind: descriptor.kind,
    name: descriptor.name,
    media_type: descriptor.media_type,
    encoding: descriptor.encoding,
    bytes: descriptor.bytes,
    sha256: descriptor.sha256,
    uri: descriptor.uri,
    created_at: descriptor.created_at,
  };
}

function publicManifest(manifest: StoredManifest): ArtifactManifest {
  return {
    artifacts: manifest.artifacts.map((artifact) => publicArtifact(artifact)),
    total_bytes: manifest.totalBytes,
  };
}

/**
 * A task-scoped content-addressed store.
 *
 * Each task has one manifest and an `objects/<sha256>` directory. Objects are
 * immutable and written through a same-directory temporary file + rename;
 * manifests use the same protocol. The store never uses a caller-provided
 * artifact path as a filesystem path, which keeps logical paths separate from
 * storage keys and makes traversal attempts fail closed.
 */
export class ArtifactStore {
  readonly #rootDir: string;
  readonly #tasksDir: string;
  readonly #maxArtifactBytes: number;
  readonly #maxTaskBytes: number;
  readonly #redactSensitiveFields: boolean;
  readonly #sensitiveFields: readonly string[];
  readonly #taskLocks = new Map<string, Promise<void>>();
  readonly #ready: Promise<void>;

  constructor(options: ArtifactStoreOptions) {
    const configuredRoot = options.rootDir ?? options.root;
    if (configuredRoot === undefined || configuredRoot.trim().length === 0) {
      throw new ArtifactStoreError('CONFIG_INVALID', 'rootDir must not be empty');
    }
    if (
      options.rootDir !== undefined &&
      options.root !== undefined &&
      resolve(options.rootDir) !== resolve(options.root)
    ) {
      throw new ArtifactStoreError(
        'CONFIG_INVALID',
        'rootDir and root must refer to the same directory',
      );
    }
    this.#rootDir = resolve(configuredRoot);
    this.#tasksDir = join(this.#rootDir, 'tasks');
    this.#maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    this.#maxTaskBytes = options.maxTaskBytes ?? DEFAULT_MAX_TASK_BYTES;
    this.#redactSensitiveFields = options.redactSensitiveFields ?? true;
    this.#sensitiveFields = [
      'api_key',
      'apikey',
      'access_token',
      'authorization',
      'cookie',
      'password',
      'passwd',
      'private_key',
      'refresh_token',
      'secret',
      'session_token',
      'token',
      ...(options.sensitiveFields ?? []),
    ];
    assertPositiveInteger(this.#maxArtifactBytes, 'maxArtifactBytes');
    assertPositiveInteger(this.#maxTaskBytes, 'maxTaskBytes');
    if (this.#maxArtifactBytes > this.#maxTaskBytes) {
      throw new ArtifactStoreError('CONFIG_INVALID', 'maxArtifactBytes cannot exceed maxTaskBytes');
    }
    this.#ready = this.#ensureRoot();
  }

  /** Store one artifact and return its manifest descriptor. */
  async put(
    taskId: string,
    artifactPath: string,
    input: ArtifactBytes,
    options?: PutArtifactOptions,
  ): Promise<ArtifactDescriptor>;
  async put(
    taskId: string,
    artifact: ArtifactInput,
    options?: PutArtifactOptions,
  ): Promise<ArtifactDescriptor>;
  async put(
    taskId: string,
    artifactPathOrInput: string | ArtifactInput,
    inputOrOptions?: ArtifactBytes | PutArtifactOptions,
    maybeOptions: PutArtifactOptions = {},
  ): Promise<ArtifactDescriptor> {
    assertTaskId(taskId);
    const isProtocolInput = typeof artifactPathOrInput !== 'string';
    const artifactPath = isProtocolInput ? artifactPathOrInput.name : artifactPathOrInput;
    const input = isProtocolInput ? artifactPathOrInput.data : (inputOrOptions as ArtifactBytes);
    const protocolOptions = isProtocolInput
      ? {
          ...maybeOptions,
          ...(artifactPathOrInput.kind === undefined ? {} : { kind: artifactPathOrInput.kind }),
          ...(artifactPathOrInput.mediaType === undefined
            ? {}
            : { mediaType: artifactPathOrInput.mediaType }),
          ...(artifactPathOrInput.description === undefined
            ? {}
            : { description: artifactPathOrInput.description }),
          ...(artifactPathOrInput.redactSensitiveFields === undefined
            ? {}
            : { redactSensitiveFields: artifactPathOrInput.redactSensitiveFields }),
        }
      : ((inputOrOptions as PutArtifactOptions | undefined) ?? {});
    const options = protocolOptions;
    const logicalPath = normalizeArtifactPath(artifactPath);
    const initialBytes = bytesForInput(input);
    if (initialBytes.byteLength > this.#maxArtifactBytes) {
      throw new ArtifactSizeLimitError('artifact', initialBytes.byteLength, this.#maxArtifactBytes);
    }

    const redactionEnabled = options.redactSensitiveFields ?? this.#redactSensitiveFields;
    const prepared = this.#prepareBytes(initialBytes, redactionEnabled);
    if (prepared.bytes.byteLength > this.#maxArtifactBytes) {
      throw new ArtifactSizeLimitError(
        'artifact',
        prepared.bytes.byteLength,
        this.#maxArtifactBytes,
      );
    }
    const artifactId = hashBytes(prepared.bytes);
    const createdAt = new Date().toISOString();

    return this.#withTaskLock(taskId, async () => {
      const taskPaths = await this.#ensureTaskPaths(taskId);
      const manifest = await this.#readManifest(taskPaths.taskDir, taskId);
      const existing = manifest.artifacts.find((artifact) => artifact.path === logicalPath);
      const replaceExisting = options.replaceExisting ?? true;
      if (existing && !replaceExisting) {
        throw new ArtifactStoreError(
          'ARTIFACT_PATH_EXISTS',
          `Artifact path already exists for task ${taskId}: ${logicalPath}`,
        );
      }

      const retained = manifest.artifacts.filter(
        (artifact) => artifact.path !== logicalPath || !replaceExisting,
      );
      const nextTotal =
        retained.reduce((total, artifact) => total + artifact.sizeBytes, 0) +
        prepared.bytes.byteLength;
      if (nextTotal > this.#maxTaskBytes) {
        throw new ArtifactSizeLimitError('task', nextTotal, this.#maxTaskBytes);
      }

      const objectPath = join(taskPaths.objectsDir, artifactId);
      await this.#writeObjectIfMissing(objectPath, prepared.bytes);
      const descriptor = descriptorWithOptionalFields({
        taskId,
        kind: options.kind ?? 'other',
        path: logicalPath,
        artifactId,
        mediaType: options.mediaType ?? 'application/octet-stream',
        encoding: typeof input === 'string' ? 'utf8' : 'base64',
        sizeBytes: prepared.bytes.byteLength,
        createdAt,
        redactionApplied: prepared.redactionApplied,
        ...(options.mediaType === undefined ? {} : { mediaType: options.mediaType }),
        ...(options.description === undefined ? {} : { description: options.description }),
      });
      const nextManifest: StoredManifest = {
        ...manifest,
        updatedAt: createdAt,
        totalBytes: nextTotal,
        artifacts: [...retained, descriptor],
      };
      await this.#writeManifest(taskPaths.manifestPath, nextManifest);
      return { ...descriptor };
    });
  }

  /** Store UTF-8 text, useful for patches, reports, and logs. */
  async putText(
    taskId: string,
    artifactPath: string,
    text: string,
    options: PutArtifactOptions = {},
  ): Promise<ArtifactDescriptor> {
    return this.put(taskId, artifactPath, text, options);
  }

  /** Store a file without allowing its source path to become a store path. */
  async putFile(
    taskId: string,
    artifactPath: string,
    sourcePath: string,
    options: PutArtifactOptions = {},
  ): Promise<ArtifactDescriptor> {
    const source = resolve(sourcePath);
    const sourceStats = await stat(source);
    if (!sourceStats.isFile()) {
      throw new ArtifactStoreError(
        'SOURCE_NOT_FILE',
        `Artifact source is not a regular file: ${source}`,
      );
    }
    if (sourceStats.size > this.#maxArtifactBytes) {
      throw new ArtifactSizeLimitError('artifact', sourceStats.size, this.#maxArtifactBytes);
    }
    return this.put(taskId, artifactPath, await readFile(source), options);
  }

  /** Return a defensive copy of the task manifest. */
  async getManifest(taskId: string): Promise<ArtifactManifest> {
    assertTaskId(taskId);
    return this.#withTaskLock(taskId, async () => {
      const taskPaths = await this.#ensureTaskPaths(taskId, false);
      return publicManifest(await this.#readManifest(taskPaths.taskDir, taskId));
    });
  }

  /** Protocol-facing manifest alias. */
  async manifest(taskId: string): Promise<ArtifactManifest> {
    return this.getManifest(taskId);
  }

  /** Alias for callers that model manifests as a list operation. */
  async list(taskId: string): Promise<readonly ArtifactDescriptor[]> {
    assertTaskId(taskId);
    return this.#withTaskLock(taskId, async () => {
      const taskPaths = await this.#ensureTaskPaths(taskId, false);
      return (await this.#readManifest(taskPaths.taskDir, taskId)).artifacts.map((artifact) => ({
        ...artifact,
      }));
    });
  }

  /** Read a bounded byte range from an artifact by logical path or SHA-256. */
  async read(
    taskId: string,
    reference: string,
    options: ArtifactReadOptions = {},
  ): Promise<ArtifactReadResult> {
    assertTaskId(taskId);
    const artifact = await this.#findArtifact(taskId, reference);
    if (options.expectedSha256 !== undefined && options.expectedSha256 !== artifact.sha256) {
      throw new ArtifactStoreIntegrityError(
        artifact.artifactId,
        `Expected SHA-256 ${options.expectedSha256} does not match manifest ${artifact.sha256}`,
      );
    }
    const taskPaths = await this.#ensureTaskPaths(taskId, false);
    await this.#assertSecureFile(join(taskPaths.objectsDir, artifact.artifactId), false);
    const bytes = await readFile(join(taskPaths.objectsDir, artifact.artifactId));
    const actualHash = hashBytes(bytes);
    if (actualHash !== artifact.sha256 || bytes.byteLength !== artifact.sizeBytes) {
      throw new ArtifactStoreIntegrityError(
        artifact.artifactId,
        `Stored bytes do not match manifest (expected ${artifact.sha256}/${artifact.sizeBytes}, received ${actualHash}/${bytes.byteLength})`,
      );
    }

    const offset = options.offset ?? options.start ?? 0;
    const requestedEnd =
      options.end ??
      (options.limit === undefined
        ? bytes.byteLength
        : Math.min(bytes.byteLength, offset + options.limit));
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(requestedEnd) ||
      offset < 0 ||
      requestedEnd < offset ||
      requestedEnd > bytes.byteLength
    ) {
      throw new ArtifactRangeError(offset, requestedEnd, bytes.byteLength);
    }
    const pageBytes =
      artifact.encoding === 'base64'
        ? Math.floor((MAX_PROTOCOL_DATA_CHARS / 4) * 3)
        : MAX_PROTOCOL_DATA_CHARS;
    const end = Math.min(requestedEnd, offset + pageBytes);
    const selected = new Uint8Array(bytes.subarray(offset, end));
    const publicRef = publicArtifact(artifact);
    const text = artifact.encoding === 'utf8' ? UTF8_DECODER.decode(selected) : undefined;
    const data =
      artifact.encoding === 'base64' ? Buffer.from(selected).toString('base64') : (text ?? '');
    return {
      protocol_version: ARTIFACT_PROTOCOL_VERSION,
      artifact: publicRef,
      artifactId: artifact.artifactId,
      bytes: selected,
      data,
      ...(options.encoding === 'utf8' || text !== undefined ? { text: text ?? '' } : {}),
      offset,
      next_offset: end,
      end,
      totalBytes: bytes.byteLength,
      eof: end === bytes.byteLength,
    };
  }

  /** Explicit range alias with an exclusive end offset. */
  async readRange(
    taskId: string,
    reference: string,
    start: number,
    end?: number,
  ): Promise<ArtifactReadResult> {
    return this.read(taskId, reference, { start, ...(end === undefined ? {} : { end }) });
  }

  /** Read a UTF-8 artifact range and fail if the reference is binary-ish. */
  async readText(
    taskId: string,
    reference: string,
    options: Omit<ArtifactReadOptions, 'encoding'> = {},
  ): Promise<string> {
    const result = await this.read(taskId, reference, { ...options, encoding: 'utf8' });
    return result.text ?? '';
  }

  /** Check whether an artifact reference exists without returning its content. */
  async has(taskId: string, reference: string): Promise<boolean> {
    try {
      await this.#findArtifact(taskId, reference);
      return true;
    } catch (error) {
      if (error instanceof ArtifactNotFoundError) return false;
      throw error;
    }
  }

  /** Remove all artifacts for one task. The task ID is validated before deletion. */
  async removeTask(taskId: string): Promise<void> {
    assertTaskId(taskId);
    await this.#withTaskLock(taskId, async () => {
      const taskPaths = await this.#ensureTaskPaths(taskId, false);
      await this.#assertSecureDirectory(taskPaths.taskDir);
      await rm(taskPaths.taskDir, { recursive: true, force: true });
    });
  }

  #prepareBytes(
    input: Uint8Array,
    enabled: boolean,
  ): { bytes: Uint8Array; redactionApplied: boolean } {
    if (!enabled || !isLikelyText(input)) {
      return { bytes: new Uint8Array(input), redactionApplied: false };
    }
    const text = UTF8_DECODER.decode(input);
    const redacted = redactText(text, this.#sensitiveFields);
    if (!redacted.changed) {
      return { bytes: new Uint8Array(input), redactionApplied: false };
    }
    return { bytes: new TextEncoder().encode(redacted.text), redactionApplied: true };
  }

  async #ensureRoot(): Promise<void> {
    await this.#assertSecureDirectory(this.#rootDir, true);
    await mkdir(this.#rootDir, { recursive: true, mode: 0o700 });
    await this.#assertSecureDirectory(this.#rootDir);
    await this.#assertSecureDirectory(this.#tasksDir, true);
    await mkdir(this.#tasksDir, { recursive: true, mode: 0o700 });
    await this.#assertSecureDirectory(this.#tasksDir);
  }

  async #ensureTaskPaths(
    taskId: string,
    create = true,
  ): Promise<{
    readonly taskDir: string;
    readonly objectsDir: string;
    readonly manifestPath: string;
  }> {
    await this.#ready;
    assertTaskId(taskId);
    const taskDir = join(this.#tasksDir, taskId);
    const objectsDir = join(taskDir, 'objects');
    const manifestPath = join(taskDir, 'manifest.json');
    for (const candidate of [taskDir, objectsDir, manifestPath]) {
      if (!isWithin(candidate, this.#tasksDir)) {
        throw new ArtifactStoreIntegrityError(
          candidate,
          'Resolved store path escaped the task root',
        );
      }
    }

    if (create) {
      // Check each existing component before mkdir can follow a symlink. This
      // matters when a task ID is attacker-controlled and a stale task
      // directory was planted between runs.
      await this.#assertSecureDirectory(taskDir, true);
      await mkdir(taskDir, { recursive: true, mode: 0o700 });
      await this.#assertSecureDirectory(taskDir);
      await this.#assertSecureDirectory(objectsDir, true);
      await mkdir(objectsDir, { recursive: true, mode: 0o700 });
      await this.#assertSecureDirectory(objectsDir);
      await this.#assertSecureFile(manifestPath, true);
    } else {
      await this.#assertSecureDirectory(taskDir, true);
      await this.#assertSecureDirectory(objectsDir, true);
      await this.#assertSecureFile(manifestPath, true);
    }
    return { taskDir, objectsDir, manifestPath };
  }

  async #assertSecureDirectory(path: string, allowMissing = false): Promise<void> {
    try {
      const entry = await lstat(path);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new ArtifactStoreIntegrityError(path, 'Expected a non-symlink directory');
      }
    } catch (error) {
      if (allowMissing && isNodeError(error, 'ENOENT')) return;
      throw error;
    }
  }

  async #assertSecureFile(path: string, allowMissing = false): Promise<void> {
    try {
      const entry = await lstat(path);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new ArtifactStoreIntegrityError(path, 'Expected a non-symlink regular file');
      }
    } catch (error) {
      if (allowMissing && isNodeError(error, 'ENOENT')) return;
      throw error;
    }
  }

  async #writeObjectIfMissing(objectPath: string, bytes: Uint8Array): Promise<void> {
    if (!CONTENT_HASH_PATTERN.test(objectPath.split(sep).at(-1) ?? '')) {
      throw new ArtifactStoreIntegrityError(objectPath, 'Object path is not a SHA-256 key');
    }
    try {
      const existing = await lstat(objectPath);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new ArtifactStoreIntegrityError(objectPath, 'Object key is not a regular file');
      }
      if (
        existing.size !== bytes.byteLength ||
        hashBytes(await readFile(objectPath)) !== objectPath.split(sep).at(-1)
      ) {
        throw new ArtifactStoreIntegrityError(
          objectPath,
          'Existing content-addressed object does not match its SHA-256 key',
        );
      }
      return;
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }

    const temporaryPath = `${objectPath}.${randomUUID()}.tmp`;
    const handle = await open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, objectPath);
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
      await rm(temporaryPath, { force: true });
    }
  }

  async #writeManifest(manifestPath: string, manifest: StoredManifest): Promise<void> {
    const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`;
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const handle = await open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, manifestPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async #readManifest(taskDir: string, taskId: string): Promise<StoredManifest> {
    const manifestPath = join(taskDir, 'manifest.json');
    try {
      const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (!this.#isManifest(parsed, taskId)) {
        throw new ArtifactStoreIntegrityError(
          manifestPath,
          'Manifest schema or task ID is invalid',
        );
      }
      return parsed;
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        const now = new Date().toISOString();
        return {
          apiVersion: ARTIFACT_MANIFEST_API_VERSION,
          kind: 'ArtifactManifest',
          taskId,
          createdAt: now,
          updatedAt: now,
          totalBytes: 0,
          artifacts: [],
        };
      }
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreIntegrityError(manifestPath, 'Manifest could not be parsed');
    }
  }

  #isManifest(value: unknown, taskId: string): value is StoredManifest {
    if (value === null || typeof value !== 'object') return false;
    const candidate = value as Partial<StoredManifest>;
    return (
      candidate.apiVersion === ARTIFACT_MANIFEST_API_VERSION &&
      candidate.kind === 'ArtifactManifest' &&
      candidate.taskId === taskId &&
      typeof candidate.createdAt === 'string' &&
      typeof candidate.updatedAt === 'string' &&
      typeof candidate.totalBytes === 'number' &&
      Array.isArray(candidate.artifacts) &&
      candidate.artifacts.every((artifact) => this.#isDescriptor(artifact, taskId))
    );
  }

  #isDescriptor(value: unknown, taskId: string): value is InternalArtifactDescriptor {
    if (value === null || typeof value !== 'object') return false;
    const candidate = value as Partial<InternalArtifactDescriptor>;
    return (
      candidate.taskId === taskId &&
      typeof candidate.artifactId === 'string' &&
      CONTENT_HASH_PATTERN.test(candidate.artifactId) &&
      candidate.sha256 === candidate.artifactId &&
      typeof candidate.kind === 'string' &&
      typeof candidate.name === 'string' &&
      typeof candidate.path === 'string' &&
      candidate.name === candidate.path &&
      normalizeArtifactPath(candidate.path) === candidate.path &&
      typeof candidate.sizeBytes === 'number' &&
      candidate.byteLength === candidate.sizeBytes &&
      candidate.sizeBytes >= 0 &&
      typeof candidate.createdAt === 'string' &&
      typeof candidate.redactionApplied === 'boolean'
    );
  }

  async #findArtifact(taskId: string, reference: string): Promise<ArtifactDescriptor> {
    assertTaskId(taskId);
    const taskPaths = await this.#ensureTaskPaths(taskId, false);
    const manifest = await this.#readManifest(taskPaths.taskDir, taskId);
    const artifactReference = CONTENT_HASH_PATTERN.test(reference)
      ? undefined
      : normalizeArtifactPath(reference);
    const artifact =
      artifactReference === undefined
        ? manifest.artifacts.find((candidate) => candidate.artifactId === reference)
        : manifest.artifacts.find((candidate) => candidate.path === artifactReference);
    if (!artifact) throw new ArtifactNotFoundError(taskId, reference);
    return { ...artifact };
  }

  async #withTaskLock<T>(taskId: string, operation: TaskOperation<T>): Promise<T> {
    const previous = this.#taskLocks.get(taskId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const queued = previous.then(() => current);
    this.#taskLocks.set(taskId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#taskLocks.get(taskId) === queued) this.#taskLocks.delete(taskId);
    }
  }
}

export default ArtifactStore;
