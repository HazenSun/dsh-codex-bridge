---
name: setup-dsh-bridge
description: Set up, repair, or reconfigure DSH Codex Bridge for the current Git project. Use when the user installs the plugin, asks to configure DSH, add or switch a model, change the default Profile, preview model configuration, roll back a Profile change, or when delegation reports missing/invalid Bridge configuration.
---

# Set up DSH Bridge

Treat setup and model routing as a controlled configuration workflow. DSH owns Provider adapters and credentials; Bridge owns named execution Profiles, project defaults, safety limits, and routing. Never request, display, copy, or write an API key, Cookie, OAuth token, private endpoint, or credential value.

## Installation contract

The Plugin provides Setup and Delegate Skills. Its installation alone does not register MCP. Bridge `setup/install` separately runs the official `codex mcp add dsh-codex-bridge` with an absolute Node executable, an absolute source-checkout launcher, and `--env DSH_BRIDGE_RUNTIME_CONFIG=<absolute-runtime.json>`.

Use the same Codex Home as the user's active CLI/Desktop. With a custom `CODEX_HOME`, run installation, `codex mcp get dsh-codex-bridge --json`, and any removal against that Home. Preserve the source checkout and dedicated DSH directory because the registered launcher references them. Do not reconstruct plugin `.mcp.json`, `mcpServers`, `${PLUGIN_ROOT}` / `${CODEX_HOME}` substitutions, or `env_vars` / `envVars`: the tested Codex `0.156.1` legacy plugin surface did not resolve them reliably.

Runtime selection is saved in that Home's `dsh-codex-bridge/runtime.json`. CLI environment overrides can select a different DSH executable/Home temporarily; to change Desktop, rerun `setup` and save the desired selection, then start a new task. The saved runtime is shared by Bridge projects under that Codex Home. Disabling the Skill plugin does not delete MCP registration. Remove it with `codex mcp remove dsh-codex-bridge` only when the user requested full removal and all affected Bridge projects have stopped using it.

## Start with status

1. Call `get_setup_status` when the Bridge MCP tools are available, before proposing a configuration change.
2. Follow only the returned `next_actions`; do not guess that the installation is ready.
3. If MCP cannot start or registration is missing, inspect `codex mcp get dsh-codex-bridge --json` and the Bridge launcher's `runtime.json` under `$CODEX_HOME/dsh-codex-bridge/` (default `~/.codex/dsh-codex-bridge/`). It holds non-secret `command`, `dsh_home`, and `source_root` paths. Resolve the source checkout from this file or the user's installation request, and resolve the target Git top-level project. Preview `<absolute-node> <source_root>/packages/cli/dist/index.js setup --project <git-root> --source <source_root> --dsh-bin <absolute-dsh> --dry-run`. Execute the reviewed installation within existing authorization and the user's preview/confirmation preferences. The installer saves the runtime and registers MCP; use its compatible version, not another project's global DSH. If a same-name registration is not Bridge-managed, inspect the conflict and do not delete that service to bypass the guard.
4. Before first use of an older DSH Home, back up the affected settings or use an explicitly selected independent Home. DSH 0.2 can migrate legacy `settings.yaml`; a separate executable alone does not isolate its data. Recheck registration and `doctor` after installation, then start a new task to discover the setup tools.
5. Stop at a clear manual action when DSH needs a credential. Tell the user to configure it in the `codex-bridge` DSH Profile or through an approved environment-variable reference, then rerun status. Never accept the literal secret in chat.

## Select an exact DSH route

Call `discover_dsh_models`. Select only Provider and Model IDs returned by DSH. Use the model description, modalities, reasoning levels, and the user's stated purpose to suggest a semantic Profile ID such as `fast-code`, `deep-review`, or `vision-analysis`; do not make the raw model name the only user-facing meaning.

If the user asks for a Provider or Model that DSH does not expose, report it as unavailable. For a new Provider protocol or custom gateway, direct the user to configure the Provider in DSH first. Read [Profile management](references/profile-management.md) when creating or replacing a complete Profile.

DSH 0.2 saves model configuration per Profile. When the user has configured a Provider in the same Home's `web` Profile but Bridge cannot see it, preview `models sync --from-profile web` through the saved Bridge CLI. Show the affected Provider entries, then apply with `--apply --expected-revision <before_revision>` after authorization. This updates DSH's `codex-bridge/cordis.patch.yml`, preserves other overrides, and rejects literal credentials. Restart MCP and rediscover models before creating a project Profile.

## Preview before every write

1. Build the smallest `ProfileChange` that satisfies the request. For an existing Profile, prefer `update.changes` over replacing the full Profile.
   When switching to a model without the previous explicit reasoning effort, use `clear_reasoning_effort: true` or CLI `profiles update --clear-reasoning-effort`. Do not set and clear the effort in one change.
2. Call `preview_profile_change`; do not edit `bridge.yaml` with an unrestricted file tool.
3. Show the user the semantic effect, affected Profile/project default, exact DSH route, and any restart requirement. Do not dump unrelated configuration.
4. Apply only within the user's authorization and stated preview/confirmation preferences. Do not request permission already provided for the same action. Pass the preview's `before_revision` as `expected_revision`; a revision conflict requires a new preview.
5. Call `get_setup_status` and `list_profiles` after the change. Never claim success from the write response alone.

## First project configuration

When `bridge.yaml` is missing, discover configured DSH models first. If at least one usable route exists, propose one bounded default Profile using the defaults in [Profile management](references/profile-management.md). Show the exact equivalent `<absolute-node> <bridge-checkout>/packages/cli/dist/index.js setup --project <git-root> --source <bridge-checkout> --provider <id> --model <id> --profile-id <semantic-id> [--reasoning-effort <id>]` command. Execute within existing authorization and the user's preview/confirmation preferences; a preview-only request remains preview-only. The first configuration must target the current Git top-level project and must not enable direct writes or unrestricted network access. MCP Profile preview/apply starts after this initial file exists.

## Change and rollback rules

- Updating a Profile does not alter an active turn or recorded history. After MCP restart, a continued run reinstalls model selection from the current configuration of the task's original `profile_id`; changing a project default does not replace that ID. An existing Session must resume with its recorded Agent Preset. Use a new task for a different Preset.
- Setting a default must name an existing Profile and the current project ID.
- Removing a Profile used as a project default requires an explicit replacement in the same change.
- Use `rollback_profile_change` only after showing which current revision will be replaced and obtaining authorization if it was not already provided for that rollback. Preserve explicit preview/confirmation requirements.
- A real model smoke test can incur cost and network activity. Run it when the user authorized actual model verification; otherwise obtain authorization first. Use a bounded objective and report the selected route and evidence.

## Completion

Setup is complete only when status is `ready`, the expected Profile appears in `list_profiles`, and any user-requested real-model test has returned verifiable evidence. If a new task or MCP restart is required, say so explicitly instead of implying the current process hot-reloaded configuration.

`doctor` and `models list` validate startup and discover routes without model generation. Their success does not prove account access, a generated response, or a multi-agent run. Verify the separate local MCP registration as well as the Skill plugin; do not call setup complete from Marketplace installation alone.
