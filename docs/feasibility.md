# DSH × Codex Bridge 技术可行性报告

> 结论日期：2026-08-20
>
> 输入：PRD v0.1、OpenAI 官方文档、DeepSeek Harness 官方源码
>
> DSH 源码基线：`0.1.0-rc.8` / `141eb6fef83422698aef7a981029e843e8161534`

> **实施状态（2026-08-21）**：M0 结论已经从“建议 PoC”推进为 **Go**。源码 Alpha 已完成真实 DSH Profile 启动、DeepSeek/Kimi 路由、隔离 Worktree、取消、同 Session 继续、内部 Sub-Agent 和 Artifact Hash 闭环。保留本报告用于说明最初证据与尚未进入稳定版的边界。

## 1. 结论

项目的本地 MVP **可行，关键 PoC 已通过**。当前进入源码 Alpha 和后续 Hardening 阶段。

可以实现的核心闭环是：

1. Codex 通过插件提供的 Skill 识别适合委派的任务。
2. Codex 调用本地 STDIO MCP 工具创建异步任务。
3. 与 MCP Gateway 同进程的 DSH Cordis Plugin 创建 DSH Agent，并按 Profile 应用 Provider、Model、Reasoning Effort、Agent Preset 和权限策略。
4. DSH Agent 可继续调用 DSH 自带或配置的 Sub-Agent 工具。
5. Bridge 收集 Session 事件、Git Diff、测试结果和错误，生成结构化结果。
6. Codex读取结果并决定接受、继续修复、取消或放弃。

但需要对产品表述做一个重要校正：

> DSH 不能通过公开接口直接成为 Codex 原生 Sub-Agent 的底层模型。Bridge 能提供“外部 Sub-Agent”语义和工具体验；如果用户希望在 Codex UI 中看到原生 Sub-Agent 线程，可以让一个低成本 Codex 自定义 Agent 作为调度外壳，再由它调用 DSH MCP。这个外壳仍会消耗 Codex token。

因此推荐两种模式并存：

| 模式                   | 路径                                          | Codex 额外消耗 | 原生 Sub-Agent 线程 | 推荐用途                 |
| ---------------------- | --------------------------------------------- | -------------: | ------------------- | ------------------------ |
| 直接委派（默认）       | Codex 主线程 → MCP → DSH                      |           最低 | 否                  | 日常批量执行、节省额度   |
| Sub-Agent 外壳（可选） | Codex 主线程 → 自定义 Codex Agent → MCP → DSH |           较高 | 是                  | 需要线程可见性、并行总控 |

## 2. 已验证事实

| 能力                 | 证据                                                                                                                                                                                                                                                           | 结论                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Codex 原生 Sub-Agent | 当前 Codex 默认支持 Sub-Agent；项目可定义自定义 Agent，并为其配置模型、MCP 和 Skills。[OpenAI Subagents](https://developers.openai.com/codex/agent-configuration/subagents)                                                                                    | 可创建 `dsh_orchestrator` 外壳，但它仍是 Codex Agent。 |
| Codex MCP            | Codex 本地客户端支持 STDIO 和 Streamable HTTP MCP，项目级配置位于 `.codex/config.toml`。[OpenAI MCP](https://developers.openai.com/codex/extend/mcp)                                                                                                           | 本地 STDIO 是 MVP 的最短路径。                         |
| Codex Plugin         | 插件可包含 Skills、MCP Server 或两者；本地 MCP 可通过 `.mcp.json` 随插件分发。[OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins)                                                                                                   | 可交付真正的 Codex 插件，而不只是手写配置。            |
| DSH 插件             | DSH Plugin 是导出 `apply(ctx)` 的 Cordis 模块；Bundle 通过 `dsh.bundle.patch` 安装到 Profile。[DSH plugin publishing](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/docs/user/develop/basic/publish.md)        | 可发布独立 DSH Bundle。                                |
| DSH Agent 生命周期   | `ctx.agents.create()` 返回拥有 `dispose()` 的 Handle；Agent 支持 `followup()`、`whenIdle()` 和 `cancel()`。[DSH Agent contract](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/packages/core/agent/README.md)   | 同进程插件可以创建、继续、取消和回收任务。             |
| DSH 模型路由         | Agent 支持 Provider/Model；`installModelSelection()` 可在 Agent Scope 内应用 Reasoning Effort。[DSH model selection](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/packages/core/agent/src/model-selection.ts) | Profile 可逐任务选模型和推理强度。                     |
| DSH Agent Preset     | Preset 可在 Agent 创建的 `setup()` 中挂载，并给 Agent 提供不同工具和 Prompt 组合。[DSH Agent Presets](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/packages/preset/agent-presets/README.md)                   | Profile 可引用 DSH Preset，而不复制整套工具配置。      |
| DSH Sub-Agent        | DSH 有 Spawn/Fork/ACP/Codex/Claude Code/DSH SDK 等 Provider；进程内子 Agent 可覆盖 Provider/Model。[DSH Subagent subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/docs/subsystems/subagent.md)         | DSH 内部多 Agent 与多模型可复用。                      |
| DSH SDK              | 官方 SDK 通过 STDIO JSON-RPC 驱动 DSH，但当前没有 prompt cancel、session close 和严格的 per-prompt result。[DSH SDK Client](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/packages/sdk/client/README.md)       | SDK 可作为兼容后端，不适合做默认长驻任务后端。         |
| DSH 稳定性           | 官方明确标注 Developer Preview，并提示会有 breaking changes。[DSH README](https://github.com/deepseek-ai/deepseek-harness/tree/141eb6fef83422698aef7a981029e843e8161534)                                                                                       | 必须锁版本、做 Contract Test 和兼容矩阵。              |

## 3. 可行性矩阵

| PRD 能力                            | 可行性          | 实现路径                                          | 主要限制                                                                                               |
| ----------------------------------- | --------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Codex 发现 Bridge 工具              | 高              | Codex Plugin + `.mcp.json` + STDIO MCP            | 插件本地测试和公开目录发布流程不同。                                                                   |
| Profile 列表与选择                  | 高              | Bridge 自有 Profile Registry                      | Provider/Model 必须先在 DSH 配置中存在。                                                               |
| 按任务切换 Provider/Model           | 高              | `ctx.agents.create()` + `installModelSelection()` | 必须验证每个模型支持的 Reasoning ID，不能静默降级。                                                    |
| DSH 内部 Sub-Agent                  | 高              | DSH Agent Preset + `dsh-tool-subagent`            | Stock Tool 对子 Agent 主要覆盖 Provider/Model/MaxTokens；子级 Reasoning 需用 Provider 默认或后续扩展。 |
| 异步任务状态                        | 高              | Bridge Task Engine 独立状态机                     | DSH 原生 Agent 只有 `idle/running`，业务状态要由 Bridge 派生。                                         |
| 继续同一任务                        | 高              | 同一 Agent `followup()`；重启后 `resume()`        | 必须保存 Task ↔ Session 映射。                                                                         |
| 取消任务                            | 高（插件模式）  | `agent.cancel()` 后 `handle.dispose()`            | SDK Sidecar 没有 wire-level cancel，只能终止进程。                                                     |
| Git Worktree 隔离                   | 高              | Bridge Workspace Manager                          | 非 Git 项目需要 `patch_only` 临时副本后端。                                                            |
| Diff 与测试证据                     | 高              | Git/命令事件 + Artifact Collector                 | 大 Patch 不应直接塞进一次 MCP 结果。                                                                   |
| 多项目并发                          | 中高            | 每任务 Session/Worktree + 全局并发闸门            | DSH/Provider 限流和磁盘容量要统一预算。                                                                |
| 任务重启恢复                        | 中              | 持久 Task Store + DSH Session Persistence         | 运行中 Agent 无法跨进程原位恢复，只能标记 interrupted 后继续或重试。                                   |
| 远程 DSH Runtime                    | 中              | Streamable HTTP Gateway 或远程队列                | 不进入本地 MVP。                                                                                       |
| DSH 直接显示为 Codex 原生 Sub-Agent | 低/不可公开实现 | 无公开替换 Provider 的扩展点                      | 不 Fork Codex，不依赖私有 RPC。                                                                        |

## 4. DSH 接入方案比较

### A. 同进程 Cordis Plugin + MCP（推荐）

```text
Codex ──STDIO MCP──> dsh --profile codex-bridge
                           ├─ Bridge MCP Plugin
                           ├─ Bridge Task Service
                           └─ DSH Agent/LLM/Subagent services
```

优势：

- 能直接使用 `ctx.agents`、`ctx.agentPresets` 和 DSH Session 事件。
- 可以真正取消单个 Agent，而不是杀掉整个运行时。
- Task Engine 与 Agent Handle 同进程，生命周期清晰。
- 不需要启动 DSH Web，也不解析 CLI 文本。
- DSH 的每 Session CWD 与 Sandbox Policy 可直接绑定隔离 Worktree。

代价：

- 与 DSH Cordis API 耦合较深。
- MCP stdout 必须绝对纯净，所有日志只能写 stderr 或文件。
- DSH 升级需要 Adapter Contract Test。

### B. MCP Sidecar + 官方 DSH SDK（兼容后端）

优势：使用官方进程边界，Bridge 不直接依赖 Cordis 内部服务。

当前缺口：SDK wire 无单任务取消、无 Session Close、无严格 Per-Prompt Result。MVP 若采用该方案，应“一任务一运行时”，取消时终止该子进程。它适合作为 DSH API 变化时的 fallback，不适合作为默认高并发后端。

### C. DSH Web/CLI 自动化（拒绝）

不解析终端输出、不模拟输入、不调用未声明的 Web 私有 API。这类方案不可测试、不可版本化，也不符合目标开源项目的稳定性要求。

## 5. 必须通过的 M0 PoC

| 编号   | Spike           | 通过标准                                                                           |
| ------ | --------------- | ---------------------------------------------------------------------------------- |
| POC-01 | DSH Bundle 启动 | `dsh --profile codex-bridge` 能加载外部 Bundle，stdout 只有 MCP frame。            |
| POC-02 | 真实 Agent      | 插件创建 DSH Agent，挂载 `standard` Preset，使用配置模型完成一个只读任务。         |
| POC-03 | Profile 路由    | 两个 Profile 使用不同 Provider/Model；实际 Session request header 可证明路由不同。 |
| POC-04 | Reasoning 路由  | 支持的模型应用指定 Reasoning ID；不支持值在 Provider I/O 前明确失败。              |
| POC-05 | 取消            | 运行中任务在 5 秒内进入 `cancelled`，Agent Handle 和子进程全部回收。               |
| POC-06 | Worktree        | 两个并发任务使用不同 Worktree，不修改主工作区；结果可生成 Patch。                  |
| POC-07 | Codex MCP       | Codex 能发现 `list_profiles`、`delegate_task`、`get_task`、`cancel_task`。         |
| POC-08 | Codex Plugin    | 本地 Marketplace 安装 Skill + MCP 后，新会话能完成一次直接委派。                   |
| POC-09 | Sub-Agent 外壳  | 项目级 `dsh_orchestrator` 自定义 Agent 能调用同一 MCP，并把摘要交回主线程。        |
| POC-10 | Crash Reconcile | 强制终止 Bridge 后重启，旧的 `running` 任务变为 `interrupted`，Worktree 不丢失。   |

Go/No-Go：POC-01、02、03、05、06、07 任一失败即不进入 MVP；先修正架构或缩小范围。

## 6. 主要风险与缓解

| 风险                            |  概率 | 影响 | 缓解                                                                                  |
| ------------------------------- | ----: | ---: | ------------------------------------------------------------------------------------- |
| DSH RC API 破坏性变化           |    高 |   高 | 精确锁版本；所有 DSH 调用收口到 `DshRuntimeAdapter`；每日/每周上游兼容 CI。           |
| “原生 Sub-Agent”预期误差        |    高 |   中 | 文档明确 External Sub-Agent；默认直接模式，可选 Codex 外壳模式。                      |
| DSH 输出诱导 Codex 执行危险操作 |    中 |   高 | 结果视为不可信输入；仅返回结构化证据；禁止自动部署/合并。                             |
| 多 Agent 修改冲突               |    中 |   高 | 默认独立 Worktree；按写入范围调度；不自动覆盖主工作区。                               |
| 绝对路径/符号链接逃逸           |    中 |   高 | Realpath 后做 Allowed Root 校验；DSH Sandbox Policy；拒绝越界 Artifact。              |
| 大 Diff 污染 Codex 上下文       |    高 |   中 | 小结果内联；大结果返回 Artifact URI、Hash、分页读取。                                 |
| Provider 成本失控               |    中 |   高 | Profile 预算、并发闸门、超时、MaxTokens、最大 Sub-Agent 深度。                        |
| MCP 进程退出导致任务丢失        |    中 |   高 | 持久 Task Store；启动时 Reconcile；任务和 Artifact 与进程生命周期解耦。               |
| DSH 反向调用 Codex 形成递归     | 低/中 |   高 | Bridge Preset 默认禁用 Codex Sub-Agent Provider；携带 origin/trace/depth 并设硬上限。 |

## 7. 仍需 PoC 回答的问题

1. 外部 Bundle 使用 DSH 已发布 npm 包时，哪些 Cordis 类型属于稳定导出，哪些只能从源码依赖？
2. `standard` Agent Preset 在自定义无 UI Profile 中能否完整挂载，且不引入交互式 approval/question 工具？
3. DSH 当前 Mac/Linux/Windows Sandbox 后端在无人值守模式下的行为是否一致？
4. DSH Session Persistence 在 Agent `resume()` 后是否能稳定继续 Bridge 任务，而不重复已完成工具调用？
5. Codex 插件的 `.mcp.json` 在公开目录分发时，对本地二进制/Node 运行时有哪些审核限制？
6. Codex MCP 单次工具结果和运行时间的实际产品限制，需要通过探针而不是猜测确定。
7. DSH Provider 的 Token Usage 是否对所有适配器提供统一、可核对的事件字段？

这些问题不再阻塞源码 Alpha，但仍阻塞稳定版 `v0.1.0`、公共 Plugin Directory 和跨平台生产承诺。
