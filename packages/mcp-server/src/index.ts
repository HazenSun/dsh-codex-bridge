import {
  CancelTaskInputSchema,
  ContinueTaskInputSchema,
  DelegateTaskInputSchema,
  GetTaskInputSchema,
  ListProfilesInputSchema,
  PROTOCOL_VERSION,
  ReadTaskArtifactInputSchema,
  WaitTaskInputSchema,
} from '@dsh-codex-bridge/protocol';
import type { TaskEngine } from '@dsh-codex-bridge/task-engine';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export interface BridgeMcpHandle {
  readonly server: McpServer;
  close(): Promise<void>;
}

function content(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

export function createBridgeMcpServer(engine: TaskEngine): McpServer {
  const server = new McpServer({ name: 'dsh-codex-bridge', version: '0.1.0-alpha.1' });

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

export async function startStdioBridge(engine: TaskEngine): Promise<BridgeMcpHandle> {
  const server = createBridgeMcpServer(engine);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return {
    server,
    close: async () => server.close(),
  };
}
