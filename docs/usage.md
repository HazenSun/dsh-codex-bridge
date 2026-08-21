# 使用手册

安装完成并新建 Codex 任务后，不需要记忆 MCP 工具名。最简单的入口是：

```text
使用 DSH 处理这个任务。
```

Codex 会发现 Profile、判断单 Agent 或多 Agent、提交任务、等待结果并审查证据。

如果这是首次使用，或模型/Profile 配置缺失，直接说：

```text
帮我完成 DSH Bridge 初次设置。所有配置先预览，确认后再写入。
```

`setup-dsh-bridge` Skill 会检查状态、发现 DSH 已配置模型并引导建立 Profile；不会要求用户把 API Key 粘贴进对话。

## 1. 角色分工

```text
Codex：理解目标、选择路由、验收结果
Bridge：状态、隔离、超时、持久化和证据
DSH：模型调用、工具执行和内部 Sub-Agent
```

Bridge 不会自动提交、合并或部署 DSH 的修改。DSH 的文字输出也不会自动获得更高权限。

## 2. 最常用的提示词

### 自动选择

```text
使用 DSH 处理这个任务，自己判断单 Agent 还是多 Agent。
```

### 强制单 Agent

```text
使用 DSH 单 Agent 修复这个测试，不要调用子 Agent。
```

### 强制多 Agent

```text
使用 DSH 多 Agent 完成：一个角色分析实现，一个角色检查测试，Root Agent 汇总结果。
```

### 指定 Profile

```text
使用 DSH 的 kimi-code-builder 处理这个任务，返回 Patch 和验证证据。
```

### 跨模型验证

```text
使用 DeepSeek Profile 实现，再使用 Kimi Profile 对不可变 Patch 做独立审查。
```

不同 Profile 的任务位于不同 Worktree。独立审查必须读取前一个任务的 Patch Artifact，不能假定另一个 Worktree 能看到未提交修改。

### 新增或切换模型

```text
显示 DSH 当前可用模型。
把 kimi-k2.7-code 加成 fast-code Profile，先预览，不要写入。
把 deepseek-v4-flash 设为当前项目默认模型，确认后再修改。
```

模型必须先存在于 DSH。Codex 只能使用 `discover_dsh_models` 返回的精确 ID，并通过 `preview_profile_change` 展示修改。更新已有 Profile 时只提交最小 `changes`，不覆盖无关安全策略。`apply_profile_change` 必须携带预览时的 Revision；过期 Revision 会要求重新预览。

## 3. 自动单/多 Agent 规则

Codex 遵循以下判断：

| 情况                               | 默认策略              |
| ---------------------------------- | --------------------- |
| 单文件修复、小测试、配置或文档修改 | `single`              |
| 多个顺序步骤但共享大量中间状态     | `single`              |
| 两个以上可独立推进的模块           | `multi`               |
| 实现与安全/测试独立复核            | `multi`               |
| 不同模型交叉验证                   | 多个独立 Profile Task |
| 无法判断并行收益                   | `single`              |

用户明确指定 `single` 或 `multi` 时，用户选择优先。

## 4. Profile 与角色

Codex 首先调用 `list_profiles`。返回内容包括：

- Profile ID 和用途；
- 是否支持继续、取消和 Sub-Agent；
- Worktree 模式；
- Token 和超时上限；
- `max_depth`、`max_children` 和可用角色 ID。

角色必须在所选 Profile 中声明。当前 Bridge 会校验角色、将职责写入 Root Agent Prompt，并核对真实子调用；DSH 内部角色级 Provider/Model 强制路由仍取决于 DSH Preset。需要确定模型时使用独立命名 Profile。

## 5. 任务生命周期

```text
validating
→ queued
→ preparing_workspace
→ running
→ collecting
→ completed | partial | failed | cancelled | timed_out
```

对应 MCP 工具：

| 工具                      | 用途                                  |
| ------------------------- | ------------------------------------- |
| `get_setup_status`        | 检查首次设置、配置和 Provider 状态    |
| `discover_dsh_models`     | 发现 DSH 实际 Provider/Model 路由     |
| `preview_profile_change`  | 校验并预览 Profile 变更               |
| `apply_profile_change`    | Revision 保护地写入 Profile 变更      |
| `rollback_profile_change` | 回滚最近一次有效配置备份              |
| `list_profiles`           | 发现可用执行 Profile                  |
| `delegate_task`           | 创建异步 DSH 任务                     |
| `get_task`                | 读取当前状态                          |
| `wait_task`               | 最多等待 30 秒，避免忙轮询            |
| `get_task_result`         | 获取结构化结果                        |
| `read_task_artifact`      | 分页读取 Patch、状态或摘要            |
| `continue_task`           | 在同一 DSH Session 和 Worktree 中返工 |
| `cancel_task`             | 请求取消并等待状态收敛                |

通常用户只需表达目标，Codex Skill 会完成这些调用。

## 6. 如何判断任务真的完成

Codex 至少检查：

1. Task 和 Result 都进入终态；
2. `delegation_decision` 与用户要求一致；
3. 多 Agent 的 `delegation_evidence` 有足够 `subagent_calls` 和完成记录；
4. Changed Files 在预期范围；
5. Patch Artifact 的 SHA-256 与 Manifest 一致；
6. DSH 摘要提供了验证命令和结果；
7. Warnings 没有隐藏未完成项；
8. 主工作区没有被 Bridge 直接修改。

当前 Alpha 会收集 Patch、Git Status 和 Agent Summary。结构化测试计数、精确 Diff additions/deletions 和自动验收解析仍在后续计划中；摘要中的“测试通过”必须由 Codex结合 Patch和命令证据审查。

## 7. 继续同一任务

如果 Patch 方向正确但需要调整：

```text
继续刚才的 DSH 任务：只修改错误处理，保持公共 API 不变，并重新运行相关测试。
```

Bridge 使用 `continue_task`：

- Task ID 和 Session ID 保持不变；
- 生成新的 Run ID；
- 保留前一次 Result History；
- 复用同一个隔离 Worktree。

不要为了普通审查反馈创建没有上下文的新任务。

## 8. 取消任务

```text
取消刚才的 DSH 任务，并确认已经进入终态。
```

取消是请求，不是瞬时事实。Codex 应继续查询，直到任务进入 `cancelled`、`timed_out` 或其他终态，不能只凭“已发送取消”宣称完成。

## 9. 结果如何进入主分支

Bridge 默认只返回可审查 Patch，不自动修改主工作区。推荐流程：

1. Codex 读取完整 Patch Artifact；
2. 检查文件范围、测试和安全影响；
3. 用户或 Codex 在获得授权后把认可的修改应用到主工作区；
4. 在主工作区重新运行相关测试；
5. 按正常 Git 流程提交。

不要直接复制 DSH 摘要中的命令执行部署、删除或发布。

## 10. 状态含义

| 状态          | 含义                                          |
| ------------- | --------------------------------------------- |
| `completed`   | DSH 正常结束，委派证据满足策略                |
| `partial`     | 有可审查结果，但多 Agent/证据或结束原因不完整 |
| `failed`      | 配置、运行时、协议或持久化边界失败            |
| `cancelled`   | 取消已收敛                                    |
| `timed_out`   | 超过 Profile Wall Time                        |
| `interrupted` | Bridge 重启后无法证明旧运行完成               |

`partial` 不是成功。Codex 应解释缺失证据，必要时通过 `continue_task` 修复。

## 11. 当前限制

- 源码安装，尚无公开 npm 包和公共 Plugin Directory 版本；
- DSH 只验证 `0.1.0-rc.8`；
- 当前写入后端只支持 Git isolated Worktree；
- DSH 任务不显示为 Codex 原生 Sub-Agent Thread，除非使用可选 Native Shell 外壳；
- 不自动合并、提交、部署或发布；
- Profile 中部分网络、路径、文件数和磁盘字段尚未全部映射为 Bridge 侧执行器；
- 真正的角色级跨模型强制路由仍需 DSH Child Setup Contract。

## 12. 下一步

- 安装问题：[安装手册](installation.md)
- Profile 字段：[配置参考](configuration.md)
- 任务异常：[故障排查](troubleshooting.md)
- 安全边界：[安全模型](security.md)
- 实现原理：[架构](architecture.md)
