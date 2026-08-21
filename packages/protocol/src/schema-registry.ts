import {
  ArtifactRefSchema,
  ReadTaskArtifactInputSchema,
  ReadTaskArtifactOutputSchema,
} from './artifact.js';
import {
  CancelTaskOutputSchema,
  CleanupTaskInputSchema,
  CleanupTaskOutputSchema,
  ContinueTaskOutputSchema,
  DelegateTaskOutputSchema,
  DoctorInputSchema,
  DoctorOutputSchema,
  GetTaskResultInputSchema,
  ListProfilesInputSchema,
  ListProfilesOutputSchema,
  WaitTaskInputSchema,
  WaitTaskOutputSchema,
} from './mcp.js';
import { ProfileSchema, ProfileSummarySchema } from './profile.js';
import { GetTaskResultOutputSchema, TaskResultSchema } from './result.js';
import {
  DelegationDecisionSchema,
  DelegationEvidenceSchema,
  DelegationObservedEvidenceSchema,
  DelegationRequestSchema,
} from './delegation.js';
import {
  CancelTaskInputSchema,
  ContinueTaskInputSchema,
  DelegateTaskInputSchema,
  GetTaskInputSchema,
  GetTaskOutputSchema,
  TaskSchema,
} from './task.js';
import { WorkspaceSchema } from './workspace.js';

/** Named registry consumed by the release-time JSON Schema generator. */
export const PROTOCOL_SCHEMA_REGISTRY = {
  profile: ProfileSchema,
  profile_summary: ProfileSummarySchema,
  workspace: WorkspaceSchema,
  delegation_request: DelegationRequestSchema,
  delegation_decision: DelegationDecisionSchema,
  delegation_observed_evidence: DelegationObservedEvidenceSchema,
  delegation_evidence: DelegationEvidenceSchema,
  task: TaskSchema,
  task_result: TaskResultSchema,
  artifact_ref: ArtifactRefSchema,
  mcp: {
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
  },
} as const;
