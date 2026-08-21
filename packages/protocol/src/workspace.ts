import { z } from 'zod';

import {
  IsoTimestampSchema,
  ProjectIdSchema,
  ProtocolVersionSchema,
  WorkspaceIdSchema,
} from './constants.js';
import { WorkspaceModeSchema } from './profile.js';

/** Git revisions are intentionally not restricted to SHA-1: SHA-256 repos and refs are valid. */
export const GitRevisionSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._~:/-]*$/);
export type GitRevision = z.infer<typeof GitRevisionSchema>;

export const WorkspaceStatusSchema = z.enum(['preparing', 'ready', 'dirty', 'released', 'missing']);
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;

/** Public workspace metadata. Absolute paths remain an implementation detail. */
export const WorkspaceSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    workspace_id: WorkspaceIdSchema,
    project_id: ProjectIdSchema,
    mode: WorkspaceModeSchema,
    status: WorkspaceStatusSchema,
    base_revision: GitRevisionSchema,
    head_revision: GitRevisionSchema.optional(),
    created_at: IsoTimestampSchema,
    updated_at: IsoTimestampSchema,
    released_at: IsoTimestampSchema.optional(),
  })
  .strict();
export type Workspace = z.infer<typeof WorkspaceSchema>;
