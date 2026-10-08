# Configuration Reference

Bridge 配置的原则是：**用户选择 Profile，DSH 持有 Provider 凭据，已接入的安全上限由代码执行**。配置文件只描述路由和策略，不应成为秘密仓库；Alpha 中存在尚未完全映射到执行器的声明字段。

> 本页对应 Bridge `0.1.0-alpha.3` 与 `v1alpha1` Schema，目标 DSH 为 `0.2.0-rc.2`。新增字段必须先进入 JSON Schema 和配置校验。模型和推理档位来自 DSH 实时发现，不依赖文档中固定的模型列表。

## 1. 配置边界

```text
Codex task request
        ↓ 仅能请求已公开的 Profile/能力
Bridge config + project policy
        ↓ 代码校验安全上限
DSH codex-bridge Profile
        ↓ 读取 DSH 已配置的 Provider credential
Provider / Model / Agent Preset
```

Bridge 不接受以下内容：

- Provider API Key、Cookie、OAuth Refresh Token；
- 未注册的任意 Endpoint；
- 通过任务参数绕过 Allowed Root、网络策略或资源上限的请求；
- 把 DSH 内部 Cordis 对象或 Codex Thread ID 写入共享协议。

## 2. 配置来源与优先级

CLI 初始化会打印实际使用的配置路径。为避免不同操作系统上的路径误导，文档只约定逻辑层级：

1. **Hard safety ceiling**：代码内不可被用户或任务覆盖的上限；
2. **Project policy**：项目根目录允许的路径、网络和工作区策略；
3. **Profile configuration**：团队共享的执行语义和模型路由；
4. **Task request**：本次任务的目标、验收标准和少量受控覆盖。

有效规则为：

```text
hard safety ceiling
  > project policy
    > profile configuration
      > task request override
```

同一级别出现重复键时必须报错。任务请求不能把 `isolated_worktree` 改成 `direct_write`；`0.1.0-alpha.3` 不提供 `direct_write`。

### 运行时路径

安装时通过 `--dsh-bin` 或 `DSH_BRIDGE_DSH_BIN` 指定 Bridge 使用的 DSH 可执行文件。例如：

```bash
export DSH_BRIDGE_DSH_BIN=/absolute/path/to/dsh-bridge-runtime/node_modules/.bin/dsh
"$DSH_BRIDGE_DSH_BIN" --version
pnpm dsh-bridge setup \
  --project /absolute/path/to/project \
  --source /absolute/path/to/dsh-codex-bridge \
  --dsh-bin "$DSH_BRIDGE_DSH_BIN"
```

该路径应指向精确 `0.2.0-rc.2`。这让 Bridge 与已有 DSH 命令并存；直接运行 `dsh --version` 可能仍显示另一份安装。安装器把所选可执行路径、DSH Home 和源码路径保存到 `$CODEX_HOME/dsh-codex-bridge/runtime.json`，默认是 `~/.codex/dsh-codex-bridge/runtime.json`，不保存 Provider 密钥。

Plugin 提供 Setup/Delegate Skill，安装器用官方 `codex mcp add` 单独注册 STDIO MCP，明确指定绝对 Node、源码启动脚本和 `DSH_BRIDGE_RUNTIME_CONFIG`。启动器读取保存的配置，不依赖插件 `.mcp.json` 的变量展开。保留源码和专用运行时目录；使用自定义 `CODEX_HOME` 时，在同一个 Home 中运行安装和 `codex mcp get dsh-codex-bridge --json` 检查。

此启动配置由同一个 Codex Home 下的 Bridge 任务共用。CLI 中显式 `DSH_BRIDGE_DSH_BIN` / `DSH_HOME` 环境变量优先于保存值；要让 Desktop 使用新可执行文件或 Home，重新运行 `setup` 保存新值，再新建任务。不要只修改另一个终端的环境变量，或把 `env_vars` / `envVars` 加回旧插件 MCP JSON。单个项目的 Profile 修改仍只影响它自己的 `bridge.yaml`。

`DSH_HOME` 是 DSH 自己的数据和配置目录，与可执行文件路径不同。DSH 0.2 首次读取旧 Home 时可能迁移 `settings.yaml` 为 Profile 设置；使用旧 Home 前备份相关设置，或先通过独立 Home 验证。Provider/Model 必须在 `codex-bridge` Profile 中可见，另一个 Profile 已配置账号不代表 Bridge 自动可用。独立 Home 的设置由安装器一同保存；临时测试应使用测试专用 Home 和启动配置。

## 3. 最小配置

当前 `v1alpha1` 配置形态如下。它与仓库根目录的 [`bridge.example.yaml`](../bridge.example.yaml) 使用相同字段；字段使用 snake_case，未知字段会被拒绝。这是结构示例，先把 Provider/Model 替换为实际发现的精确 ID：

```yaml
protocol_version: bridge.dsh.dev/v1alpha1
data_root: .dsh-codex-bridge
log_level: info

projects:
  - project_id: this-project
    root: .
    default_profile: typescript_worker

profiles:
  - protocol_version: bridge.dsh.dev/v1alpha1
    profile_id: typescript_worker
    description: 小范围 TypeScript 实现与测试
    dsh:
      provider: returned-provider-id
      model: returned-model-id
      agent_preset: standard
      max_tokens: 32000
    delegation:
      max_depth: 0
      max_children: 0
      roles: {}
    workspace:
      mode: isolated_worktree
      allowed_roots:
        - .
    policy:
      network: restricted
      allowed_domains: []
      denied_paths:
        - .env
        - .git
      timeout_seconds: 1800
      max_artifact_bytes: 10485760
      max_output_bytes: 1048576
      max_files: 1000
      disk_quota_bytes: 1073741824
```

`returned-provider-id` 和 `returned-model-id` 是占位值，不能直接用于任务。`standard` 是初始化使用的 Agent Preset，也需要在目标 DSH Profile 中可用。完成安装后先发现模型，再校验配置：

```bash
pnpm dsh-bridge models list --config /absolute/path/to/project/bridge.yaml --details
pnpm dsh-bridge profiles list --config /absolute/path/to/project/bridge.yaml
pnpm dsh-bridge profiles validate --config /absolute/path/to/project/bridge.yaml
```

## 4. 新模型入网与受控修改

Bridge 不维护固定的模型白名单。新模型经 DSH Provider Adapter 列出并符合当前契约时，可以通过配置接入，而无需逐个修改 Bridge 代码。要被 Codex 调度，它需要两层配置：

```text
DSH Provider/Model（Adapter + 凭据）
        ↓ discover_dsh_models
Bridge Profile（用途 + 路由 + 预算 + 安全边界）
        ↓ list_profiles
Codex 委派
```

DSH 0.2 的 Provider 配置按 Profile 保存。需要复用同一 Home 中 `web` 的配置时，使用 `models sync --from-profile web` 默认预览，审查后加 `--apply --expected-revision 'before_revision-from-sync-preview'`。同步只改变 `profiles/codex-bridge/cordis.patch.yml`，备份旧文件，不改变项目 `bridge.yaml`；支持静态 Provider 配置和安全环境变量引用，拒绝字面密钥和动态表达式。同步后的路由仍需经过发现并映射成 Bridge Profile。

首次设置：

```bash
pnpm dsh-bridge models list --config /path/to/project/bridge.yaml --details
DSH_PROVIDER_ID='returned-provider-id'
DSH_MODEL_ID='returned-model-id'
pnpm dsh-bridge setup \
  --project /path/to/project \
  --source /path/to/dsh-codex-bridge \
  --provider "$DSH_PROVIDER_ID" \
  --model "$DSH_MODEL_ID" \
  --profile-id default-code
```

只在所选模型返回支持的 `reasoning_efforts` 时才添加 `--reasoning-effort 'advertised-effort-id'`。省略时不为首次配置强加固定档位。DSH 目录中的模型可能随上游版本变化；历史 Flash/Kimi ID 和官方产品名称不能替代目录返回的路由 ID。

已有配置的变更使用两阶段事务：

1. `preview_profile_change` 或 CLI 默认模式返回语义 Diff 和 `before_revision`；
2. 用户审核后，`apply_profile_change` 或 `--apply --expected-revision <before_revision>` 才写入。

```bash
# 预览小范围模型切换
# 先把两个模型变量换成新路由的精确值
pnpm dsh-bridge profiles update fast-code \
  --config /path/to/project/bridge.yaml \
  --provider "$DSH_PROVIDER_ID" \
  --model "$DSH_MODEL_ID"

# 审核后重复上一条命令，并加上
# --apply --expected-revision <before_revision>
```

更新路由时，未提交的推理字段会保留原值。新模型不使用原档位时，明确清除它：

```bash
pnpm dsh-bridge profiles update fast-code \
  --config /path/to/project/bridge.yaml \
  --clear-reasoning-effort
# 可和新 --provider/--model 一起使用；审查后加 --apply 和预览 Revision。
```

`--clear-reasoning-effort` 与 `--reasoning-effort` 互斥。MCP 的等价 `ProfileChange` 如下；它只清除档位，保留路由和安全策略：

```json
{
  "operation": "update",
  "profile_id": "fast-code",
  "changes": {},
  "clear_reasoning_effort": true
}
```

把该对象作为 `preview_profile_change` 的 `change` 预览；写入时向 `apply_profile_change` 传同一对象和预览的 `before_revision`。

写入前会重新校验 Revision，使用同目录临时文件、`0600` 权限、`fsync` 和原子重命名。备份有界保留在 `.dsh-codex-bridge/config-backups/`；回滚也需要当前 Revision。过期 Revision、敏感字段、DSH 目录中不存在的路由或已明确不支持的 Reasoning Effort 都会失败，不做静默降级。

`profiles add/update/set-default/remove` 默认只预览，`--apply` 才写入；`profiles rollback` 则直接执行受 Revision 保护的回滚。回滚需要最近一次写入结果的 `config_revision`，而不是写入前的 `before_revision`。这些操作只改变当前配置文件，不会为 DSH 新增凭据、修改全局模型默认值或更新其他项目。

运行中的 Turn 与历史结果保留原状态。新 MCP 进程加载配置后，新任务使用新路由；`continue_task` 保持原 Task/Session/Worktree，但新 Run 会按该任务原 `profile_id` 的当前配置重新选择模型。变更项目默认 Profile 不会更改旧任务的 Profile ID。已有 Session 的 `dsh.agent_preset` 必须与其历史 Preset 匹配；续接时更换 Preset 会被拒绝，应为新 Preset 创建新任务。

## 5. Profile 设计

Profile 是稳定的用户语义层。它应描述“什么类型的工作、允许什么边界、使用什么预算”，而不是让每个 Codex 任务直接拼接模型名。

### 常用字段

| 字段                        | 含义                    | 约束                                     |
| --------------------------- | ----------------------- | ---------------------------------------- |
| `description`               | 给 Codex 和用户看的用途 | 应说明能力和限制                         |
| `dsh.provider`              | DSH Provider ID         | 必须已在 DSH 配置中存在                  |
| `dsh.model`                 | Provider 下的模型标识   | 必须通过能力探测或 Contract Test         |
| `dsh.reasoning_effort`      | 推理强度                | 不支持时明确失败，不静默降级             |
| `dsh.agent_preset`          | DSH Agent Preset        | 需验证适合无人值守执行                   |
| `dsh.max_tokens`            | 单次预算                | 受硬上限约束                             |
| `delegation.max_depth`      | Bridge 递归深度         | 超限时在创建任务前失败                   |
| `delegation.max_children`   | DSH 子 Agent 上限       | `0` 表示不允许多 Agent                   |
| `delegation.roles`          | 允许的子角色与路由      | Codex 只能请求这里声明的角色 ID          |
| `workspace.mode`            | 工作区策略              | MVP 推荐 `isolated_worktree`             |
| `policy.network`            | 网络级别声明            | Schema 可校验，Bridge 执行器尚未完整接入 |
| `policy.timeout_seconds`    | Wall-clock 超时         | 不能绕过全局上限                         |
| `policy.max_artifact_bytes` | 单任务产物上限          | 防止上下文和磁盘膨胀                     |

当前代码完整执行 Allowed Root、Git Worktree、任务超时、Artifact 大小、委派深度和委派证据边界。`network`、`allowed_domains`、`denied_paths`、`max_output_bytes`、`max_files`、`disk_quota_bytes` 已进入公开 Schema，但尚未全部映射为 Bridge 侧执行器；它们不能作为已经验证的强隔离承诺。

### 多角色路由

复杂 Profile 可以给 DSH 内部 Sub-Agent 设置受控角色路由：

```yaml
profiles:
  - protocol_version: bridge.dsh.dev/v1alpha1
    profile_id: multi_model_worker
    description: '主实现 + 快速检查 + 审查'
    dsh:
      provider: returned-provider-id
      model: returned-model-id
      agent_preset: standard
      max_tokens: 48000
    delegation:
      max_depth: 2
      max_children: 3
      roles:
        fast:
          provider: returned-provider-id
          model: example-fast-model
        reviewer:
          provider: returned-provider-id
          model: example-review-model
```

上例只展示路由片段；可直接加载的配置还必须补齐 `protocol_version`、`profile_id`、`workspace` 和 `policy` 等必填字段。复制完整配置时，以 [`bridge.example.yaml`](../bridge.example.yaml) 和生成的 JSON Schema 为准。

Bridge 当前会校验角色 ID，把角色职责写入 Root Agent Prompt，并从 Session Event 验证实际子调用。DSH `spawn` 子 Agent 仍遵循所选 Preset 的有效模型路由；角色中的独立 Provider/Model 强制路由需要 DSH Child Setup Contract Test 完成后才能宣称生效。需要确定的跨模型执行时，应使用多个命名 Profile 和独立 Bridge Task，不能只依赖角色声明。

### 自动单/多 Agent 决策

`delegate_task` 可携带：

```yaml
delegation:
  strategy: auto # auto | single | multi
  reason: 实现与独立测试审查可以并行完成
  roles: [analysis, tests]
```

解析规则是确定性的：显式 `single` / `multi` 不会被改写；`auto` 有合法角色时解析为 `multi`，否则解析为 `single`。Codex Skill 负责用与原生子 Agent 相同的原则判断工作流独立性，Bridge 负责校验上限并记录 `delegation_decision`。

结果中的 `delegation_evidence` 来自本次 DSH Run 区间的 `tool/call` 与 `tool/result`，记录调用数、完成数、失败数和工具名。单 Agent 出现子调用、多 Agent 缺少足够调用/完成证据、子调用失败或超过 Profile 上限时，任务进入 `partial` 并返回明确 Warning。

## 6. Direct Mode 与 Native Shell

当前配置 Schema 不把 Host 运行模式写入 `BridgeConfig`。模式由 Codex Plugin/CLI 安装时选择，避免把 Codex 私有线程概念带进 Host-neutral 配置：

```bash
pnpm dsh-bridge install --source . --codex --dsh --mode direct
pnpm dsh-bridge install --source . --codex-agent --mode native-shell
```

- `direct`：Codex 主线程直接调用 Bridge MCP。默认推荐，额外 Codex 用量最低。
- `native-shell`：Codex 先调用项目级 `dsh_orchestrator` Agent，再由其调用同一 MCP。它增加可见的调度线程，但不会改变 DSH 模型路由。

两者不应共享一份隐式、不可追踪的状态。每个 Task 都需要记录 `origin`、`trace_id`、`delegation_depth` 和 `profile_id`，避免递归委派。

## 7. 工作区策略

```yaml
workspace:
  allowed_roots:
    - /absolute/path/to/projects
  mode: isolated_worktree
```

### `isolated_worktree`（默认）

每个 Task 创建独立 Worktree，DSH 的 Session CWD 指向该目录。结果返回 Diff、Changed Files、测试证据和冲突信息；Bridge 不自动覆盖主分支。

### `read_only`（任务级扩展目标）

只读检查或分析任务。`0.1.0-alpha.3` 的 Workspace Schema 有效模式为 `isolated_worktree` 和 `patch_only`；`read_only` 不是有效配置值，不要把它写进 `bridge.yaml`。

### `patch_only`（后续兼容能力）

用于没有 Git Worktree 能力的项目。实现前不应在文档或 CLI 中假设它已经可用。

### `direct_write`（MVP 禁用）

直接写用户主工作区会扩大误操作和回滚风险。`0.1.0-alpha.3` 不提供该模式。

## 8. 并发、预算与递归

当前 `v1alpha1` 把任务级限制放在 Profile 的 `delegation` 和 `policy` 中；全局/项目级 Semaphore、`max_changed_files` 等运行时约束不作为配置字段，不应直接添加到配置文件：

```yaml
delegation:
  max_depth: 2
  max_children: 3
policy:
  timeout_seconds: 1800
  max_artifact_bytes: 10485760
  max_output_bytes: 1048576
  max_files: 1000
  disk_quota_bytes: 1073741824
```

这些值只是目标示例，最终有效值还会受到代码硬上限和 Provider 限流影响。达到上限时返回结构化错误；不能悄悄改用更弱模型、无限等待或继续创建子 Agent。

Bridge Profile 默认禁用反向 Codex Provider，以避免：

```text
Codex → Bridge → DSH → Codex → Bridge → ...
```

递归检测使用 `origin`、`trace_id` 和 `delegation_depth`，而不是依赖 Prompt 提醒。

## 9. Provider 与秘密

DSH 负责 Provider 的凭据和认证。Bridge 配置只保存引用：

```yaml
dsh:
  provider: returned-provider-id
  model: returned-model-id
```

禁止这样写：

```yaml
# 不要这样做
apiKey: sk-...
endpoint: https://private.example.invalid
```

`profiles validate` 检查配置结构和项目路径，不向 Provider 验证凭据。`doctor` 检查版本、Profile 合成和 MCP；`models list` 检查可发现的模型路由。账号认证、模型调用权限和实际生成要通过小任务验证，不能从前三项通过推断。

## 10. Artifact 与日志

目标目录布局和生命周期见 [软件架构规划](architecture.md)。建议：

- 任务元数据、事件和产物分开保存；
- 大 Patch 只通过 Artifact ID、SHA-256、字节数和分页接口读取；
- JSONL 记录状态、工具、命令、退出码和耗时，不记录隐藏推理；
- 清理前确认 Task 已经进入终态，并检查该任务的 Worktree 和产物范围；
- 任何日志在写入和返回前都做 Token、Cookie、Authorization Header 脱敏。

## 11. 变更、升级与回滚

升级顺序：

1. 阅读 Release Notes 和 Compatibility Matrix；
2. 在隔离环境运行 `pnpm dsh-bridge doctor --json --redacted` 与 Profile Contract Test；
3. 确认 Codex Plugin、DSH Plugin 和共享协议版本相同；
4. 使用一个小范围 Worktree 任务验证实际 Provider 调用和结果；
5. 通过后再切换默认版本。

当前 DSH 目标锁定为 `0.2.0-rc.2`。不要使用未锁定的 `latest` 替代；Bridge 和 DSH 的升级应分别查看兼容矩阵，并保留可恢复的旧运行时。

## 12. 配置检查命令

```bash
pnpm dsh-bridge config show --effective --redacted
pnpm dsh-bridge profiles list
pnpm dsh-bridge profiles validate
pnpm dsh-bridge doctor --json --redacted
```

这些命令由 `0.1.0-alpha.3` CLI 提供。共享输出前仍应检查项目路径和私有内容。真实模型测试的费用和证据范围见[入门页](getting-started.md#8-真实-dsh-闭环验证)及[兼容矩阵](compatibility.md)。
