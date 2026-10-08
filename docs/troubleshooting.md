# Troubleshooting

先确认已经按[安装手册](installation.md)完成源码构建和目标项目初始化；日常任务语义见[使用手册](usage.md)。所有诊断输出都应使用 `--redacted` 并人工检查后再公开。

先把问题分成四层：运行时、MCP、DSH/Provider、任务工作区。不要一开始就重装所有组件；先收集可复核、已脱敏的证据。

> 本文对应 Bridge `0.1.0-alpha.3` 和目标 DSH `0.2.0-rc.2`。命令从 Bridge 源码 checkout 执行；`--config` 指向目标项目，不要把源码仓库误当成业务项目。

## 1. 最短诊断路径

```bash
node --version
git --version
export DSH_BRIDGE_DSH_BIN=/absolute/path/to/dsh-bridge-runtime/node_modules/.bin/dsh
"$DSH_BRIDGE_DSH_BIN" --version
BRIDGE_PROJECT=/absolute/path/to/your-project
pnpm dsh-bridge doctor --config "$BRIDGE_PROJECT/bridge.yaml" --json --redacted
pnpm dsh-bridge profiles validate --config "$BRIDGE_PROJECT/bridge.yaml"
```

确认以下事实后再运行任务：

1. Node 满足 DSH 基线（`22.19+` 或 `24+`）；
2. Bridge 使用的 DSH 是 `0.2.0-rc.2`，且 `codex-bridge` Profile 能加载；
3. Provider 对 `codex-bridge` DSH Profile 可见，Bridge 只显示配置状态；
4. 项目是 Git 仓库，且路径属于 Allowed Root；
5. Codex 能发现本地 STDIO MCP 的 `list_profiles`。

共享诊断信息前，使用 CLI 生成脱敏版本：

```bash
pnpm dsh-bridge doctor --config "$BRIDGE_PROJECT/bridge.yaml" --json --redacted > doctor.redacted.json
```

`doctor --json --redacted` 是当前 CLI 支持的诊断命令；共享前仍应人工检查路径、源码片段和环境变量。

## 2. `dsh-bridge: command not found`

**原因**：源码尚未构建、当前目录不是 Bridge checkout，或你把尚未发布的 npm 命令当成可用入口。

**处理**：

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm run
pnpm dsh-bridge --help
```

当前 Bridge 只支持源码入口；Bridge npm 包和 Marketplace 包尚未发布。官方 `@deepseek-ai/dsh@0.2.0-rc.2` 是 DSH 运行时，不是 Bridge npm 包。

## 3. 首次设置停在某个状态

`get_setup_status` 和 `setup` 会保守地返回可恢复状态：

| 状态                                               | 处理                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `needs_dsh` / `needs_dsh_profile`                  | 安装精确 DSH 版本，然后重跑 `pnpm dsh-bridge setup --project <path> --source <path>` |
| `needs_provider`                                   | 在 DSH Settings 或官方凭据引用中配置 Provider；不要把密钥粘贴给 Codex                |
| `needs_project_config` / `needs_execution_profile` | 运行 `models list`，然后用返回的精确 Provider/Model 重跑 `setup`                     |
| `degraded`                                         | 检查返回的 `checks` 和 `next_actions`，修复无效 YAML 或缺失路由                      |
| `ready`                                            | 新建 Codex 任务后运行 `list_profiles`                                                |

```bash
pnpm dsh-bridge setup --project /path/to/project --source . --dry-run
pnpm dsh-bridge models list --config /path/to/project/bridge.yaml --details
```

`models list` 在 `bridge.yaml` 尚未存在时也可以工作，前提是 DSH `codex-bridge` Profile 已安装。

`needs_execution_profile` 表示插件安装已完成、项目尚未选模型。该状态不需要重复克隆或重装；从 `models list` 返回的目录选择精确路由即可。

## 4. Node / DSH 版本不兼容

**症状**：Bundle 加载失败、TypeScript 运行时错误、Agent API 不存在、`doctor` 报版本不支持。

**处理**：

```bash
node --version
"$DSH_BRIDGE_DSH_BIN" --version
```

当前目标是官方 npm DSH `0.2.0-rc.2`。机器上原有 `dsh` 可以是其他版本，但 `DSH_BRIDGE_DSH_BIN` 必须指向 Bridge 专用版本。不要通过删除锁文件、安装 `latest` 或手工替换 `node_modules` 绕过检查。各版本的验证范围见[兼容矩阵](compatibility.md)。

终端中的 `export` 只保证那个终端及其子进程使用新值。安装器已将 DSH 路径与 Home 保存到 Codex Home 的 `dsh-codex-bridge/runtime.json`，通过官方 `codex mcp add` 注册的启动器会读取它。终端通过、Desktop 失败时，用 `codex mcp get dsh-codex-bridge --json` 核对注册指向的 Home 和路径。让 Desktop 切换运行时或 Home 时，重新运行 `setup` 保存新选择，再新建任务；不要只修改另一个终端的环境变量。

## 5. DSH Plugin / Profile 找不到

**症状**：`codex-bridge` Profile 不存在、Bundle 无法加载、`dsh --profile codex-bridge` 立即退出。

**检查**：

```bash
"$DSH_BRIDGE_DSH_BIN" --version
pnpm dsh-bridge doctor --config "$BRIDGE_PROJECT/bridge.yaml" --json --redacted
pnpm dsh-bridge profiles list --config "$BRIDGE_PROJECT/bridge.yaml"
```

**常见原因**：

- DSH Plugin 尚未安装或 Bundle patch 未生效；
- 使用了另一份 DSH Home，或 `runtime.json` 保存了旧的安装路径；
- Profile 引用的 Provider、Preset 或 Model 不存在；
- Bridge 实际调用的 DSH 不是锁定的 `0.2.0-rc.2`。

保留 stderr 和 `doctor` 输出；不要把 DSH 的交互式 UI 或 CLI 文本解析当作修复方案。

DSH 0.2 可能在首次读取旧 Home 时迁移 `settings.yaml`。使用旧 Home 前先备份相关设置；如需隔离验证，显式选择独立 `DSH_HOME` 并重新 `setup`。Provider 设置按 Profile 保存，另一个 Profile 可用不代表 `codex-bridge` 也能发现同一模型。

如果 `web` Profile 已有模型配置，可以预览 `pnpm dsh-bridge models sync --from-profile web`，按[安装手册](installation.md#复用已有-dsh-模型配置)审查后应用，再重新 `models list`。同步拒绝字面凭据和动态表达式；遇到拒绝时，在 DSH 中改用受支持的安全引用或配置目标 Profile，不把密钥移入 Bridge 文件。

## 6. Codex 看不到 MCP 工具

**症状**：Codex 无法发现 `list_profiles`、`delegate_task`，或新会话中工具列表为空。

**检查顺序**：

1. 新建 Codex 任务；
2. 确认本地 Plugin 已启用，用 `codex mcp get dsh-codex-bridge --json` 检查安装器注册的 Node、启动脚本和运行时配置路径；路径移动或注册缺失时重新运行 `setup`；
3. 使用 `doctor` 检查 STDIO 启动和工具发现，确认 stdout 没有启动 Banner、调试日志或普通文本；
4. 确认 Bridge 使用的 Node 和 DSH 配置与你手工验证的相同；
5. 再运行 `pnpm dsh-bridge doctor --json --redacted`。

MCP stdout 必须只包含协议帧。日志应写 stderr 或受控文件；任何 stdout 污染都会让 Codex 认为连接损坏。

当前 Plugin 提供 Setup/Delegate Skill，本地 MCP 由安装器单独注册。仅启用 Skill 插件不会补齐缺失的 MCP；停用 Skill 也不会移除已有注册。已验证的 Codex `0.156.1` 不可靠展开旧插件 MCP JSON 的 `${PLUGIN_ROOT}` / `${CODEX_HOME}`，也不接受 `env_vars` / `envVars` 作为此问题的修复方式；不要把这些配置加回插件，重新运行 `setup` 注册绝对路径。

保留源码和专用 DSH 目录。使用自定义 Codex Home 时，在相同 Home 下检查，例如 `CODEX_HOME=/absolute/path/to/codex-home codex mcp get dsh-codex-bridge --json`。全部 Bridge 项目停用后的 MCP 移除步骤见[卸载边界](installation.md#11-卸载边界)。

首次设置未完成时，只有五个设置工具可发现，这是正常的设置模式。先用 `get_setup_status` 和 `discover_dsh_models` 完成项目配置，再新建 Codex 任务查看执行工具。

## 7. Provider 缺失、认证失败或模型不支持

**症状**：Profile 可以列出，但任务在 `validating` 或 `starting` 阶段失败。

**处理**：

```bash
pnpm dsh-bridge models list --config "$BRIDGE_PROJECT/bridge.yaml" --details
pnpm dsh-bridge profiles validate --config "$BRIDGE_PROJECT/bridge.yaml"
pnpm dsh-bridge config show --config "$BRIDGE_PROJECT/bridge.yaml" --effective --redacted
```

确认 Provider ID、Model ID、Reasoning ID 和 Agent Preset 都在 DSH 中真实存在。Bridge 不会把 API Key 复制到项目配置，也不应把不支持的 `reasoningEffort` 静默改成 `medium`。错误应明确指出“缺少 Provider”“认证失败”“模型不存在”或“Reasoning 不支持”。

切换已有 Profile 的模型时，旧 `reasoning_effort` 默认保留。新模型没有该档位时，先预览 `profiles update <profile-id> --config <path> --clear-reasoning-effort`，再携带 Revision 应用；该选项与 `--reasoning-effort` 互斥。

升级 DSH 后，旧配置中的模型可能不再出现在目录中。先重新发现，再通过 Profile 预览/写入切换路由；不要直接把产品名称猜成 Model ID。目录发现、Schema 校验和 `doctor` 均不能证明模型账号有调用权限；只有真实小任务会验证调用，并可能产生费用。

### Revision 冲突

如果 `apply_profile_change` 或 CLI 返回 `CONFIG_REVISION_CONFLICT`，说明预览后文件被另一个进程或用户修改。不要绕过 Revision；重新运行预览，审查新 Diff，再用新的 `before_revision` 写入。

## 8. 任务长期停留在 `queued`

**可能原因**：全局/项目并发上限、Provider 限流、旧任务未终止、磁盘配额不足。

**检查**：

```text
get_task(task_id)
list_profiles
pnpm dsh-bridge doctor --json --redacted
```

不要重复点击 `delegate_task` 造成重复任务。确认现有任务是否仍处于 `running`，再等待有界时间或对明确失控的任务调用 `cancel_task`。

## 9. 任务无法取消或仍有进程

**处理顺序**：

调用 `cancel_task(task_id)` 后，通过 `wait_task` 或 `get_task` 等待终态并检查剩余执行进程。取消是请求，不能把“已发送取消”当成“进程已经退出”。保留 Worktree 供审查和继续；需要手工终止时先确认进程属于该任务，避免停止其他 DSH 项目。

## 10. Worktree 创建失败或主工作区变脏

**原因**：不是 Git 仓库、工作区路径不在 Allowed Root、已有同名 Worktree、磁盘空间不足，或用户同时在主工作区写入。

**检查**：

```bash
git status --short
git worktree list
df -h .
pnpm dsh-bridge doctor --json --redacted
```

Bridge 不应为了创建任务而执行 `git reset`、`git clean` 或覆盖用户修改。清理旧 Worktree 前，先检查对应 Task 已进入终态，并保存仍需要的 Patch 和结果。当前 CLI 没有通用 Task 清理命令，不要把安装用的 `--dry-run` 当作 Worktree 清理入口。

## 11. 结果缺少 Diff、测试或 Artifact

**症状**：Task 显示 `completed`，但结果没有可审查证据。

**核对**：

- Task 是否真正进入 `collecting` 后再进入 `completed`；
- Worktree 是否仍存在；
- 测试命令是否有退出码和耗时；
- 大 Patch 是否被正确放入 Artifact Store，而不是因为 MCP 结果过大被截断；
- `read_task_artifact` 的 offset/limit 和 SHA-256 是否一致。

没有证据的“完成”不能被 Codex 直接接受。按验收未通过处理，并通过 `continue_task` 要求补证据；不要手工编辑持久化任务状态。

## 12. Bridge 重启后任务变成 `interrupted`

这通常是正确的保守行为：Bridge 无法证明任务在崩溃时已完成。保留 Task Store、事件和 Worktree，先获取：

```text
get_task(task_id)
get_task_result(task_id)
```

然后根据已有证据选择继续、重试或清理。不要手工把状态文件改成 `completed`，否则会破坏审计链。

重启后继续任务时，新的 Run 使用原 `profile_id` 当前的模型路由；修改 Profile 不会重写历史。若报 Session Agent Preset 不匹配，恢复与历史一致的 `dsh.agent_preset` 后再继续，或为新 Preset 创建新任务；不能在续接时替换历史 Preset。

## 13. Native Shell Agent 没有出现

Native Shell 是可选能力，不是 Direct Mode 的前置条件。确认你显式运行了安装命令：

```bash
pnpm dsh-bridge setup \
  --project "$BRIDGE_PROJECT" --source . \
  --codex-agent --mode native-shell
```

然后检查项目 `.codex/agents/dsh-orchestrator.toml` 是否生成、MCP 是否可访问，并重新打开 Codex 会话。该 Agent 只是调度外壳；DSH 仍在独立 Runtime 中执行，不能期待 DSH 模型显示为 Codex 原生模型。

## 14. 复现真实 DSH 闭环

从源码 checkout 执行：

```bash
pnpm test:e2e:dsh
pnpm test:e2e:setup
```

测试使用 `DSH_BRIDGE_DSH_BIN` 指定的运行时和当前配置的真实 Provider/Model，通过 STDIO MCP 验证任务、继续/取消、Worktree、Patch 和 Artifact Hash。运行前检查脚本要求的路由在实时目录中存在；这些命令可能产生模型费用，不能作为无凭据安装检查。

通过 `DSH_BRIDGE_E2E_PROVIDER`、`DSH_BRIDGE_E2E_MODEL` 选择第一条路由，矩阵使用 `DSH_BRIDGE_E2E_SECOND_PROVIDER`、`DSH_BRIDGE_E2E_SECOND_MODEL` 选择第二条。可选的 Effort 必须为目录返回的支持值，测试不做推理档位回退。完整参数见[入门页](getting-started.md#8-真实-dsh-闭环验证)；日志默认位于仓库外。

[`real-dsh-rc8.json`](../tests/e2e/evidence/real-dsh-rc8.json) 和 [`real-dsh-rc8.patch`](../tests/e2e/evidence/real-dsh-rc8.patch) 是旧版历史证据。本版状态见[兼容矩阵](compatibility.md)。不要把 Provider 密钥或未经脱敏的 E2E 日志提交到仓库。

## 15. 日志污染、重复任务或递归委派

### stdout 污染

任何非 MCP 内容写到 stdout 都可能破坏协议。将日志等级、Banner 和调试输出改到 stderr/文件，重新运行 MCP Contract Test。

### 重复任务

保存已返回的 `task_id`，通过 `get_task` 检查现有任务；不要因为一次等待超时就再次调用 `delegate_task` 创建第二个 Task。

### 递归委派

确认 Profile 禁用了反向 Codex Provider，且 `delegation_depth`、`max_depth`、`max_children` 已生效。递归调用应快速失败，并回收已创建资源。

## 16. 最小问题报告模板

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
