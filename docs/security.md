# Security Model

DSH × Codex Bridge 会让一个本地 Agent 在代码目录、Shell、网络和模型 Provider 之间流动。安全目标不是让 Agent“永远正确”，而是把它限制在可审查、可取消、可恢复的边界内。

> 本页描述 `0.1.0-alpha.1` 的安全基线和剩余缺口。已执行约束与配置中预留但尚未接入的策略必须区分；单独阅读文档不能替代运行验证。

## 1. Trust boundaries

```text
用户 / Codex
    │ 结构化 Task 请求
    ▼
Bridge MCP Gateway       ← 校验、限额、状态、脱敏
    │ 受控 Adapter API
    ▼
DSH Plugin / Agent       ← Provider、工具、Session、Sub-Agent
    │ 受控 CWD / Sandbox
    ▼
Worktree、Shell、网络、Artifact Store
```

各边界的基本责任：

- **Codex**：提出目标、选择公开 Profile、审查结果。不能凭文本暗示获得额外权限。
- **Bridge**：执行 Schema、路径、并发、预算、递归、取消和产物策略。
- **DSH**：保存 Provider credential，创建 Agent，应用 Preset 和模型路由。
- **Worktree**：承载本次任务的唯一可写代码目录。
- **Artifact Store**：只保存可追踪的 Diff、测试和事件，不把隐藏推理作为结果返回。

## 2. 默认安全策略

| 资源          | 默认策略                        | 设计理由                                 |
| ------------- | ------------------------------- | ---------------------------------------- |
| 主工作区      | 不写入                          | 防止一次任务污染用户分支                 |
| Task 工作区   | 每任务独立 Git Worktree         | 便于回滚、比较、并发和审查               |
| 网络          | Profile 声明，执行器未完整接入  | 不能把 `restricted` 当作已验证域名防火墙 |
| Provider 密钥 | 仅由 DSH 持有                   | 避免进入 Codex、MCP、Diff 或日志         |
| Shell         | DSH workspace-write、非交互审批 | Bridge 命令分类仍待实现                  |
| 子 Agent      | 深度创建前校验，数量事后验收    | 超限会 partial/失败，不是所有层实时熔断  |
| 任务超时      | 有限 Wall Time                  | 取消失效时仍可回收资源                   |
| 结果          | 结构化、带 Hash、可分页         | 防止日志和大 Diff 污染上下文             |

`0.1.0-alpha.1` 默认不启用 `direct_write`、自动部署、自动提交或自动合并。网络策略字段尚未完整映射到 Bridge 执行器，因此高敏感项目应在操作系统、容器或网络层增加独立限制。

## 3. 文件系统与 Worktree

### 3.1 Allowed Root

Bridge 必须先对项目路径执行 `realpath`，再与配置的 Allowed Root 比较。以下情况应拒绝：

- 项目位于 Allowed Root 外；
- 通过符号链接逃逸到受限目录；
- Artifact 路径不是当前 Task 的子路径；
- `..`、绝对路径或 glob 展开后越过边界；
- 用户工作区存在未预期的冲突，且任务会覆盖它。

### 3.2 主工作区保护

每个写任务应记录 `base_sha`、Worktree 路径、分支命名空间和创建前脏状态。完成后只返回：

- Unified Diff；
- Changed Files / Diff Stat；
- 测试结果和命令摘要；
- 未完成项、Warnings 和冲突信息。

Bridge 不应自动 Checkout、Reset、Commit、Merge 或 Push 用户主分支。清理 Worktree 前必须确认 Agent、子 Agent 和 Shell 子进程已经结束。

## 4. Secrets boundary

### 不应进入 Bridge 的内容

- Provider API Key、OAuth Token、Cookie、SSH 私钥；
- 完整 Authorization Header；
- 用户要求隐藏的源码或日志片段；
- DSH 内部 Session 认证材料。

### 脱敏规则

事件、错误、Artifact 和 MCP 返回值在写入或返回前都要做脱敏。至少覆盖：

```text
Authorization: ...
Bearer ...
api_key=...
sk-...
Cookie: ...
-----BEGIN ... PRIVATE KEY-----
```

脱敏不是权限替代品。Provider credential 应该从架构上不经过 Bridge；脱敏只是最后一道防线。

## 5. Shell、工具与网络

DSH Agent 可以调用工具，但“模型生成了命令”不等于“命令被授权”。当前 Profile 和 DSH Sandbox 提供工作区边界；以下仍是需要继续硬化的执行目标：

- 默认拒绝高风险系统命令、任意删除、部署和发布；
- 包管理器、数据库迁移、代码生成和服务启动作为独立类别；
- 记录实际命令、退出码、耗时和工作目录，不记录隐藏推理；
- 网络允许时使用域名 Allowlist；
- 任务超时或取消后终止 Shell 子进程组，并确认没有孤儿进程；
- 对下载内容、生成脚本和测试输出按不可信输入处理。

如果当前 DSH Sandbox 在某平台不能提供同等隔离能力，应由 `pnpm dsh-bridge doctor --json --redacted` 明确报告限制，而不是显示绿色通过。

## 6. Agent loop 与递归

DSH 的内部 Sub-Agent 是能力来源，也是资源风险。Bridge 当前在创建任务前强制 `delegation_depth`，并在 Run 后核验子调用数、完成数、失败数和协议硬上限：

```yaml
delegation:
  max_depth: 2
  max_children: 3
```

同时携带 `origin`、`trace_id`、`delegation_depth` 和 `project_id`。默认 Profile 禁用反向 Codex Provider，防止：

```text
Codex → Bridge → DSH → Codex → Bridge → ...
```

任务超时和 128 子调用协议上限会明确失败；Profile `max_children` 违规会使结果进入 `partial`。Token、磁盘、文件数和递归子 Agent 的实时熔断尚未在所有执行层完成。

## 7. 不可信输出

DSH 文本、模型摘要、工具日志和测试输出都是不可信数据。Codex 或用户在接受前应验证：

1. 修改文件是否在预期范围；
2. Diff 是否与 objective 和 acceptance 对应；
3. 测试命令是否真实执行、退出码是否为零；
4. 是否出现危险命令、外部上传、秘密或未完成项；
5. Artifact Hash 与 Manifest 是否一致。

Bridge 不应因为 Agent 在输出中声称“已部署”“已提交”就执行后续动作。

## 8. 取消、超时与恢复

取消顺序是资源安全的一部分：

```text
agent.cancel()
    ↓
等待 whenIdle() / 子 Agent 收敛
    ↓
handle.dispose()
    ↓
必要时终止进程组
    ↓
记录 cancelled / timed_out / interrupted
```

取消接口必须幂等。Bridge 崩溃重启后，不能把未知状态伪装成 `completed`；应将未确认的运行任务标为 `interrupted`，保留 Worktree 和已有证据，等待用户继续、重试或清理。

## 9. Artifact、日志和隐私

- Bridge 任务使用原子 JSON 快照，DSH Session 使用其自身持久日志；
- 不保存或返回模型隐藏推理；
- 大 Artifact 使用 URI/ID、大小、SHA-256 和分页读取；
- 自动保留期和 dry-run 清理工具仍待实现；清理前必须人工确认精确 Task 目标；
- 错误信息只暴露解决问题所需的最小上下文；
- 共享诊断包前必须执行 `--redacted`，并人工检查路径、源码片段和环境变量。

## 10. 已验证的运行基线

真实闭环测试由以下命令执行：

```bash
pnpm test:e2e:dsh
```

它会真实启动 DSH `0.1.0-rc.8` 的 `codex-bridge` Profile，调用当前机器配置的 Provider/Model，而不是 Fake LLM。测试在临时 Git Fixture 中验证 MCP 工具、Profile 路由、隔离 Worktree、Patch、Artifact Hash 和主工作区不变；可复核证据为 [`real-dsh-rc8.json`](../tests/e2e/evidence/real-dsh-rc8.json) 与 [`real-dsh-rc8.patch`](../tests/e2e/evidence/real-dsh-rc8.patch)。

## 11. 开发与发布安全清单

- [ ] `pnpm audit` 或等效依赖检查通过，结果可追溯。
- [ ] 发布包不包含 `.env`、Provider credential、私有日志或本地路径快照。
- [ ] DSH `0.1.0-rc.8`、Codex Plugin 和共享协议版本同步且有兼容矩阵。
- [ ] Path / Symlink / Secret Redaction / Command Policy 测试通过。
- [ ] MCP stdout 只有协议帧，诊断写 stderr 或受控文件。
- [ ] 取消、超时、SIGTERM、MCP EOF 和进程崩溃均有 E2E 证据。
- [ ] SBOM、许可证清单和构建来源证明随 Release 提供。

## 12. 报告安全问题

请阅读根目录 [SECURITY.md](../SECURITY.md)。不要在公开 Issue 或 Pull Request 中粘贴可利用细节、真实密钥、Cookie、完整生产日志或私有代码。
