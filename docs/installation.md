# 安装手册

本手册对应 DSH Codex Bridge `0.1.0-alpha.2`。当前交付方式是从 GitHub 源码安装；npm 包和公共 Codex Plugin Directory 尚未发布。

## 1. 支持范围

| 组件     | 要求                                                         |
| -------- | ------------------------------------------------------------ |
| 操作系统 | macOS arm64 已完成真实闭环；Linux x64 运行非凭据 CI Contract |
| Node.js  | `^22.19.0` 或 `>=24.0.0`                                     |
| pnpm     | `11.19.0`，建议通过 Corepack 使用                            |
| Git      | 支持 `git worktree` 的版本                                   |
| DSH      | 精确锁定 `0.1.0-rc.8`                                        |
| Codex    | 支持本地 Plugin 和 STDIO MCP 的 CLI 或 Desktop               |
| 项目     | 当前运行时只支持 Git 顶层目录                                |

DSH 处于 Developer Preview。Bridge 不承诺其他 DSH RC 版本兼容；升级前先查看[兼容矩阵](compatibility.md)。

## 2. 安装前检查

```bash
node --version
corepack --version
git --version
codex --version
dsh --version
```

如果尚未安装 DSH，可使用精确版本安装 CLI：

```bash
npm install --global @deepseek-ai/dsh@0.1.0-rc.8
dsh --version
```

也可以按照 [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)从源码运行。Bridge 只要求命令行中存在可执行的 `dsh`，并且版本严格等于 `0.1.0-rc.8`。

Provider API Key、Endpoint 和 Cookie 只配置在 DSH 自己的设置中。不要把凭据写入本项目、`bridge.yaml`、Codex Plugin 或 Issue。

## 3. 获取和构建 Bridge

```bash
git clone https://github.com/HazenSun/dsh-codex-bridge.git
cd dsh-codex-bridge
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm dsh-bridge --version
```

预期版本：

```text
0.1.0-alpha.2
```

## 4. 推荐：首次设置向导

目标项目必须是 Git 顶层目录。先设置两个绝对路径：

```bash
BRIDGE_SOURCE=/absolute/path/to/dsh-codex-bridge
BRIDGE_PROJECT=/absolute/path/to/your-git-project
```

先查看完整安装计划，再执行：

```bash
cd "$BRIDGE_SOURCE"
pnpm dsh-bridge setup \
  --project "$BRIDGE_PROJECT" \
  --source "$BRIDGE_SOURCE" \
  --dry-run

pnpm dsh-bridge setup \
  --project "$BRIDGE_PROJECT" \
  --source "$BRIDGE_SOURCE"
```

第二条命令会安装 DSH `codex-bridge` Profile 和 Codex Plugin。没有指定模型时，它不会生成猜测性的 `bridge.yaml`，而是返回 `needs_execution_profile`。新建 Codex 任务后说：

```text
帮我完成 DSH Bridge 初次设置。所有配置先预览，确认后再写入。
```

Codex 会通过 `get_setup_status` 与 `discover_dsh_models` 读取 DSH 已配置的非敏感模型目录。首次创建 `bridge.yaml` 时，Codex 会先展示将要执行的精确 `setup` 命令；文件存在后的 Profile 变更使用 MCP 语义 Diff。若 DSH 没有可用 Provider，流程会停下并要求你先在 DSH Settings 中配置凭据；不要把密钥粘贴进 Codex 对话。

也可使用 CLI 指定已经确认的精确路由：

```bash
pnpm dsh-bridge models list --config "$BRIDGE_PROJECT/bridge.yaml" --details

pnpm dsh-bridge setup \
  --project "$BRIDGE_PROJECT" \
  --source "$BRIDGE_SOURCE" \
  --provider <provider-id> \
  --model <model-id> \
  --profile-id default-code \
  --reasoning-effort <advertised-effort>
```

首次设置完成后必须新建 Codex 任务，使运行 MCP 加载新配置。

## 5. 手动拆分安装

需要排障或自动化时，可以分别执行 `init` 与 `install`。`init` 支持显式模型参数；不要省略模型参数后直接使用示例路由：

```bash
cd "$BRIDGE_SOURCE"
pnpm dsh-bridge init "$BRIDGE_PROJECT" \
  --mode direct \
  --provider <provider-id> \
  --model <model-id> \
  --profile-id default-code \
  --reasoning-effort <advertised-effort>

pnpm dsh-bridge install \
  --source "$BRIDGE_SOURCE" \
  --codex \
  --dsh \
  --mode direct
```

安装器会：

1. 在 DSH Home 下创建或更新 `codex-bridge` Profile；
2. 让该 Profile 链接当前源码构建出的 DSH Plugin；
3. 注册仓库内本地 Codex Marketplace；
4. 安装并启用 `dsh-codex-bridge` Plugin；
5. 保留现有 Provider 凭据，不把密钥复制到目标项目。

DSH Profile 中已存在的 `cordis.yml` 和 `cordis.patch.yml` 作为用户组成/覆盖保留；安装器只更新它管理的 package/workspace 文件，且替换前备份到 Profile 内的 `.bridge-install-backups/`。如果同名目录不是 Bridge Profile，安装会拒绝覆盖。

目标项目已有 `bridge.yaml` 时，CLI 会拒绝覆盖；只有明确希望替换时才使用 `--force`。安装完成后必须新建 Codex 任务。已经打开的任务不会自动重新加载 Plugin 或 MCP 工具。

## 6. 健康检查

```bash
cd "$BRIDGE_SOURCE"
pnpm dsh-bridge doctor \
  --config "$BRIDGE_PROJECT/bridge.yaml" \
  --json \
  --redacted

pnpm dsh-bridge profiles validate \
  --config "$BRIDGE_PROJECT/bridge.yaml"

pnpm dsh-bridge profiles list \
  --config "$BRIDGE_PROJECT/bridge.yaml"
```

`doctor` 应报告：

- Node、DSH、Codex 和 Bridge 版本；
- `codex-bridge` DSH Profile 为 `ready`；
- 项目配置可解析；
- MCP 为 `ready`；
- 五个设置工具可发现：`get_setup_status`、`discover_dsh_models`、`preview_profile_change`、`apply_profile_change`、`rollback_profile_change`；
- 配置就绪后，八个执行工具也可发现：`list_profiles`、`delegate_task`、`get_task`、`wait_task`、`get_task_result`、`read_task_artifact`、`continue_task`、`cancel_task`。

`doctor` 不调用付费模型。Provider 和模型可用性要通过一个小任务或真实 E2E 验证。

## 7. 新增、切换与回滚执行 Profile

完整的模型入网有两步：

1. 在 DSH 中配置 Provider/Model 和凭据；
2. 在 Bridge 中创建或更新命名 Profile，使 Codex 能按用途路由。

新模型不需要 Bridge 发版或改代码，前提是 DSH 已经能通过它的 Provider Adapter 列出和调用该模型。

不要直接让 Codex 自由改写 YAML。Bridge 提供“预览 → 确认 → Revision 保护写入 → 验证”的受控路径：

```text
显示 DSH 当前可用模型。
把选中的模型添加成 fast-code Profile，先预览，不写入。
确认刚才的 Profile 修改。
把 fast-code 设为当前项目默认模型。
```

CLI 等价操作：

```bash
# 只预览；记录输出的 before_revision
pnpm dsh-bridge profiles add fast-code \
  --config "$BRIDGE_PROJECT/bridge.yaml" \
  --provider <provider-id> \
  --model <model-id> \
  --reasoning-effort high

# 用户审查后才写入
pnpm dsh-bridge profiles add fast-code \
  --config "$BRIDGE_PROJECT/bridge.yaml" \
  --provider <provider-id> \
  --model <model-id> \
  --reasoning-effort high \
  --apply \
  --expected-revision <before_revision>

# 预览切换已有 Profile 的路由
pnpm dsh-bridge profiles update fast-code \
  --config "$BRIDGE_PROJECT/bridge.yaml" \
  --provider <provider-id> \
  --model <new-model-id> \
  --reasoning-effort <advertised-effort>

# 审查后重复上一条命令，加上：
# --apply --expected-revision <before_revision>

# 默认 Profile 变更先预览
pnpm dsh-bridge profiles set-default fast-code \
  --config "$BRIDGE_PROJECT/bridge.yaml" \
  --project-id <project-id>

# 确认后重复 set-default，加上：
# --apply --expected-revision <before_revision>

pnpm dsh-bridge profiles rollback \
  --config "$BRIDGE_PROJECT/bridge.yaml" \
  --expected-revision <current_revision>
```

写入使用同目录临时文件、`0600` 权限和原子重命名；备份位于目标项目的 `.dsh-codex-bridge/config-backups/`。过期 Revision 会失败，必须重新预览。MCP 还会拒绝 DSH 实时目录中不存在的 Provider/Model 和已明确不支持的 Reasoning Effort。Provider 凭据仍由 DSH 管理，不会出现在 Diff 或备份中。

完整 Profile 结构示例：

```yaml
profiles:
  - protocol_version: bridge.dsh.dev/v1alpha1
    profile_id: deepseek-builder
    description: Focused implementation with optional DSH subagents.
    dsh:
      provider: deepseek-official
      model: deepseek-v4-flash
      reasoning_effort: high
      agent_preset: standard
      max_tokens: 32000
    delegation:
      max_depth: 2
      max_children: 3
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

完整字段说明见[配置参考](configuration.md)和 [`bridge.example.yaml`](../bridge.example.yaml)。配置中的部分资源策略属于公开契约，但当前 Alpha 仅对 Allowed Root、Worktree、任务超时、Artifact 大小和 Delegation 证据执行了完整 Bridge 侧约束；不要把声明字段误认为所有平台上的强隔离证明。

## 8. Native Shell Mode

只有需要 Codex 原生可见调度线程时才启用：

```bash
cd "$BRIDGE_PROJECT"
node "$BRIDGE_SOURCE/packages/cli/dist/index.js" init . \
  --mode native-shell \
  --codex-agent

node "$BRIDGE_SOURCE/packages/cli/dist/index.js" install \
  --source "$BRIDGE_SOURCE" \
  --codex \
  --dsh \
  --mode native-shell
```

必须在目标项目目录运行第二条命令，因为 Native Shell 安装会把 `.codex/agents/dsh-orchestrator.toml` 写入当前目录。它只是 Codex 调度外壳，DSH 仍负责真正执行，并会增加一层 Codex 用量。

## 9. 升级

```bash
cd "$BRIDGE_SOURCE"
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
pnpm verify
pnpm dsh-bridge install --source "$BRIDGE_SOURCE" --codex --dsh --mode direct
```

随后重新运行 `doctor`，并新建 Codex 任务。不要在未查看 Release Notes 和兼容矩阵时升级 DSH。

## 10. 安装失败

按顺序检查：

1. `node --version` 与 `dsh --version`；
2. 当前路径是否为完整源码 checkout；
3. `pnpm build` 是否成功；
4. 目标项目是否为 Git 顶层目录；
5. `bridge.yaml` 中的 Provider、Model 和 Preset 是否真实存在；
6. `pnpm dsh-bridge doctor --json --redacted` 的错误类别；
7. 新建 Codex 任务后 MCP 工具是否出现。

更多处理方式见[故障排查](troubleshooting.md)。

## 11. 卸载边界

当前 Alpha 没有自动卸载命令。不要递归删除整个 DSH Home 或 Codex Home。需要停用时，优先使用 Codex 的 Plugin 管理界面/命令停用 `dsh-codex-bridge`，并仅在确认目标后处理 `$DSH_HOME/profiles/codex-bridge`。项目中的 `bridge.yaml` 可以保留，以便以后恢复。
