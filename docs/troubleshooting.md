# Troubleshooting

先确认已经按[安装手册](installation.md)完成源码构建和目标项目初始化；日常任务语义见[使用手册](usage.md)。所有诊断输出都应使用 `--redacted` 并人工检查后再公开。

先把问题分成四层：运行时、MCP、DSH/Provider、任务工作区。不要一开始就重装所有组件；先收集可复核、已脱敏的证据。

> 本文中的 Bridge CLI 由源码 workspace 提供，版本为 `0.1.0-alpha.1`。所有命令都从源码 checkout 执行，并使用 `pnpm dsh-bridge ...`。

## 1. 最短诊断路径

```bash
node --version
git --version
dsh --version
pnpm dsh-bridge doctor --json --redacted > doctor.json
pnpm dsh-bridge profiles validate
```

确认以下事实后再运行任务：

1. Node 满足 DSH 基线（`22.19+` 或 `24+`）；
2. DSH 是 `0.1.0-rc.8`，且 `codex-bridge` Profile 能加载；
3. Provider 已在 DSH 中配置，Bridge 只显示 `configured`/`missing`；
4. 项目是 Git 仓库，且路径属于 Allowed Root；
5. Codex 能发现本地 STDIO MCP 的 `list_profiles`。

共享诊断信息前，使用 CLI 生成脱敏版本：

```bash
pnpm dsh-bridge doctor --json --redacted > doctor.redacted.json
```

`doctor --json --redacted` 是当前 CLI 支持的诊断命令；共享前仍应人工检查路径、源码片段和环境变量。

## 2. `dsh-bridge: command not found`

**原因**：源码尚未构建、当前目录不是 Bridge checkout，或你把尚未发布的 npm 命令当成可用入口。

**处理**：

```bash
pnpm install
pnpm build
pnpm run
pnpm dsh-bridge --help
```

当前版本只支持源码入口；不要从未经验证的全局包安装同名命令。npm 包和 Marketplace 包尚未发布，只有正式 Release Notes 发布后才可使用对应安装方式。

## 3. Node / DSH 版本不兼容

**症状**：Bundle 加载失败、TypeScript 运行时错误、Agent API 不存在、`doctor` 报版本不支持。

**处理**：

```bash
node --version
dsh --version
```

当前兼容基线是 DSH `0.1.0-rc.8`。不要通过删除锁文件、安装 `latest` 或手工替换 `node_modules` 绕过检查。不同 DSH 版本应先查 Compatibility Matrix 和 Contract Test。

## 4. DSH Plugin / Profile 找不到

**症状**：`codex-bridge` Profile 不存在、Bundle 无法加载、`dsh --profile codex-bridge` 立即退出。

**检查**：

```bash
dsh --profile codex-bridge --help
pnpm dsh-bridge doctor --json --redacted
pnpm dsh-bridge profiles list
```

**常见原因**：

- DSH Plugin 尚未安装或 Bundle patch 未生效；
- 使用了另一份 DSH 配置目录；
- Profile 引用的 Provider、Preset 或 Model 不存在；
- DSH 版本不是锁定的 `0.1.0-rc.8`。

保留 stderr 和 `doctor` 输出；不要把 DSH 的交互式 UI 或 CLI 文本解析当作修复方案。

## 5. Codex 看不到 MCP 工具

**症状**：Codex 无法发现 `list_profiles`、`delegate_task`，或新会话中工具列表为空。

**检查顺序**：

1. 重新打开 Codex 会话；
2. 确认 `.mcp.json` 的启动命令指向当前源码/发布包，而不是旧路径；
3. 在终端直接运行 MCP 启动命令，确认 stdout 没有启动 Banner、调试日志或普通文本；
4. 确认 Bridge 使用的 Node 和 DSH 配置与你手工验证的相同；
5. 再运行 `pnpm dsh-bridge doctor --json --redacted`。

MCP stdout 必须只包含协议帧。日志应写 stderr 或受控文件；任何 stdout 污染都会让 Codex 认为连接损坏。

## 6. Provider 缺失、认证失败或模型不支持

**症状**：Profile 可以列出，但任务在 `validating` 或 `starting` 阶段失败。

**处理**：

```bash
pnpm dsh-bridge profiles validate
pnpm dsh-bridge config show --effective --redacted
```

确认 Provider ID、Model ID、Reasoning ID 和 Agent Preset 都在 DSH 中真实存在。Bridge 不会把 API Key 复制到项目配置，也不应把不支持的 `reasoningEffort` 静默改成 `medium`。错误应明确指出“缺少 Provider”“认证失败”“模型不存在”或“Reasoning 不支持”。

## 7. 任务长期停留在 `queued`

**可能原因**：全局/项目并发上限、Provider 限流、旧任务未终止、磁盘配额不足。

**检查**：

```text
get_task(task_id)
list_profiles
pnpm dsh-bridge doctor --json --redacted
```

不要重复点击 `delegate_task` 造成重复任务。确认现有任务是否仍处于 `running`，再等待有界时间或对明确失控的任务调用 `cancel_task`。

## 8. 任务无法取消或仍有进程

**处理顺序**：

```text
cancel_task(task_id)
  → agent.cancel()
  → 等待 Agent / Sub-Agent idle
  → handle.dispose()
  → 必要时终止该 Task 的进程组
```

取消是幂等操作。不要直接杀掉整个 DSH 宿主进程，除非进程组回收已经失效且你确认这不会影响其他任务。取消后检查状态是否为 `cancelled` 或 `timed_out`，并确认 Worktree 未被删除。

## 9. Worktree 创建失败或主工作区变脏

**原因**：不是 Git 仓库、工作区路径不在 Allowed Root、已有同名 Worktree、磁盘空间不足，或用户同时在主工作区写入。

**检查**：

```bash
git status --short
git worktree list
df -h .
pnpm dsh-bridge doctor --json --redacted
```

Bridge 默认不应为了创建任务而执行 `git reset`、`git clean` 或覆盖用户修改。先保存用户工作，再清理已经确认终态的旧 Task；清理前优先使用 `--dry-run`。

## 10. 结果缺少 Diff、测试或 Artifact

**症状**：Task 显示 `completed`，但结果没有可审查证据。

**核对**：

- Task 是否真正进入 `collecting` 后再进入 `completed`；
- Worktree 是否仍存在；
- 测试命令是否有退出码和耗时；
- 大 Patch 是否被正确放入 Artifact Store，而不是因为 MCP 结果过大被截断；
- `read_task_artifact` 的 offset/limit 和 SHA-256 是否一致。

没有证据的“完成”不能被 Codex 直接接受，应标为 `partial` 或 `failed`，并通过 `continue_task` 要求补证据。

## 11. Bridge 重启后任务变成 `interrupted`

这通常是正确的保守行为：Bridge 无法证明任务在崩溃时已完成。保留 Task Store、事件和 Worktree，先获取：

```text
get_task(task_id)
get_task_result(task_id)
```

然后根据已有证据选择继续、重试或清理。不要手工把状态文件改成 `completed`，否则会破坏审计链。

## 12. Native Shell Agent 没有出现

Native Shell 是可选能力，不是 Direct Mode 的前置条件。确认你显式运行了安装命令：

```bash
pnpm dsh-bridge install --source . --codex-agent --mode native-shell
```

然后检查项目 `.codex/agents/dsh-orchestrator.toml` 是否生成、MCP 是否可访问，并重新打开 Codex 会话。该 Agent 只是调度外壳；DSH 仍在独立 Runtime 中执行，不能期待 DSH 模型显示为 Codex 原生模型。

## 13. 复现真实 DSH 闭环

从源码 checkout 执行：

```bash
pnpm test:e2e:dsh
```

测试会启动 DSH `0.1.0-rc.8` 的 `codex-bridge` Profile，调用当前机器已配置的真实 Provider/Model，通过 STDIO MCP 验证 Profile 列表、异步任务、继续/取消工具、隔离 Worktree、Patch 和 Artifact Hash。它不是 Fake LLM 测试；如果 Provider 凭据、DSH Profile 或网络不可用，测试会失败并在 stderr 报告原因。

已记录的闭环证据：[`real-dsh-rc8.json`](../tests/e2e/evidence/real-dsh-rc8.json)、[`real-dsh-rc8.patch`](../tests/e2e/evidence/real-dsh-rc8.patch)。不要把 Provider 密钥或未经脱敏的 E2E 日志提交到仓库。

## 14. 日志污染、重复任务或递归委派

### stdout 污染

任何非 MCP 内容写到 stdout 都可能破坏协议。将日志等级、Banner 和调试输出改到 stderr/文件，重新运行 MCP Contract Test。

### 重复任务

调用方应使用幂等键或保存 `task_id`，不要因为一次网络重试就创建第二个 Task。

### 递归委派

确认 Profile 禁用了反向 Codex Provider，且 `delegation_depth`、`max_depth`、`max_children` 已生效。递归调用应快速失败，并回收已创建资源。

## 15. 最小问题报告模板

提交非安全问题时，提供：

```text
Bridge version:
DSH version:
Node / OS:
Mode: direct | native-shell
Profile ID:
Task ID / Trace ID:
Command or MCP tool:
Expected:
Actual:
Reproduction steps:
Redacted doctor output:
```

不要包含真实 Token、Cookie、Authorization Header、完整私有源码或未公开漏洞利用细节。安全问题请按 [SECURITY.md](../SECURITY.md) 处理。
