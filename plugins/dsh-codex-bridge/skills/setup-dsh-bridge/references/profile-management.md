# Profile management

Read this reference when Codex needs to create or replace a complete Bridge Profile.

## Safe initial defaults

Use the selected Provider/Model and only reasoning effort values DSH advertised. Unless the user requests stricter values, start with:

```yaml
description: Focused implementation in an isolated Git worktree.
dsh:
  provider: <discovered-provider-id>
  model: <discovered-model-id>
  reasoning_effort: <advertised-effort-if-any>
  agent_preset: standard
  max_tokens: 32000
delegation:
  max_depth: 0
  max_children: 0
  roles: {}
workspace:
  mode: isolated_worktree
  allowed_roots: [.]
policy:
  network: restricted
  allowed_domains: []
  denied_paths: [.env, .git]
  timeout_seconds: 1800
  max_artifact_bytes: 10485760
  max_output_bytes: 1048576
  max_files: 1000
  disk_quota_bytes: 1073741824
```

Enable Sub-Agents only when the user wants multi-Agent work and the chosen DSH Preset supports it. A conservative multi-Agent Profile may use `max_depth: 2` and `max_children: 3`; role IDs describe outcomes such as `analysis`, `tests`, and `reviewer`. Role declarations are not proof that DSH executed child agents.

## Model and credential boundary

- A Bridge Profile stores Provider/Model identifiers, reasoning effort, Preset, budgets, workspace policy, and execution policy.
- Provider credentials stay in DSH. Never put `api_key`, `apiKey`, `token`, `secret`, `cookie`, `authorization`, credential contents, or a private endpoint in Profile metadata.
- Model IDs may contain provider catalog namespaces such as `vendor/model`; preserve the exact ID returned by DSH.

## Choosing the operation

- `add`: create a new semantic Profile; optionally set it as default for named project IDs.
- `update`: prefer a small `changes` object (for example only `dsh.provider`, `dsh.model`, and `dsh.reasoning_effort`); replace the complete Profile only when the user requested a policy-wide replacement.
- `set_default`: point one project at an existing Profile.
- `remove`: remove a Profile only when every affected project receives an explicit replacement default.

Always preview and apply with the expected SHA-256 revision within the user's authorization. Honor preview-only requests and explicit confirmation preferences; do not ask again for the same action when approval was already given.

When switching models, omitted reasoning fields keep the existing value. If the new model does not support that value, use `update.clear_reasoning_effort: true` with a small `changes.dsh` route update (CLI: `profiles update --clear-reasoning-effort`). Never silently downgrade an explicitly requested effort, and never combine a reset with setting a new effort in the same change.
