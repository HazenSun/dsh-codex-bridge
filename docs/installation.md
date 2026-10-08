# 安装手册

本手册对应 DSH Codex Bridge `0.1.0-alpha.3`，目标 DSH 为官方 npm `0.2.0-rc.2`。Bridge 当前从 GitHub 源码安装；Bridge npm 包和公共 Codex Plugin Directory 尚未发布。

希望让 Codex 完成整个流程时，可复制 [README 的安装提示词](../README.md#让-codex-完成安装和首次配置)，提供目标 Git 项目、Bridge 源码和专用 DSH 安装目录。以下是同一流程的手动命令。

## 1. 支持范围

| 组件     | 要求                                                             |
| -------- | ---------------------------------------------------------------- |
| 操作系统 | 当前版本的本地/CI/真实模型验证分别见[兼容矩阵](compatibility.md) |
| Node.js  | `^22.19.0` 或 `>=24.0.0`                                         |
| pnpm     | `11.19.0`，建议通过 Corepack 使用                                |
| Git      | 支持 `git worktree` 的版本                                       |
| DSH      | 精确锁定官方 npm `0.2.0-rc.2`，可与已有安装并存                  |
| Codex    | 支持本地 Plugin 和 STDIO MCP 的 CLI 或 Desktop                   |
| 项目     | 当前运行时只支持 Git 顶层目录                                    |

DSH 处于 Developer Preview。Bridge 不承诺其他 DSH RC 版本兼容；升级前先查看[兼容矩阵](compatibility.md)。

## 2. 安装前检查

```bash
node --version
corepack --version
git --version
codex --version
```

为 Bridge 选择专用安装目录，使用精确版本安装 DSH。此命令不替换全局 `dsh`：

```bash
BRIDGE_RUNTIME=/absolute/path/to/dsh-bridge-runtime
npm install --prefix "$BRIDGE_RUNTIME" --no-audit --no-fund @deepseek-ai/dsh@0.2.0-rc.2
export DSH_BRIDGE_DSH_BIN="$BRIDGE_RUNTIME/node_modules/.bin/dsh"
"$DSH_BRIDGE_DSH_BIN" --version
```

应输出 `0.2.0-rc.2`。安装时可用 `--dsh-bin` 或 `DSH_BRIDGE_DSH_BIN` 选择这一路径；安装 Codex Plugin 时会保存选择，之后 CLI 和 MCP 可以直接读取。直接运行 `dsh --version` 仍可能显示机器原有版本，这是并存安装的正常结果。

`DSH_BRIDGE_DSH_BIN` 选择程序，`DSH_HOME` 选择 DSH 配置/数据目录。DSH 0.2 首次使用旧 Home 时可能把旧 `settings.yaml` 迁移为 Profile 设置；先备份现有设置及相关 Profile 配置。希望先验证新版、让旧实例继续使用原数据时，指定独立 Home：

```bash
BRIDGE_DSH_DATA=/absolute/path/to/dsh-bridge-data
export DSH_HOME="$BRIDGE_DSH_DATA"
```

在选择的 Home 中，Provider/Model 必须对 `codex-bridge` Profile 可见。独立 Home 没有原有账号配置，需要在 DSH 中设置 Provider；仅指向同一个 Home 也不代表所有其他 Profile 的模型会自动成为 Bridge 路由。Bridge 安装器管理 `profiles/codex-bridge`，上游 DSH 的首次设置迁移则是另一项文件变化。

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
0.1.0-alpha.3
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
  --dsh-bin "$DSH_BRIDGE_DSH_BIN" \
  --dry-run

pnpm dsh-bridge setup \
  --project "$BRIDGE_PROJECT" \
  --source "$BRIDGE_SOURCE" \
  --dsh-bin "$DSH_BRIDGE_DSH_BIN"
```

第二条命令安装 DSH `codex-bridge` Profile 和 Codex Plugin，并将所选 DSH 可执行路径与 Home 写入 `$CODEX_HOME/dsh-codex-bridge/runtime.json`；未设置 `CODEX_HOME` 时，默认位置是 `~/.codex/dsh-codex-bridge/runtime.json`。该文件只保存启动路径，不保存 Provider 密钥。

安装器通过官方 `codex mcp add` 注册本地 STDIO MCP，明确保存 Node 可执行文件、启动脚本和 `DSH_BRIDGE_RUNTIME_CONFIG` 的绝对路径。启动器每次读取这个文件，因此 Codex Desktop 无需继承终端 `export`，也不依赖插件 JSON 展开 `${PLUGIN_ROOT}` 或 `${CODEX_HOME}`。启动配置由同一个 Codex Home 下的 Bridge 任务共用；切换运行时或 DSH Home 会影响后续 MCP 启动，项目模型 Profile 则仍由各自的 `bridge.yaml` 管理。CLI 中的 `DSH_BRIDGE_DSH_BIN` 和 `DSH_HOME` 可覆盖保存值；要让 Desktop 使用新选择，重新运行 `setup` 保存它们。

用 `codex mcp get dsh-codex-bridge --json` 检查注册路径。只安装 Marketplace 中的 Skill 插件不足以注册本机 MCP。安装器会拒绝覆盖同名但不是 Bridge 管理的 MCP Server；遇到冲突时，先检查其用途，不要直接删除其他服务。

注册路径引用 Bridge 源码中的启动脚本和专用 DSH 可执行文件，安装后保留这两个目录。源码、Node 或 DSH 路径移动后，使用新路径重新运行 `setup`，再检查注册。自定义 Codex Home 时，在安装、检查和停用命令前指定同一个 Home，例如：

```bash
BRIDGE_CODEX_DATA=/absolute/path/to/codex-home
CODEX_HOME="$BRIDGE_CODEX_DATA" pnpm dsh-bridge setup \
  --project "$BRIDGE_PROJECT" --source "$BRIDGE_SOURCE" \
  --dsh-bin "$DSH_BRIDGE_DSH_BIN" --dry-run
# 审查后在同一个 CODEX_HOME 下去掉 --dry-run 执行。
CODEX_HOME="$BRIDGE_CODEX_DATA" codex mcp get dsh-codex-bridge --json
```

Plugin 提供 Setup/Delegate Skill；MCP 由安装器通过 Codex CLI 单独注册。已验证的 Codex `0.156.1` 不会可靠展开旧插件 MCP JSON 中的 `${PLUGIN_ROOT}` / `${CODEX_HOME}`，也不能靠 `env_vars` / `envVars` 修复路径。当前插件不再使用 `.mcp.json` 或 manifest `mcpServers` 注册，不需要手工添加这些字段。

没有指定模型时，安装返回 `needs_execution_profile`，表示目标项目尚未选择执行路由。安装后的插件 Setup 入口会启动 `setup-dsh-bridge` Skill；也可以新建 Codex 任务后说：

```text
帮我完成 DSH Bridge 初次设置。所有配置先预览，确认后再写入。
```

Codex 会通过 `get_setup_status` 与 `discover_dsh_models` 读取 `codex-bridge` Profile 可见的非敏感模型目录。首次创建 `bridge.yaml` 时，Codex 展示精确 `setup` 命令；文件存在后的 Profile 变更使用 MCP 语义 Diff。若没有可用 Provider，先在对应 DSH Profile 中配置；不要把密钥粘贴进 Codex 对话。

### 复用已有 DSH 模型配置

如果同一个 DSH Home 的 `web` Profile 已有模型配置，但 Bridge 的目录中没有路由，先预览同步：

```bash
pnpm dsh-bridge models sync --from-profile web
```

输出只包含来源/目标 Profile、`provider_entries` 和 `before_revision` 等状态，不打印 Endpoint 或凭据内容。审查后重复命令并携带该 Revision：

```bash
pnpm dsh-bridge models sync --from-profile web \
  --apply --expected-revision 'before_revision-from-sync-preview'
```

同步只写当前 DSH Home 的 `profiles/codex-bridge/cordis.patch.yml`，先备份再替换，返回 `restart_required: true`；它不写 `bridge.yaml`。仅同步受支持的 Provider 配置及 `apiKeyEnv` 等安全引用，拒绝字面密钥和不受支持的动态表达式。来源 Profile 可通过 `--from-profile` 选择，但必须在同一个 Home；独立 Home 不会自动复制另一个 Home 的账号。

环境变量引用需要在 DSH 启动环境中实际可用；`runtime.json` 不保存变量的秘密值。同步后重新执行 `models list`，确认路由，再建立下面的 Bridge Profile。后续 Codex 执行使用新任务加载配置。

也可使用 CLI 指定已经确认的精确路由：

```bash
pnpm dsh-bridge models list --config "$BRIDGE_PROJECT/bridge.yaml" --details

# 将两个值替换为目录返回的精确 ID
DSH_PROVIDER_ID='returned-provider-id'
DSH_MODEL_ID='returned-model-id'
pnpm dsh-bridge setup \
  --project "$BRIDGE_PROJECT" \
  --source "$BRIDGE_SOURCE" \
  --provider "$DSH_PROVIDER_ID" \
  --model "$DSH_MODEL_ID" \
  --profile-id default-code
```

`models list` 可以在 `bridge.yaml` 尚不存在时运行；目标项目目录必须已存在，DSH `codex-bridge` Profile 必须已安装。只有在目录明确返回所选模型的推理档位时才添加 `--reasoning-effort 'advertised-effort-id'`。不要把历史 Flash/Kimi 名称或示例值当作当前可用 ID。

首次设置完成后必须新建 Codex 任务，使运行 MCP 加载新配置。

## 5. 手动拆分安装

需要排障或自动化时，可以分别执行 `install` 与 `init`。先安装 Profile 并发现精确路由，再初始化项目：

```bash
cd "$BRIDGE_SOURCE"
pnpm dsh-bridge install \
  --source "$BRIDGE_SOURCE" \
  --dsh-bin "$DSH_BRIDGE_DSH_BIN" \
  --codex \
  --dsh \
  --mode direct

pnpm dsh-bridge models list --config "$BRIDGE_PROJECT/bridge.yaml" --details
# 根据发现结果设置 DSH_PROVIDER_ID 和 DSH_MODEL_ID，再执行：
pnpm dsh-bridge init "$BRIDGE_PROJECT" \
  --mode direct \
  --provider "$DSH_PROVIDER_ID" \
  --model "$DSH_MODEL_ID" \
  --profile-id default-code
```

安装器会：

1. 在 DSH Home 下创建或更新 `codex-bridge` Profile；
2. 让该 Profile 链接当前源码构建出的 DSH Plugin；
3. 注册仓库内本地 Codex Marketplace；
4. 安装并启用提供 Setup/Delegate Skill 的 `dsh-codex-bridge` Plugin；
5. 通过 `codex mcp add` 单独注册本地 MCP，使用绝对 Node、源码启动脚本和运行时配置路径；
6. 保留现有 Provider 凭据，不把密钥复制到目标项目。

DSH Profile 中已存在的 `cordis.yml` 和 `cordis.patch.yml` 作为用户组成/覆盖保留；安装器只更新它管理的 package/workspace 文件，且替换前备份到 Profile 内的 `.bridge-install-backups/`。如果同名目录不是 Bridge Profile，安装会拒绝覆盖。

目标项目已有 `bridge.yaml` 时，`init` 会拒绝覆盖；只有明确希望替换时才使用 `--force`。已有配置的日常修改应使用下文的 Profile 预览/写入命令。安装完成后必须新建 Codex 任务。已经打开的任务不会自动重新加载 Plugin 或 MCP 工具。

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

配置就绪后，`doctor` 检查：

- Node、DSH、Codex 和 Bridge 版本；
- `codex-bridge` DSH Profile 为 `ready`；
- 项目配置可解析；
- MCP 为 `ready`；
- 五个设置工具可发现：`get_setup_status`、`discover_dsh_models`、`preview_profile_change`、`apply_profile_change`、`rollback_profile_change`；
- 配置就绪后，八个执行工具也可发现：`list_profiles`、`delegate_task`、`get_task`、`wait_task`、`get_task_result`、`read_task_artifact`、`continue_task`、`cancel_task`。

`doctor` 不调用付费模型。Provider 和模型可用性要通过一个小任务或真实 E2E 验证。

`profiles validate` 校验配置结构和项目路径，也不验证 Provider 账号权限。安装验收可以止于 `doctor`、配置校验和模型发现；需要验证执行时再单独运行任务。

## 7. 新增、切换与回滚执行 Profile

完整的模型入网有两步：

1. 在 DSH 中配置对 `codex-bridge` Profile 可见的 Provider/Model 和凭据；
2. 在 Bridge 中创建或更新命名 Profile，使 Codex 能按用途路由。

新模型符合当前 DSH/Bridge 契约时，可以通过配置接入，前提是 DSH Provider Adapter 能列出和调用该模型。

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
  --provider "$DSH_PROVIDER_ID" \
  --model "$DSH_MODEL_ID"

# 用户审查后才写入
pnpm dsh-bridge profiles add fast-code \
  --config "$BRIDGE_PROJECT/bridge.yaml" \
  --provider "$DSH_PROVIDER_ID" \
  --model "$DSH_MODEL_ID" \
  --apply \
  --expected-revision 'before_revision-from-preview'

# 预览切换已有 Profile 的路由
# 先把 DSH_PROVIDER_ID/DSH_MODEL_ID 换成新路由的精确值
pnpm dsh-bridge profiles update fast-code \
  --config "$BRIDGE_PROJECT/bridge.yaml" \
  --provider "$DSH_PROVIDER_ID" \
  --model "$DSH_MODEL_ID"

# 审查后重复上一条命令，加上：
# --apply --expected-revision <before_revision>

# 预览清除旧推理档位，改用模型默认值
pnpm dsh-bridge profiles update fast-code \
  --config "$BRIDGE_PROJECT/bridge.yaml" \
  --clear-reasoning-effort

# 可以与新 --provider/--model 在同一次 update 中使用
# 审查后重复命令，加 --apply --expected-revision <before_revision>

# 默认 Profile 变更先预览
pnpm dsh-bridge profiles set-default fast-code \
  --config "$BRIDGE_PROJECT/bridge.yaml" \
  --project-id 'project-id-from-config'

# 确认后重复 set-default，加上：
# --apply --expected-revision <before_revision>

# 预览删除；已有项目使用时指定替代 Profile
pnpm dsh-bridge profiles remove fast-code \
  --config "$BRIDGE_PROJECT/bridge.yaml" \
  --replacement default-code

# 审查后重复 remove，加上：
# --apply --expected-revision <before_revision>

pnpm dsh-bridge profiles rollback \
  --config "$BRIDGE_PROJECT/bridge.yaml" \
  --expected-revision 'current-config_revision'
```

先用 `config show --config "$BRIDGE_PROJECT/bridge.yaml" --redacted` 读取项目 ID。`profiles add/update/set-default/remove` 不带 `--apply` 时只预览；`profiles rollback` 直接执行回滚，使用最近一次写入结果返回的 `config_revision`。过期 Revision 时重新预览并审查，不重复使用旧值。

`profiles update` 省略推理选项时会保留原值。切到不同模型时先检查 Diff；需要清除旧值则使用 `--clear-reasoning-effort`，不能同时传 `--reasoning-effort`。MCP 等价字段是 `update.clear_reasoning_effort: true`，同样需要预览和 Revision 保护。

Profile 写入不改变正在执行的 Turn 或历史结果。加载新配置需要重启 MCP；之后新任务使用新配置，旧任务 `continue_task` 的新 Run 使用该任务原 `profile_id` 当前的路由。切换项目默认 Profile 不会自动替换旧任务的 Profile ID。已有 Session 续接时，Agent Preset 必须与历史匹配，不能在继续时更换。

写入使用同目录临时文件、`0600` 权限和原子重命名；备份位于目标项目的 `.dsh-codex-bridge/config-backups/`。过期 Revision 会失败，必须重新预览。MCP 还会拒绝 DSH 实时目录中不存在的 Provider/Model 和已明确不支持的 Reasoning Effort。Provider 凭据仍由 DSH 管理，不会出现在 Diff 或备份中。

完整 Profile 结构示例：

```yaml
profiles:
  - protocol_version: bridge.dsh.dev/v1alpha1
    profile_id: default-code
    description: Focused implementation with optional DSH subagents.
    dsh:
      provider: returned-provider-id
      model: returned-model-id
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

这段是 Profile 结构示例，Provider/Model 必须替换为实际值。完整字段说明见[配置参考](configuration.md)和 [`bridge.example.yaml`](../bridge.example.yaml)。配置中的部分资源策略属于公开契约，但当前 Alpha 仅对 Allowed Root、Worktree、任务超时、Artifact 大小和 Delegation 证据执行了完整 Bridge 侧约束。

## 8. Native Shell Mode

只有需要 Codex 原生可见调度线程时才启用：

```bash
cd "$BRIDGE_SOURCE"
pnpm dsh-bridge setup \
  --project "$BRIDGE_PROJECT" \
  --source "$BRIDGE_SOURCE" \
  --mode native-shell \
  --codex-agent
```

已有 `bridge.yaml` 时，`setup` 保留现有执行 Profile，并把 `.codex/agents/dsh-orchestrator.toml` 写入 `--project` 指定的项目。首次设置仍需发现并选择模型；不要用缺少模型参数的 `init`。Native Shell 是 Codex 调度外壳，DSH 负责执行，会增加一层 Codex 用量。

## 9. 升级

```bash
cd "$BRIDGE_SOURCE"
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
pnpm verify
pnpm dsh-bridge install --source "$BRIDGE_SOURCE" --codex --dsh --mode direct
```

升级前检查未提交修改，不要强制覆盖源码或锁文件。命令读取已保存的运行时；如需新 DSH 版本，安装到新的专用目录，再查看[兼容矩阵](compatibility.md)，通过 `install --dsh-bin /absolute/path/to/new/dsh` 保存新选择。首次启动涉及 DSH 设置迁移时，先备份或使用独立 Home 验证。随后重新运行 `doctor` 并新建 Codex 任务。

## 10. 安装失败

按顺序检查：

1. `node --version`，以及 `doctor` 的 `dsh_command`、`dsh` 和 `expected_dsh`；
2. 当前路径是否为完整源码 checkout；
3. `pnpm build` 是否成功；
4. 目标项目是否为 Git 顶层目录；
5. `bridge.yaml` 中的 Provider、Model 和 Preset 是否真实存在；
6. `pnpm dsh-bridge doctor --json --redacted` 的错误类别；
7. 新建 Codex 任务后 MCP 工具是否出现。

更多处理方式见[故障排查](troubleshooting.md)。

## 11. 卸载边界

当前 Alpha 没有自动卸载命令。停用时，先在 Codex Plugin 管理中停用 `dsh-codex-bridge`；确认没有其他 Bridge 项目使用后，在安装时相同的 Codex Home 下用 `codex mcp remove dsh-codex-bridge` 移除本地 MCP，再处理专用运行时、`runtime.json` 和 DSH Home 中的 `profiles/codex-bridge`。停用 Skill 插件本身不会删除这个用户级 MCP 注册。项目中的 `bridge.yaml` 可保留以便恢复。不要删除整个 DSH Home 或 Codex Home。
