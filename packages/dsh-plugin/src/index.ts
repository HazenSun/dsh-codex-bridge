import { resolve } from 'node:path';

import type { Context } from '@deepseek-ai/cordis';
import type {
  LlmConfigurableProvider,
  LlmDiscoveredModel,
  LlmModelInfo,
  LlmResolvedModelInfo,
} from '@deepseek-ai/dsh-llm';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { ArtifactStore } from '@dsh-codex-bridge/artifacts';
import {
  applyProfileChange,
  loadBridgeConfig,
  previewProfileChange,
  readConfigSnapshot,
  redactSensitiveText,
  resolveConfigPath,
  rollbackConfig,
  type ProfileChangeRequest,
} from '@dsh-codex-bridge/config';
import { InProcessDshRuntime } from '@dsh-codex-bridge/dsh-runtime';
import { startStdioBridge, type BridgeSetupPort } from '@dsh-codex-bridge/mcp-server';
import {
  ModelIdSchema,
  PROTOCOL_VERSION,
  type ApplyProfileChangeInput,
  type DiscoverDshModelsInput,
  type DshModelCatalog,
  type DshModelSummary,
  type ProfileChange,
  type ProfileChangePreview,
  type ProfileChangeResult,
  type Profile,
  type PreviewProfileChangeInput,
  type RollbackConfigResult,
  type SetupCheck,
  type SetupStatus,
} from '@dsh-codex-bridge/protocol';
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
import '@deepseek-ai/dsh-llm';
import '@deepseek-ai/dsh-session';
import '@deepseek-ai/dsh-settings';

export const name = 'dsh-codex-bridge';
export const inject = ['agents', 'sessions', 'llm', 'settings', 'agentPresets'];

function safeErrorMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function modelSummary(
  model: LlmModelInfo,
  details?: LlmResolvedModelInfo,
): DshModelSummary | undefined {
  if (!ModelIdSchema.safeParse(model.id).success) return undefined;
  return {
    model: model.id,
    name: model.name,
    ...(model.description === undefined ? {} : { description: model.description }),
    ...(model.inputModalities === undefined
      ? {}
      : { input_modalities: [...model.inputModalities] }),
    ...(details?.reasoning === undefined
      ? {}
      : {
          reasoning_efforts: details.reasoning.efforts.map((effort) => String(effort.id)),
          ...(details.reasoning.defaultEffort === undefined
            ? {}
            : { default_reasoning_effort: String(details.reasoning.defaultEffort) }),
        }),
    ...(details?.context === undefined ? {} : { context_window: details.context.contextWindow }),
    ...(details?.defaultMaxTokens === undefined
      ? {}
      : { default_max_tokens: details.defaultMaxTokens }),
  };
}

function discoveredModelSummary(model: LlmDiscoveredModel): DshModelSummary | undefined {
  if (!ModelIdSchema.safeParse(model.id).success) return undefined;
  return {
    model: model.id,
    name: model.name ?? model.id,
    ...(model.contextWindow === undefined ? {} : { context_window: model.contextWindow }),
    ...(model.maxTokens === undefined ? {} : { default_max_tokens: model.maxTokens }),
  };
}

function configurableProviderIsConfigured(
  ctx: Context,
  provider: LlmConfigurableProvider,
): boolean {
  const settings = ctx.get('settings');
  if (settings === undefined) return false;
  let value: unknown = settings.get(settingsNamespace(provider.settingsNs));
  for (const segment of provider.settingsPath) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    value = (value as Record<string, unknown>)[segment];
  }
  return (
    value !== undefined &&
    value !== null &&
    (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0)
  );
}

/** Discover only live DSH provider routes; credentials and endpoints never leave DSH. */
export async function discoverDshModels(
  ctx: Context,
  input: DiscoverDshModelsInput,
): Promise<DshModelCatalog> {
  const llm = ctx.get('llm');
  if (llm === undefined) throw new Error('Required DSH service is unavailable: llm');
  const liveProviders = new Map(llm.listProviders().map((provider) => [provider.id, provider]));
  const configurableProviders = new Map(
    llm.listConfigurableProviders().map((provider) => [provider.provider, provider]),
  );
  const providerIds = [
    ...new Set([...liveProviders.keys(), ...configurableProviders.keys()]),
  ].filter((provider) => {
    if (input.provider !== undefined) return provider === input.provider;
    const configurable = configurableProviders.get(provider);
    return (
      liveProviders.has(provider) ||
      (configurable !== undefined && configurableProviderIsConfigured(ctx, configurable))
    );
  });

  return {
    protocol_version: PROTOCOL_VERSION,
    providers: await Promise.all(
      providerIds.map(async (providerId) => {
        const live = liveProviders.get(providerId);
        const configurable = configurableProviders.get(providerId);
        if (live !== undefined) {
          const models = await llm.listModels(providerId);
          const summaries = await Promise.all(
            models.map(async (model) => {
              const details =
                input.include_details === true
                  ? await llm.resolveModelInfo(providerId, model.id).catch(() => undefined)
                  : undefined;
              return modelSummary(model, details);
            }),
          );
          return {
            provider: providerId,
            name: live.name,
            configured: true,
            models: summaries.filter((model): model is DshModelSummary => model !== undefined),
          };
        }
        const models =
          configurable === undefined
            ? []
            : await llm
                .discoverModels(configurable.settingsNs, { provider: providerId })
                .catch(() => []);
        return {
          provider: providerId,
          name: configurable?.displayName ?? providerId,
          configured:
            configurable !== undefined && configurableProviderIsConfigured(ctx, configurable),
          models: models
            .map(discoveredModelSummary)
            .filter((model): model is DshModelSummary => model !== undefined),
        };
      }),
    ),
  };
}

async function validateProfileRoutes(
  ctx: Context,
  profile: Profile,
  catalog: DshModelCatalog,
): Promise<void> {
  const llm = ctx.get('llm');
  if (llm === undefined) throw new Error('Required DSH service is unavailable: llm');
  const agentPresets = ctx.get('agentPresets');
  if (agentPresets === undefined) {
    throw new Error('Required DSH service is unavailable: agentPresets');
  }
  const preset = (await agentPresets.list()).find(
    (candidate) => candidate.id === profile.dsh.agent_preset,
  );
  if (preset === undefined) {
    throw new Error(
      `profile ${profile.profile_id} uses an Agent Preset not exposed by DSH: ${profile.dsh.agent_preset}`,
    );
  }
  if (preset.broken !== undefined) {
    throw new Error(
      `profile ${profile.profile_id} uses a broken Agent Preset ${profile.dsh.agent_preset}: ${preset.broken}`,
    );
  }
  const liveProviders = new Set(llm.listProviders().map((provider) => provider.id));
  const routes = [
    { name: `profile ${profile.profile_id}`, route: profile.dsh },
    ...Object.entries(profile.delegation.roles).map(([role, route]) => ({
      name: `profile ${profile.profile_id} role ${role}`,
      route,
    })),
  ];
  for (const { name, route } of routes) {
    const provider = catalog.providers.find((candidate) => candidate.provider === route.provider);
    if (provider === undefined) {
      throw new Error(`${name} uses a Provider not exposed by DSH: ${route.provider}`);
    }
    if (!provider.configured) {
      throw new Error(
        `${name} uses a DSH Provider that is available but not configured: ${route.provider}`,
      );
    }
    const model = provider.models.find((candidate) => candidate.model === route.model);
    if (model === undefined) {
      throw new Error(`${name} uses a Model not discovered for ${route.provider}: ${route.model}`);
    }
    if (liveProviders.has(route.provider)) {
      await llm.resolveModelInfo(route.provider, route.model);
    }
    if (
      route.reasoning_effort !== undefined &&
      model !== undefined &&
      model.reasoning_efforts !== undefined &&
      !model.reasoning_efforts.includes(route.reasoning_effort)
    ) {
      throw new Error(
        `${name} uses unsupported reasoning effort ${route.reasoning_effort} for ${route.provider}/${route.model}`,
      );
    }
  }
}

function configChange(change: ProfileChange): ProfileChangeRequest {
  if (change.operation === 'add') {
    return {
      operation: 'add',
      profile: change.profile,
      ...(change.set_default_for === undefined ? {} : { set_default_for: change.set_default_for }),
    };
  }
  if (change.operation === 'update') {
    return {
      operation: 'update',
      profile_id: change.profile_id,
      ...(change.profile === undefined ? {} : { profile: change.profile }),
      ...(change.changes === undefined ? {} : { changes: change.changes }),
    };
  }
  if (change.operation === 'remove') {
    return {
      operation: 'remove',
      profile_id: change.profile_id,
      ...(change.replacement_default_profile_id === undefined
        ? {}
        : { replacement_default_profile_id: change.replacement_default_profile_id }),
    };
  }
  return {
    operation: 'set-default',
    project_id: change.project_id,
    profile_id: change.profile_id,
  };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

export class InProcessSetupControl implements BridgeSetupPort {
  readonly #ctx: Context;
  readonly #configPath: string;

  constructor(ctx: Context, configPath: string) {
    this.#ctx = ctx;
    this.#configPath = resolve(configPath);
  }

  async getStatus(): Promise<SetupStatus> {
    const checks: SetupCheck[] = [{ name: 'dsh_profile', status: 'ok' }];
    let catalog: DshModelCatalog;
    try {
      catalog = await discoverDshModels(this.#ctx, {
        protocol_version: PROTOCOL_VERSION,
        include_details: true,
      });
      checks.push({
        name: 'providers',
        status: catalog.providers.length === 0 ? 'missing' : 'ok',
        message:
          catalog.providers.length === 0
            ? 'No live DSH Provider route is configured.'
            : `${catalog.providers.length} live DSH Provider route(s).`,
      });
    } catch (error) {
      return {
        protocol_version: PROTOCOL_VERSION,
        state: 'degraded',
        config_path: this.#configPath,
        restart_required: false,
        checks: [
          ...checks,
          {
            name: 'providers',
            status: 'invalid',
            message: safeErrorMessage(error),
          },
        ],
        next_actions: ['Repair the DSH codex-bridge Profile, then retry setup status.'],
      };
    }

    try {
      const snapshot = await readConfigSnapshot(this.#configPath);
      checks.push({ name: 'project_config', status: 'ok' });
      const resolvedInvalidRoutes = (
        await Promise.all(
          snapshot.config.profiles.map(async (profile) => {
            try {
              await validateProfileRoutes(this.#ctx, profile, catalog);
              return [];
            } catch (error) {
              return [safeErrorMessage(error)];
            }
          }),
        )
      ).flat();
      if (resolvedInvalidRoutes.length > 0) {
        checks.push({
          name: 'profile_routes',
          status: 'invalid',
          message: resolvedInvalidRoutes.join('; '),
        });
        return {
          protocol_version: PROTOCOL_VERSION,
          state: 'degraded',
          config_path: snapshot.config_path,
          config_revision: snapshot.revision,
          restart_required: false,
          checks,
          next_actions: [
            'Configure the missing Provider in DSH or preview a Profile update to a live route.',
          ],
        };
      }
      checks.push({ name: 'profile_routes', status: 'ok' });
      return {
        protocol_version: PROTOCOL_VERSION,
        state:
          catalog.providers.length === 0 ||
          catalog.providers.every((provider) => provider.models.length === 0)
            ? 'needs_provider'
            : 'ready',
        config_path: snapshot.config_path,
        config_revision: snapshot.revision,
        restart_required: false,
        checks,
        next_actions:
          catalog.providers.length === 0 ||
          catalog.providers.every((provider) => provider.models.length === 0)
            ? ['Configure a Provider and Model in DSH, then retry setup status.']
            : ['Use list_profiles before delegating a task.'],
      };
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        checks.push({ name: 'project_config', status: 'missing' });
        return {
          protocol_version: PROTOCOL_VERSION,
          state:
            catalog.providers.length === 0 ||
            catalog.providers.every((provider) => provider.models.length === 0)
              ? 'needs_provider'
              : 'needs_execution_profile',
          config_path: this.#configPath,
          restart_required: false,
          checks,
          next_actions:
            catalog.providers.length === 0 ||
            catalog.providers.every((provider) => provider.models.length === 0)
              ? ['Configure a Provider and Model in DSH before creating a Bridge Profile.']
              : [
                  'Choose an exact Provider/Model from discover_dsh_models.',
                  'Run dsh-bridge setup with that route to create bridge.yaml.',
                ],
        };
      }
      checks.push({
        name: 'project_config',
        status: 'invalid',
        message: safeErrorMessage(error),
      });
      return {
        protocol_version: PROTOCOL_VERSION,
        state: 'degraded',
        config_path: this.#configPath,
        restart_required: false,
        checks,
        next_actions: ['Repair bridge.yaml or restore the latest validated configuration backup.'],
      };
    }
  }

  async discoverModels(input: DiscoverDshModelsInput): Promise<DshModelCatalog> {
    try {
      return await discoverDshModels(this.#ctx, input);
    } catch (error) {
      throw new Error(safeErrorMessage(error));
    }
  }

  async #validateChangedRoutes(
    change: ProfileChange,
    preview: ReturnType<typeof previewProfileChange>,
  ): Promise<void> {
    if (change.operation !== 'add' && change.operation !== 'update') return;
    const profileId = change.operation === 'add' ? change.profile.profile_id : change.profile_id;
    const profile = preview.after.profiles.find((candidate) => candidate.profile_id === profileId);
    if (profile === undefined) throw new Error(`Changed Profile is unavailable: ${profileId}`);
    const catalog = await discoverDshModels(this.#ctx, {
      protocol_version: PROTOCOL_VERSION,
      include_details: true,
    });
    await validateProfileRoutes(this.#ctx, profile, catalog);
  }

  async previewProfileChange(input: PreviewProfileChangeInput): Promise<ProfileChangePreview> {
    const snapshot = await readConfigSnapshot(this.#configPath);
    const preview = previewProfileChange(snapshot.config, configChange(input.change));
    await this.#validateChangedRoutes(input.change, preview);
    return {
      protocol_version: PROTOCOL_VERSION,
      config_path: snapshot.config_path,
      before_revision: snapshot.revision,
      change: input.change,
      summary: preview.summary,
      diff: preview.diff_text.slice(0, 100_000),
    };
  }

  async applyProfileChange(input: ApplyProfileChangeInput): Promise<ProfileChangeResult> {
    if (input.expected_revision === undefined) {
      throw new Error('expected_revision is required for configuration writes.');
    }
    const snapshot = await readConfigSnapshot(this.#configPath);
    const preview = previewProfileChange(snapshot.config, configChange(input.change));
    await this.#validateChangedRoutes(input.change, preview);
    const result = await applyProfileChange(this.#configPath, configChange(input.change), {
      expectedRevision: input.expected_revision,
    });
    return {
      protocol_version: PROTOCOL_VERSION,
      config_path: result.config_path,
      previous_revision: result.previous_revision,
      config_revision: result.config_revision,
      changed: result.preview.changed,
      restart_required: result.preview.changed,
    };
  }

  async rollbackProfileChange(expectedRevision: string): Promise<RollbackConfigResult> {
    const result = await rollbackConfig(this.#configPath, { expectedRevision });
    return {
      protocol_version: PROTOCOL_VERSION,
      config_path: result.config_path,
      previous_revision: result.previous_revision,
      config_revision: result.config_revision,
      changed: result.preview.changed,
      restart_required: true,
      restored_from: 'latest validated configuration backup',
    };
  }
}

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
  const configPath = resolveConfigPath();
  const setup = new InProcessSetupControl(ctx, configPath);
  let config: Awaited<ReturnType<typeof loadBridgeConfig>>;
  try {
    config = await loadBridgeConfig(configPath);
  } catch {
    const mcp = await startStdioBridge({ setup });
    return async () => mcp.close();
  }
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
  const mcp = await startStdioBridge({ setup, engine });
  return async () => mcp.close();
}
