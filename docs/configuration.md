# Configuration Reference

Bridge 配置的原则是：**用户选择 Profile，DSH 持有 Provider 凭据，已接入的安全上限由代码执行**。配置文件只描述路由和策略，不应成为秘密仓库；Alpha 中存在尚未完全映射到执行器的声明字段。

> 本页的 YAML 遵循 `0.1.0-alpha.1` 使用的 `v1alpha1` Schema。新增字段必须先进入 JSON Schema、`pnpm dsh-bridge profiles validate` 和兼容矩阵；未知字段、未知 Reasoning ID 和越过安全上限的覆盖必须失败，而不是静默降级。

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

同一级别出现重复键时必须报错。任务请求不能把 `isolated_worktree` 改成 `direct_write`；`0.1.0-alpha.1` 不提供 `direct_write`。

## 3. 最小配置

当前 `v1alpha1` 配置文件的 canonical 形态如下。它与仓库根目录的 [`bridge.example.yaml`](../bridge.example.yaml) 保持同一字段命名；字段使用 snake_case，未知字段会被拒绝。示例只引用 DSH 中已经存在的 Provider 和 Preset，不包含任何密钥：

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
      provider: openrouter-main
      model: example-coding-model
      reasoning_effort: medium
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

`openrouter-main`、`example-coding-model` 和 `standard` 是示例标识，不代表 Bridge 内置或 DSH 一定提供。使用前运行：

```bash
pnpm dsh-bridge profiles list
pnpm dsh-bridge profiles validate
```

## 4. Profile 设计

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
      provider: openrouter-main
      model: example-coding-model
      reasoning_effort: high
      agent_preset: standard
      max_tokens: 48000
    delegation:
      max_depth: 2
      max_children: 3
      roles:
        fast:
          provider: openrouter-main
          model: example-fast-model
        reviewer:
          provider: openrouter-main
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

## 5. Direct Mode 与 Native Shell

当前配置 Schema 不把 Host 运行模式写入 `BridgeConfig`。模式由 Codex Plugin/CLI 安装时选择，避免把 Codex 私有线程概念带进 Host-neutral 配置：

```bash
pnpm dsh-bridge install --source . --codex --dsh --mode direct
pnpm dsh-bridge install --source . --codex-agent --mode native-shell
```

- `direct`：Codex 主线程直接调用 Bridge MCP。默认推荐，额外 Codex 用量最低。
- `native-shell`：Codex 先调用项目级 `dsh_orchestrator` Agent，再由其调用同一 MCP。它增加可见的调度线程，但不会改变 DSH 模型路由。

两者不应共享一份隐式、不可追踪的状态。每个 Task 都需要记录 `origin`、`trace_id`、`delegation_depth` 和 `profile_id`，避免递归委派。

## 6. 工作区策略

```yaml
workspace:
  allowed_roots:
    - /absolute/path/to/projects
  mode: isolated_worktree
```

### `isolated_worktree`（默认）

每个 Task 创建独立 Worktree，DSH 的 Session CWD 指向该目录。结果返回 Diff、Changed Files、测试证据和冲突信息；Bridge 不自动覆盖主分支。

### `read_only`（任务级扩展目标）

只读检查或分析任务。`0.1.0-alpha.1` 的 Workspace Schema 有效模式为 `isolated_worktree` 和 `patch_only`；`read_only` 不是有效配置值，不要把它写进 `bridge.yaml`。

### `patch_only`（后续兼容能力）

用于没有 Git Worktree 能力的项目。实现前不应在文档或 CLI 中假设它已经可用。

### `direct_write`（MVP 禁用）

直接写用户主工作区会扩大误操作和回滚风险。`0.1.0-alpha.1` 不提供该模式。

## 7. 并发、预算与递归

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

## 8. Provider 与秘密

DSH 负责 Provider 的凭据和认证。Bridge 配置只保存引用：

```yaml
dsh:
  provider: openrouter-main
  model: example-coding-model
```

禁止这样写：

```yaml
# 不要这样做
apiKey: sk-...
endpoint: https://private.example.invalid
```

Provider 缺失、认证失败或模型不存在时，`doctor` 和 `profiles validate` 应给出可操作的错误类别，并只显示 `configured` / `missing`，不打印值本身。

## 9. Artifact 与日志

目标目录布局和生命周期见 [软件架构规划](architecture.md)。建议：

- 任务元数据、事件和产物分开保存；
- 大 Patch 只通过 Artifact ID、SHA-256、字节数和分页接口读取；
- JSONL 记录状态、工具、命令、退出码和耗时，不记录隐藏推理；
- 任务保留期和磁盘配额可配置，清理前确认 Task 已经进入终态；
- 任何日志在写入和返回前都做 Token、Cookie、Authorization Header 脱敏。

## 10. 变更、升级与回滚

升级顺序：

1. 阅读 Release Notes 和 Compatibility Matrix；
2. 在隔离环境运行 `pnpm dsh-bridge doctor --json --redacted` 与 Profile Contract Test；
3. 确认 Codex Plugin、DSH Plugin 和共享协议版本相同；
4. 使用一个只读任务和一个小范围 Worktree 任务验证；
5. 通过后再切换默认版本。

由于 DSH `0.1.0-rc.8` 是 Developer Preview，生产或团队环境不要使用未锁定的 `latest`。Bridge 版本升级也不应自动升级 DSH；两者要有明确的兼容矩阵。

## 11. 配置检查命令

```bash
pnpm dsh-bridge config show --effective --redacted
pnpm dsh-bridge profiles list
pnpm dsh-bridge profiles validate
pnpm dsh-bridge doctor --json --redacted
```

这些命令已经由 `0.1.0-alpha.1` CLI 提供；输出可复制到 Issue 而不暴露秘密。真实 DSH 闭环使用相同的 Profile/Provider，详见 [入门页的 E2E 证据](getting-started.md#8-真实-dsh-闭环验证)。
