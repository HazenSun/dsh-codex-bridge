import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION, type ProfileChange } from '@dsh-codex-bridge/protocol';

import { createBridgeMcpServer, type BridgeSetupPort } from './index.js';

const revision = 'a'.repeat(64);
const change: ProfileChange = {
  operation: 'set_default',
  project_id: 'demo',
  profile_id: 'worker',
};

const setup: BridgeSetupPort = {
  getStatus: async () => ({
    protocol_version: PROTOCOL_VERSION,
    state: 'ready',
    config_path: '/workspace/bridge.yaml',
    config_revision: revision,
    restart_required: false,
    checks: [{ name: 'project_config', status: 'ok' }],
    next_actions: ['Use list_profiles before delegation.'],
  }),
  discoverModels: async () => ({
    protocol_version: PROTOCOL_VERSION,
    providers: [
      {
        provider: 'provider-main',
        name: 'Provider Main',
        configured: true,
        models: [{ model: 'vendor/model-code', name: 'Model Code' }],
      },
    ],
  }),
  previewProfileChange: async () => ({
    protocol_version: PROTOCOL_VERSION,
    config_path: '/workspace/bridge.yaml',
    before_revision: revision,
    change,
    summary: 'Set default Profile.',
    diff: '~ $.projects[0].default_profile: "old" → "worker"',
  }),
  applyProfileChange: async () => ({
    protocol_version: PROTOCOL_VERSION,
    config_path: '/workspace/bridge.yaml',
    previous_revision: revision,
    config_revision: 'b'.repeat(64),
    changed: true,
    restart_required: true,
  }),
  rollbackProfileChange: async () => ({
    protocol_version: PROTOCOL_VERSION,
    config_path: '/workspace/bridge.yaml',
    previous_revision: revision,
    config_revision: 'c'.repeat(64),
    changed: true,
    restart_required: true,
    restored_from: 'latest validated configuration backup',
  }),
};

const clients: Client[] = [];
const servers: ReturnType<typeof createBridgeMcpServer>[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map(async (client) => client.close()));
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

async function fixture(): Promise<Client> {
  const server = createBridgeMcpServer({ setup });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  servers.push(server);
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe('setup-mode MCP', () => {
  it('starts without a TaskEngine and exposes only safe setup tools', async () => {
    const client = await fixture();
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'get_setup_status',
      'discover_dsh_models',
      'preview_profile_change',
      'apply_profile_change',
      'rollback_profile_change',
    ]);

    const status = await client.callTool({
      name: 'get_setup_status',
      arguments: { protocol_version: PROTOCOL_VERSION },
    });
    expect(status.structuredContent).toMatchObject({ state: 'ready' });
  });

  it('keeps Profile mutation preview and apply as separate calls', async () => {
    const client = await fixture();
    const preview = await client.callTool({
      name: 'preview_profile_change',
      arguments: { protocol_version: PROTOCOL_VERSION, change },
    });
    expect(preview.structuredContent).toMatchObject({ before_revision: revision });

    const applied = await client.callTool({
      name: 'apply_profile_change',
      arguments: {
        protocol_version: PROTOCOL_VERSION,
        expected_revision: revision,
        change,
      },
    });
    expect(applied.structuredContent).toMatchObject({
      changed: true,
      restart_required: true,
    });
  });
});
