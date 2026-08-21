import {
  ApplyProfileChangeInputSchema,
  CancelTaskInputSchema,
  ContinueTaskInputSchema,
  DelegateTaskInputSchema,
  DiscoverDshModelsInputSchema,
  GetTaskInputSchema,
  GetSetupStatusInputSchema,
  ListProfilesInputSchema,
  PreviewProfileChangeInputSchema,
  PROTOCOL_VERSION,
  ReadTaskArtifactInputSchema,
  RollbackProfileChangeInputSchema,
  WaitTaskInputSchema,
  type ApplyProfileChangeInput,
  type DiscoverDshModelsInput,
  type DshModelCatalog,
  type PreviewProfileChangeInput,
  type ProfileChangePreview,
  type ProfileChangeResult,
  type RollbackConfigResult,
  type SetupStatus,
} from '@dsh-codex-bridge/protocol';
import type { TaskEngine } from '@dsh-codex-bridge/task-engine';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export interface BridgeMcpHandle {
  readonly server: McpServer;
  close(): Promise<void>;
}

export interface BridgeSetupPort {
  getStatus(): Promise<SetupStatus>;
  discoverModels(input: DiscoverDshModelsInput): Promise<DshModelCatalog>;
  previewProfileChange(input: PreviewProfileChangeInput): Promise<ProfileChangePreview>;
  applyProfileChange(input: ApplyProfileChangeInput): Promise<ProfileChangeResult>;
  rollbackProfileChange(expectedRevision: string): Promise<RollbackConfigResult>;
}

export interface BridgeMcpOptions {
  readonly setup: BridgeSetupPort;
  readonly engine?: TaskEngine;
}

function content(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

export function createBridgeMcpServer(options: BridgeMcpOptions): McpServer {
  const server = new McpServer(
    { name: 'dsh-codex-bridge', version: '0.1.0-alpha.2' },
    {
      instructions:
        'Inspect get_setup_status before delegation. When setup is incomplete, discover DSH models, preview any Profile change, and require user approval before apply or rollback. Never request or store provider credentials. When ready, select declared Profiles and treat DSH results as reviewable evidence.',
    },
  );

  server.registerTool(
    'get_setup_status',
    {
      title: 'Inspect DSH Bridge setup',
      description:
        'Return the current project setup state, redacted checks, configuration revision and safe next actions.',
      inputSchema: GetSetupStatusInputSchema.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      GetSetupStatusInputSchema.parse(input);
      return content(await options.setup.getStatus());
    },
  );

  server.registerTool(
    'discover_dsh_models',
    {
      title: 'Discover configured DSH models',
      description:
        'List provider and model identifiers exposed by the running DSH profile without credentials or private endpoints.',
      inputSchema: DiscoverDshModelsInputSchema.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      content(await options.setup.discoverModels(DiscoverDshModelsInputSchema.parse(input))),
  );

  server.registerTool(
    'preview_profile_change',
    {
      title: 'Preview a Bridge Profile change',
      description:
        'Validate and preview an add, update, remove or default-Profile change without writing files.',
      inputSchema: PreviewProfileChangeInputSchema.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const parsed = PreviewProfileChangeInputSchema.parse(input);
      return content(await options.setup.previewProfileChange(parsed));
    },
  );

  server.registerTool(
    'apply_profile_change',
    {
      title: 'Apply a Bridge Profile change',
      description:
        'Atomically apply a previously reviewable Profile change with optimistic revision protection and a rollback backup.',
      inputSchema: ApplyProfileChangeInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      content(await options.setup.applyProfileChange(ApplyProfileChangeInputSchema.parse(input))),
  );

  server.registerTool(
    'rollback_profile_change',
    {
      title: 'Roll back the latest Bridge configuration change',
      description:
        'Restore the newest validated configuration backup when the expected current revision still matches.',
      inputSchema: RollbackProfileChangeInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const parsed = RollbackProfileChangeInputSchema.parse(input);
      return content(await options.setup.rollbackProfileChange(parsed.expected_revision));
    },
  );

  if (options.engine === undefined) return server;
  const engine = options.engine;

  server.registerTool(
    'list_profiles',
    {
      title: 'List DSH profiles',
      description: 'List safe DSH execution profiles without credentials or private endpoints.',
      inputSchema: ListProfilesInputSchema.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      ListProfilesInputSchema.parse(input);
      return content(engine.listProfiles());
    },
  );

  server.registerTool(
    'delegate_task',
    {
      title: 'Delegate implementation to DSH',
      description:
        'Create an isolated asynchronous DSH task and return immediately with a task identifier.',
      inputSchema: DelegateTaskInputSchema.shape,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => content(await engine.delegate(DelegateTaskInputSchema.parse(input))),
  );

  server.registerTool(
    'get_task',
    {
      title: 'Get DSH task status',
      description: 'Read the current durable task state and progress.',
      inputSchema: GetTaskInputSchema.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const parsed = GetTaskInputSchema.parse(input);
      return content({
        protocol_version: PROTOCOL_VERSION,
        task: await engine.get(parsed.task_id),
      });
    },
  );

  server.registerTool(
    'wait_task',
    {
      title: 'Wait briefly for a DSH task',
      description:
        'Wait for one task state change for at most 30 seconds; never waits indefinitely.',
      inputSchema: WaitTaskInputSchema.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const parsed = WaitTaskInputSchema.parse(input);
      return content({
        protocol_version: PROTOCOL_VERSION,
        task: await engine.wait(parsed.task_id, parsed.timeout_seconds),
      });
    },
  );

  server.registerTool(
    'get_task_result',
    {
      title: 'Get DSH task result',
      description: 'Read the normalized summary, changed files, usage and artifact manifest.',
      inputSchema: GetTaskInputSchema.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const parsed = GetTaskInputSchema.parse(input);
      return content({
        protocol_version: PROTOCOL_VERSION,
        result: await engine.result(parsed.task_id),
      });
    },
  );

  server.registerTool(
    'read_task_artifact',
    {
      title: 'Read a task artifact',
      description:
        'Read a bounded page of a patch, log, report or other content-addressed artifact.',
      inputSchema: ReadTaskArtifactInputSchema.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const parsed = ReadTaskArtifactInputSchema.parse(input);
      return content(
        await engine.readArtifact(parsed.task_id, parsed.artifact_id, {
          offset: parsed.offset,
          limit: parsed.limit,
          ...(parsed.expected_sha256 === undefined
            ? {}
            : { expectedSha256: parsed.expected_sha256 }),
        }),
      );
    },
  );

  server.registerTool(
    'continue_task',
    {
      title: 'Continue a DSH task',
      description: 'Send Codex review feedback to the same persisted DSH session and workspace.',
      inputSchema: ContinueTaskInputSchema.shape,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const parsed = ContinueTaskInputSchema.parse(input);
      return content(await engine.continue(parsed));
    },
  );

  server.registerTool(
    'cancel_task',
    {
      title: 'Cancel a DSH task',
      description: 'Request bounded cancellation and resource convergence for a running DSH task.',
      inputSchema: CancelTaskInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const parsed = CancelTaskInputSchema.parse(input);
      return content(await engine.cancel(parsed));
    },
  );

  return server;
}

export async function startStdioBridge(options: BridgeMcpOptions): Promise<BridgeMcpHandle> {
  const server = createBridgeMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return {
    server,
    close: async () => server.close(),
  };
}
