# 施工与发布规划

> **当前进度（2026-08-21）**：M0、M1 和核心 M2 纵向闭环已完成并形成 `0.1.0-alpha.1` 源码发布。真实 E2E 已覆盖 DeepSeek/Kimi、并发、内部 Sub-Agent、继续和取消。M3 Hardening 与 M4 的 npm/Public Plugin Directory、SBOM、跨平台和 Benchmark 仍是路线图，不应被理解为已经交付。

## 1. 交付策略

项目已经通过 `M0 Feasibility Gate` 并完成本地 Alpha。DSH 仍是 RC，后续工作继续以兼容性证据和纵向闭环为发布前提。

估算基于一名熟悉 TypeScript、MCP、Git 和 Agent Runtime 的工程师：

- M0 技术闸门：1 周。
- M1–M4 可用 MVP：5–7 周。
- 两名工程师可在 M0 后并行 DSH Runtime 与 Codex/MCP，预计 4–5 周，但安全与 E2E 仍需串行收口。

估算不包含公开插件目录的外部审核等待时间。

## 2. 里程碑

| 里程碑              | 目标                               |   预计 | 发布物                  |
| ------------------- | ---------------------------------- | -----: | ----------------------- |
| M0 Feasibility Gate | 证明关键 API 和进程架构            |   1 周 | PoC、决策记录、Go/No-Go |
| M1 Vertical Slice   | 一条真实 Codex → DSH → Diff 闭环   | 1–2 周 | `0.0.1-alpha`           |
| M2 Local MVP        | 两 Profile、隔离、状态、继续、取消 |   2 周 | `0.1.0-alpha`           |
| M3 Hardening        | 安全、恢复、Contract/E2E、诊断     | 1–2 周 | `0.1.0-beta`            |
| M4 OSS Release      | 文档、示例、兼容矩阵、发布流水线   |   1 周 | `0.1.0`                 |

## 3. Work Breakdown Structure

### M0：技术闸门

| ID        | 工作项                                     | 依赖    | 验收                                             |
| --------- | ------------------------------------------ | ------- | ------------------------------------------------ |
| SPIKE-001 | 锁定 DSH `0.1.0-rc.8` 并生成 API Inventory | 无      | 列出所有使用的 DSH 导出、包名和源码链接。        |
| SPIKE-002 | 最小 DSH Bundle/Profile                    | 001     | 自定义 Profile 可启动、关闭，stdout 无污染。     |
| SPIKE-003 | Cordis Agent Driver                        | 002     | 创建 Agent、挂 Preset、路由模型、读 `turn/end`。 |
| SPIKE-004 | Cancel/Dispose                             | 003     | 活跃 Agent 和子进程在时限内收敛。                |
| SPIKE-005 | Git Worktree                               | 无      | 两任务并发无主工作区写入。                       |
| SPIKE-006 | 最小 STDIO MCP                             | 002     | Codex 可发现并调用 Echo/Status。                 |
| SPIKE-007 | Codex Plugin 本地安装                      | 006     | Skill + `.mcp.json` 在新会话生效。               |
| SPIKE-008 | 自定义 Codex Agent 外壳                    | 006     | 原生 Sub-Agent 线程成功委派一次 DSH Task。       |
| SPIKE-009 | Crash Reconcile                            | 003/005 | 重启后运行中任务进入 `interrupted`。             |

M0 结束必须提交 ADR-0001/0002，并用真实记录说明是否继续。

### M1：Vertical Slice

| ID        | 工作项                                               | 产物                  |
| --------- | ---------------------------------------------------- | --------------------- |
| CORE-001  | pnpm Monorepo、TSConfig、Lint、Vitest、Changesets    | 可复现开发环境        |
| PROTO-001 | `v1alpha1` Task/Profile/Result Zod Schema            | JSON Schema + 类型    |
| CORE-002  | Task 状态机和原子文件 Store                          | 可恢复 Task Registry  |
| WS-001    | Project Registry、Allowed Root、Worktree 创建/释放   | Workspace Handle      |
| DSH-001   | `DshRuntimeAdapter` 接口与 RC8 实现                  | Start/Continue/Cancel |
| DSH-002   | Agent Setup：Preset + Model Selection + Session 监听 | 一次真实 Run          |
| ART-001   | Diff/Changed Files/Test Summary 收集                 | Result Manifest       |
| MCP-001   | `delegate_task`、`get_task`、`get_task_result`       | MCP Vertical Slice    |
| CODEX-001 | 最小委派 Skill 与 MCP 配置                           | 本地 Codex Plugin     |

M1 Exit：示例仓库中由 Codex 委派一个任务，DSH 修改 Worktree，Codex 读到 Patch 与测试摘要；主工作区保持不变。

### M2：Local MVP

| ID          | 工作项                                | 关键要求                            |
| ----------- | ------------------------------------- | ----------------------------------- |
| PROFILE-001 | Profile Registry 与覆盖优先级         | 至少两个不同模型 Profile            |
| PROFILE-002 | 能力探测与 Fail-loud                  | 未知模型/Reasoning 明确失败         |
| DSH-003     | DSH 内部 Sub-Agent 策略               | 最大深度、数量、禁用反向 Codex      |
| TASK-001    | `continue_task`                       | 同 Session 新运行区间，结果不串轮次 |
| TASK-002    | `cancel_task` 与 Timeout              | 幂等、收敛、资源回收                |
| TASK-003    | 并发与 Provider 预算                  | 全局/项目/Profile 三层 Semaphore    |
| ART-002     | Artifact Store 与分页读取             | Patch Hash、大小、Range             |
| MCP-002     | 完整 P0 工具与安全 Annotation         | Schema/错误一致                     |
| CODEX-002   | Direct Mode Skill                     | 默认不 Spawn Codex Agent            |
| CODEX-003   | 可选 `dsh_orchestrator` 生成器        | 项目级、只在显式 init 时写入        |
| CLI-001     | `init`、`doctor`、`profiles validate` | 十分钟内首个任务                    |

M2 Exit：两个项目、两个 Profile 可并发；任务可查询、继续、取消、超时；大 Patch 不污染单次工具结果。

### M3：Hardening

| ID        | 工作项                         | 关键要求                               |
| --------- | ------------------------------ | -------------------------------------- |
| SEC-001   | Path/Symlink/Allowed Root 测试 | 越界全部拒绝                           |
| SEC-002   | Secret Redaction               | `.env`、Token、Cookie Fixture 无泄漏   |
| SEC-003   | Command/Network Policy         | 默认最小权限，危险类别拒绝             |
| REL-001   | Startup Reconcile              | interrupted/collecting/cleanup 恢复    |
| REL-002   | Worktree Conflict 检测         | 不自动覆盖主工作区                     |
| REL-003   | 过期任务与磁盘清理             | 保留期、配额、干跑模式                 |
| OBS-001   | JSONL Event、Trace、Usage      | 不记录思维链                           |
| TEST-001  | DSH Contract Suite             | 锁定导出与行为                         |
| TEST-002  | Codex MCP E2E                  | Desktop/CLI 至少覆盖 CLI 自动化        |
| TEST-003  | Fault Injection                | 模型 429、MCP 断线、进程崩溃、取消竞态 |
| BENCH-001 | 30 个代表任务基准              | 接受率、重试、时间、成本               |

M3 Exit：所有 P0 安全用例通过；无静默挂起；Bridge 进程崩溃不丢 Worktree 和最终证据。

### M4：开源发布

| ID        | 工作项                                     | 产物              |
| --------- | ------------------------------------------ | ----------------- |
| OSS-001   | README、Quickstart、Architecture、Security | 新用户文档        |
| OSS-002   | CONTRIBUTING、CODE_OF_CONDUCT、SECURITY    | 社区治理          |
| OSS-003   | Apache-2.0、NOTICE、依赖许可证扫描         | 合规材料          |
| OSS-004   | Issue/PR 模板与 Good First Issue           | 贡献入口          |
| OSS-005   | Changesets 固定版本组                      | 同步版本          |
| REL-004   | npm Provenance、SBOM、签名 Release         | 发布供应链        |
| CODEX-004 | 本地 Marketplace 示例                      | 插件测试入口      |
| EX-001    | Basic 与 Multi-model 示例                  | 可复制 Demo       |
| DOC-001   | Compatibility Matrix                       | DSH/Codex/Node/OS |

M4 Exit：干净 macOS/Linux 环境可在 10 分钟内安装并完成示例；所有发布包版本一致，可从源码复现构建。

## 4. 第一批 GitHub Issues

建议创建以下十个首批 Issue，并把 M0 设为唯一进行中的 Milestone：

1. `SPIKE: boot a stdout-clean DSH bridge profile`
2. `SPIKE: drive and cancel a DSH agent from an external Cordis bundle`
3. `SPIKE: connect Codex to the bridge over STDIO MCP`
4. `SPIKE: validate standard Agent Preset in unattended mode`
5. `SPIKE: isolate two concurrent Git worktrees`
6. `RFC: external sub-agent protocol v1alpha1`
7. `ADR: direct delegation vs native Codex sub-agent shell`
8. `SECURITY: define allowed-root and secret-boundary threat model`
9. `TEST: record RC8 DSH contract fixtures`
10. `DOCS: publish the M0 compatibility matrix`

## 5. 测试规划

### 单元测试

- Schema 边界、状态转换、幂等键、错误码。
- Profile 优先级与预算裁剪。
- 路径 Realpath、Symlink、Glob 和 Denied Path。
- Artifact 截断、Hash、分页与脱敏。
- Task Store 原子写、损坏记录恢复。

### Contract Test

- DSH 导出包和方法存在性。
- `agents.create/followup/cancel/whenIdle/dispose` 生命周期。
- `agentPresets.mount` 与 `installModelSelection` 行为。
- Session 事件中 `turn/start`、`turn/end`、Assistant Message 的折叠规则。
- MCP Tool Schema Golden Files。

### 集成测试

- Fake LLM：确定性 Agent/工具/取消/错误。
- Git Fixture：修改、删除、重命名、二进制、大 Diff、冲突。
- 双 Task 并发和相同文件冲突。
- DSH 内部 Sub-Agent 完成、失败、超时和递归上限。

### E2E

- Codex CLI → MCP → DSH → Worktree → Result。
- Direct Mode 与 Native Shell Mode 各一条。
- Provider 429/5xx、MCP EOF、Bridge SIGTERM、测试命令挂起。
- 从干净环境执行 Quickstart。

### Benchmark

任务集至少包含：

- 10 个简单重复修改；
- 8 个前端/组件任务；
- 6 个后端/测试任务；
- 4 个 Debug 任务；
- 2 个跨模块复杂任务。

记录：首次通过率、一次修正后通过率、Codex Review 结论、DSH 模型用量、总耗时、失败类别、Patch 大小。PRD 中“Codex 用量下降 30%”是实验目标，不作为未经测量的宣传承诺。

## 6. Definition of Done

一个功能只有在以下条件全部满足时才算完成：

- 有版本化 Schema 和可恢复错误码。
- 有正常、非法输入、未授权、取消和超时测试。
- 不泄漏 Provider 密钥或完整内部日志。
- 不直接修改主工作区。
- 任务终止后 Agent、Sub-Agent、Shell 子进程和 Worktree 生命周期明确。
- 文档解释默认行为、限制和升级影响。
- DSH Contract Test 与 Codex MCP E2E 通过。
- Changeset 已添加，两个插件版本保持同步。

## 7. 发布闸门

### `0.1.0-alpha`

- 仅维护者测试。
- 精确绑定 DSH RC 版本。
- 只支持 macOS/Linux、Git、STDIO、两个 Profile。

### `0.1.0-beta`

- 至少 10 名外部测试者或 30 个真实任务。
- 启动失败率低于 5%，无静默挂起。
- 所有高危安全 Fixture 通过。

### `0.1.0`

- 30 个 Benchmark 全部可归因完成或明确失败。
- 至少 70% 任务可直接接受或一次修正接受，作为测试集结果披露，不泛化为模型承诺。
- Quickstart 在两种干净 OS 环境复现。
- SBOM、Provenance、许可证、SECURITY 和兼容矩阵齐全。

## 8. 施工原则

1. 先做纵向闭环，再扩工具数量。
2. DSH 依赖只出现在 Adapter/Plugin 包，其他包只看 Bridge Protocol。
3. 每新增一个 Task 状态必须同时定义恢复策略。
4. 每新增一个写能力必须同时定义权限、取消和审计。
5. 不把“有日志”当作“有结果”；结果必须有可验证证据。
6. 不为未来多 Host 牺牲首版 Codex 路径，但协议字段保持 Host-neutral。
7. 不在 M0 通过前承诺公开发布日期。
