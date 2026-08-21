# Getting Started

本页面向第一次接触 DSH × Codex Bridge 的开发者。目标是让你理解运行边界，并在一个隔离的 Git Worktree 中完成第一个可审查任务。

> **状态说明**
>
> 当前版本为 `0.1.0-alpha.2`，源码安装、CLI 初始化、DSH Profile/Codex Plugin 安装和真实 DSH `0.1.0-rc.8` 闭环均可运行。npm 包和 Marketplace 公共发布尚未进行。

## 1. 你将得到什么

完成 Quickstart 后，预期可以看到以下闭环：

```text
Codex → delegate_task → Bridge Task Engine → DSH Agent
                                  ↓
                       isolated Git Worktree
                                  ↓
                    Diff + tests + result manifest
                                  ↓
                            Codex review
```

Bridge 默认不会把 DSH 的结果直接写入你的主工作区，也不会替你提交、合并或部署。

## 2. 前置条件

### 必需软件

- Node.js `22.19+` 或 `24+`。版本范围跟随当前 DSH `0.1.0-rc.8` 基线。
- pnpm（源码开发路径推荐通过 Corepack 管理）。
- Git，并且当前项目可以创建 Git Worktree。
- DSH `0.1.0-rc.8`，已经至少配置一个可用 Provider、Model 和 Agent Preset。
- Codex CLI 或 Desktop。Codex 侧必须能够加载本地 STDIO MCP。

### 必需配置

DSH Provider 的 API Key、Endpoint 和 Cookie 只应配置在 DSH 的安全配置中。Bridge 只读取 Profile 所需的 Provider/Model 标识，不要求也不应要求把密钥复制到 Codex 配置或项目文件中。

在开始前分别确认：

```bash
node --version
pnpm --version
git --version
dsh --version
```

必须看到 DSH `0.1.0-rc.8`；如果版本不同，请先阅读 [配置参考](configuration.md) 的兼容性说明，并不要把失败归因给 Bridge。

## 3. 路径 A：从源码安装

这是当前推荐且可复现的安装方式，适合用户、贡献者和端到端验证。

```bash
git clone https://github.com/HazenSun/dsh-codex-bridge.git
cd dsh-codex-bridge
corepack enable
pnpm install
pnpm build
```

构建后可以运行以下命令：

```bash
pnpm dsh-bridge --help
pnpm dsh-bridge doctor --json --redacted
```

根目录 `package.json` 已提供上述脚本；如果你从其他目录调用，请先切换到源码 checkout，或使用该 checkout 的绝对路径运行 pnpm。不要跳过版本、Profile 或配置校验。

## 4. 发布包状态

npm 包和 Codex Plugin Marketplace 包尚未发布。当前不要执行未经 Release Notes 确认的全局安装命令；正式发布后，包名、审核状态、Node 运行时和 DSH 版本约束会以对应 Release Notes 为准。

## 5. 一键安装与首次设置

`setup` 是推荐入口。它先安装两端插件；未选择模型时停在可恢复的设置状态，不会猜测 Provider/Model，也不会覆盖 Provider 密钥或项目源码：

```bash
BRIDGE_PROJECT=/absolute/path/to/your-project
pnpm dsh-bridge setup --project "$BRIDGE_PROJECT" --source . --dry-run
pnpm dsh-bridge setup --project "$BRIDGE_PROJECT" --source .
```

新建 Codex 任务并说：

```text
帮我完成 DSH Bridge 初次设置。所有配置先预览，确认后再写入。
```

Codex 会读取 DSH 的实时模型目录、建议语义化 Profile。首次文件创建前展示精确 `setup` 计划，后续 Profile 写入前展示语义 Diff。DSH 没有 Provider 时必须先在 DSH Settings 中完成凭据设置；不要把密钥粘贴给 Codex。

安装流程的职责：

1. 构建产物后创建并校验本地 DSH Profile；
2. 创建或更新 `codex-bridge` DSH Profile；
3. 注册仓库内 Marketplace 与本地 STDIO MCP Server；
4. 安装并启用 Codex Skill；
5. 仅在显式指定时生成 `dsh_orchestrator` Native Shell Agent；
6. 缺少 `bridge.yaml` 时仍启动设置工具，返回明确下一步；
7. 打印已安装的 Profile 和插件状态。

一键安装不会替用户猜测第三方模型、上传密钥、修改主分支或打开不受限网络权限。需要纯 CLI 设置时：

```bash
pnpm dsh-bridge models list --config "$BRIDGE_PROJECT/bridge.yaml" --details
pnpm dsh-bridge setup \
  --project "$BRIDGE_PROJECT" --source . \
  --provider <provider-id> --model <model-id> \
  --profile-id default-code
```

## 6. 连接检查

先运行只读检查：

```bash
BRIDGE_PROJECT=/absolute/path/to/your-project
pnpm dsh-bridge doctor --config "$BRIDGE_PROJECT/bridge.yaml" --json --redacted
pnpm dsh-bridge profiles list --config "$BRIDGE_PROJECT/bridge.yaml"
pnpm dsh-bridge profiles validate --config "$BRIDGE_PROJECT/bridge.yaml"
pnpm dsh-bridge config show --config "$BRIDGE_PROJECT/bridge.yaml" --effective --redacted > effective-config.json
```

当前健康检查报告：

| 检查项       | 期望结果                                     |
| ------------ | -------------------------------------------- |
| Node / Codex | 当前运行版本                                 |
| DSH          | 精确为 `0.1.0-rc.8`                          |
| DSH Plugin   | `codex-bridge` Profile 能合成 Bridge Bundle  |
| Config       | 项目和 Profile Schema 可解析，路径完成规范化 |
| MCP          | 真正启动 STDIO Server，并列出可发现工具      |

Provider 凭据和模型可调用性由 `pnpm test:e2e:dsh` 的真实请求验证；`doctor` 不触发付费模型调用。

若 `doctor` 失败，先保留脱敏后的 JSON 输出，再参照 [故障排查](troubleshooting.md)。

### 后续通过 Codex 修改模型

先在 DSH 中加入模型，再让 Codex 将该路由映射成 Bridge Profile。Bridge 无需为每个新模型发版。

```text
显示 DSH 当前可用模型。
把 kimi-k2.7-code 添加成 fast-code Profile，先预览。
把 deepseek-v4-flash 设为默认模型，确认后再写入。
回滚上一次 Bridge 模型配置。
```

配置写入需要预览返回的 SHA-256 Revision；并发修改会失败而不是覆盖。成功写入后若返回 `restart_required: true`，新建 Codex 任务再使用新 Profile。

## 7. 第一个 Direct Mode 任务

在 Codex 新会话中可以直接使用自然语言：

```text
使用 DSH 处理这个任务，自己判断单 Agent 还是多 Agent。
```

这个短句已经是完整的路由意图。Skill 会先发现 Profile，再按任务中是否存在独立工作流、独立审查收益和协调成本解析策略；用户不需要主动调用 MCP 工具。等价的显式发现步骤是：

```text
调用 list_profiles，确认当前可用的 Profile、权限、超时和模型标识。
```

选择一个低风险 Profile 后，给出明确的验收标准。目标工具调用形式如下：

```json
{
  "protocol_version": "bridge.dsh.dev/v1alpha1",
  "project_id": "your-project-id",
  "profile_id": "typescript_worker",
  "objective": "为一个纯函数增加边界条件测试，不改变公共 API。",
  "acceptance_criteria": [
    "新增测试覆盖空输入和重复输入",
    "现有测试全部通过",
    "返回 unified diff 和测试摘要"
  ],
  "delegation": {
    "strategy": "single",
    "reason": "修改集中在一个纯函数，拆分不会产生并行收益。",
    "roles": []
  },
  "workspace": {
    "mode": "isolated_worktree",
    "base_ref": "HEAD"
  }
}
```

自动多 Agent 请求示例：

```json
{
  "delegation": {
    "strategy": "auto",
    "reason": "实现和独立测试审查可以分别完成。",
    "roles": ["analysis", "tests"]
  }
}
```

角色必须来自 `list_profiles` 返回的 `delegation.roles`，数量不能超过 `max_children`。`auto` 带有至少一个合法子角色时解析为 `multi`；没有子角色时安全地解析为 `single`。Codex 已经做出明确判断时应直接提交 `single` 或 `multi`，不要把明确决策重新交回后端。

`delegate_task` 应快速返回 `task_id`，而不是让 Codex 长时间阻塞。随后查询：

```text
get_task(task_id)
get_task_result(task_id)
read_task_artifact(task_id, artifact_id, offset, limit)
```

Codex 应检查至少五类证据：任务状态、`delegation_decision`、`delegation_evidence`、修改文件与 Diff、测试命令和 Warnings。多 Agent 请求若没有观察到足够的 `subagent_calls` 或完成事件，会返回 `partial`；只有证据满足验收标准后，才决定接受或调用 `continue_task`。

## 8. 真实 DSH 闭环验证

构建完成并安装 DSH Profile 后，可以运行真实闭环测试：

```bash
pnpm test:e2e:dsh
```

模型矩阵测试会额外验证 Kimi、DeepSeek、并发路由、自动多 Agent 解析和真实子 Agent 事件：

```bash
pnpm test:e2e:model-matrix
```

这些测试会启动当前机器的 DSH `0.1.0-rc.8` `codex-bridge` Profile，使用已配置的真实 Provider/Model（不是 Fake LLM），通过 STDIO MCP 调用任务和 Artifact 工具，并验证隔离 Worktree、模型路由、Patch/Hash、同 Session 继续、新 run_id、历史结果保留、真实取消收敛与主工作区不变。

可复核证据：[`real-dsh-rc8.json`](../tests/e2e/evidence/real-dsh-rc8.json)、[`real-dsh-rc8.patch`](../tests/e2e/evidence/real-dsh-rc8.patch)、[`real-dsh-rc8-continue.patch`](../tests/e2e/evidence/real-dsh-rc8-continue.patch)。运行该命令会产生真实模型调用，Provider 凭据必须已由 DSH 配置，不能写入仓库或 CI 日志。

## 9. Native Shell Mode（可选）

需要把调度外壳显示成 Codex 原生 Agent Thread 时，显式生成项目级 Agent：

```bash
pnpm dsh-bridge init /absolute/path/to/your-project --mode native-shell --codex-agent
pnpm dsh-bridge install --source . --codex-agent --mode native-shell
```

该命令会在项目中生成 `.codex/agents/dsh-orchestrator.toml`，其工具范围只包含 Bridge MCP 和必要的只读工具。它不改变 DSH 的执行模型，也不把 DSH 变成 Codex 原生模型；它只是一个低权限的调度层。

默认仍推荐 Direct Mode：它少一层上下文和调用成本，且更容易审查任务边界。

## 10. 完成后的核对清单

- [ ] `pnpm dsh-bridge doctor --json --redacted` 通过，且输出没有密钥。
- [ ] DSH 版本是锁定的 `0.1.0-rc.8`。
- [ ] Codex 可以发现 `list_profiles` 和 `delegate_task`。
- [ ] 任务运行在独立 Worktree，主工作区状态未改变。
- [ ] 结果包含 delegation 决策/证据、Diff、测试结果、Artifact Manifest 和失败原因（如有）。
- [ ] 取消任务后 Agent、Sub-Agent、Shell 子进程和临时资源均已回收。
- [ ] 需要继续时使用 `continue_task`，而不是重复创建一个没有上下文的新任务。

## 11. 下一步阅读

- 需要完整安装步骤：阅读[安装手册](installation.md)。
- 需要日常提示词和验收方式：阅读[使用手册](usage.md)。
- 想调整 Profile 和模型路由：阅读 [配置参考](configuration.md)。
- 遇到连接、Provider 或 Worktree 问题：阅读 [故障排查](troubleshooting.md)。
- 想理解任务、协议和隔离设计：阅读 [软件架构规划](architecture.md)。
- 想参与实现：阅读 [CONTRIBUTING.md](../CONTRIBUTING.md)。
