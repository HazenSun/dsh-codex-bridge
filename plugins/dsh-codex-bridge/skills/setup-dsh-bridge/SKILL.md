---
name: setup-dsh-bridge
description: Set up, repair, or reconfigure DSH Codex Bridge for the current Git project. Use when the user installs the plugin, asks to configure DSH, add or switch a model, change the default Profile, preview model configuration, roll back a Profile change, or when delegation reports missing/invalid Bridge configuration.
---

# Set up DSH Bridge

Treat setup and model routing as a controlled configuration workflow. DSH owns Provider adapters and credentials; Bridge owns named execution Profiles, project defaults, safety limits, and routing. Never request, display, copy, or write an API key, Cookie, OAuth token, private endpoint, or credential value.

## Start with status

1. Call `get_setup_status` before proposing a change.
2. Follow only the returned `next_actions`; do not guess that the installation is ready.
3. If the MCP server cannot start because DSH or its `codex-bridge` Profile is missing, run `dsh-bridge setup --project . --dry-run` when local shell execution is available. Ask before running the same command without `--dry-run`, because it changes user-level DSH or Codex state.
4. Stop at a clear manual action when DSH needs a credential. Tell the user to configure it through DSH Settings or an approved environment-variable reference, then rerun status. Never accept the literal secret in chat.

## Select an exact DSH route

Call `discover_dsh_models`. Select only Provider and Model IDs returned by DSH. Use the model description, modalities, reasoning levels, and the user's stated purpose to suggest a semantic Profile ID such as `fast-code`, `deep-review`, or `vision-analysis`; do not make the raw model name the only user-facing meaning.

If the user asks for a Provider or Model that DSH does not expose, report it as unavailable. For a new Provider protocol or custom gateway, direct the user to configure the Provider in DSH first. Read [Profile management](references/profile-management.md) when creating or replacing a complete Profile.

## Preview before every write

1. Build the smallest `ProfileChange` that satisfies the request. For an existing Profile, prefer `update.changes` over replacing the full Profile.
2. Call `preview_profile_change`; do not edit `bridge.yaml` with an unrestricted file tool.
3. Show the user the semantic effect, affected Profile/project default, exact DSH route, and any restart requirement. Do not dump unrelated configuration.
4. Apply only after the user approves the preview. Pass the preview's `before_revision` as `expected_revision`; a revision conflict requires a new preview.
5. Call `get_setup_status` and `list_profiles` after the change. Never claim success from the write response alone.

## First project configuration

When `bridge.yaml` is missing, discover configured DSH models first. If at least one usable route exists, propose one bounded default Profile using the defaults in [Profile management](references/profile-management.md). Show the exact equivalent `dsh-bridge setup --project . --source <bridge-checkout> --provider <id> --model <id> --profile-id <semantic-id> [--reasoning-effort <id>]` command and wait for approval before running it. The first configuration must target the current Git top-level project and must not enable direct writes or unrestricted network access. MCP Profile preview/apply starts after this initial file exists.

## Change and rollback rules

- Updating a Profile affects subsequent Bridge tasks, not an already-running or persisted DSH session.
- Setting a default must name an existing Profile and the current project ID.
- Removing a Profile used as a project default requires an explicit replacement in the same change.
- Use `rollback_profile_change` only after showing which current revision will be replaced. It is a destructive write and requires explicit approval.
- A real model smoke test can incur cost and network activity. Run it only after the user agrees; use a bounded read-only objective and report the selected route and evidence.

## Completion

Setup is complete only when status is `ready`, the expected Profile appears in `list_profiles`, and any user-requested real-model test has returned verifiable evidence. If a new task or MCP restart is required, say so explicitly instead of implying the current process hot-reloaded configuration.
