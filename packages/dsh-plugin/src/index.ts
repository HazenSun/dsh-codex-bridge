import { resolve } from 'node:path';

import type { Context } from '@deepseek-ai/cordis';
import { ArtifactStore } from '@dsh-codex-bridge/artifacts';
import { loadBridgeConfig, resolveConfigPath } from '@dsh-codex-bridge/config';
import { InProcessDshRuntime } from '@dsh-codex-bridge/dsh-runtime';
import { startStdioBridge } from '@dsh-codex-bridge/mcp-server';
import type {
  ArtifactManifest,
  ArtifactRef,
  ReadTaskArtifactOutput,
} from '@dsh-codex-bridge/protocol';
import {
  FileTaskStore,
  TaskEngine,
  type ArtifactPort,
  type PutArtifactInput,
} from '@dsh-codex-bridge/task-engine';
import '@deepseek-ai/dsh-agent';
import '@deepseek-ai/dsh-agent-presets';
import '@deepseek-ai/dsh-session';

export const name = 'dsh-codex-bridge';
export const inject = ['agents', 'sessions'];

function artifactRef(value: ArtifactRef): ArtifactRef {
  return {
    artifact_id: value.artifact_id,
    task_id: value.task_id,
    kind: value.kind,
    name: value.name,
    media_type: value.media_type,
    encoding: value.encoding,
    bytes: value.bytes,
    sha256: value.sha256,
    uri: value.uri,
    created_at: value.created_at,
  };
}

function artifactPort(store: ArtifactStore): ArtifactPort {
  return {
    put: async (taskId: string, input: PutArtifactInput): Promise<ArtifactRef> =>
      artifactRef(await store.put(taskId, input)),
    manifest: async (taskId: string): Promise<ArtifactManifest> => {
      const manifest = await store.manifest(taskId);
      return { artifacts: manifest.artifacts.map(artifactRef), total_bytes: manifest.total_bytes };
    },
    read: async (taskId, artifactId, options): Promise<ReadTaskArtifactOutput> => {
      const result = await store.read(taskId, artifactId, options);
      return {
        protocol_version: result.protocol_version,
        artifact: artifactRef(result.artifact),
        offset: result.offset,
        data: result.data,
        next_offset: result.next_offset,
        eof: result.eof,
      };
    },
  };
}

/** Mount the stdout-clean MCP gateway inside the DSH Cordis process. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const config = await loadBridgeConfig(resolveConfigPath());
  const dataRoot = resolve(config.value.data_root);
  const maximumArtifactBytes = Math.max(
    ...config.value.profiles.map((profile) => profile.policy.max_artifact_bytes),
  );
  const artifacts = new ArtifactStore({
    root: resolve(dataRoot, 'artifacts'),
    maxArtifactBytes: maximumArtifactBytes,
    maxTaskBytes: maximumArtifactBytes * 16,
  });
  const engine = new TaskEngine({
    config,
    store: new FileTaskStore(resolve(dataRoot, 'tasks')),
    artifacts: artifactPort(artifacts),
    runtime: new InProcessDshRuntime(ctx),
  });
  await engine.reconcile();
  const mcp = await startStdioBridge(engine);
  return async () => mcp.close();
}
