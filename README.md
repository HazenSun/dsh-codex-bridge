# DSH × Codex Bridge

> **把 Codex 的决策力与 DSH 的执行力连接起来。**

[![CI](https://github.com/HazenSun/dsh-codex-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/HazenSun/dsh-codex-bridge/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933.svg)](package.json)
[![DSH](https://img.shields.io/badge/DSH-0.1.0--rc.8-5B5BD6.svg)](docs/compatibility.md)

中文 · [English](README.en.md) · [安装](docs/installation.md) · [使用](docs/usage.md) · [架构](docs/architecture.md)

`dsh-codex-bridge` 是一个面向开发者的开源 Agent 基础设施：Codex 负责拆解目标、选择委派策略和验收证据；DeepSeek Harness（DSH）负责在指定 Profile 中执行代码、测试和内部 Sub-Agent 工作；Bridge 负责协议、隔离工作区、任务生命周期和可审查产物。

## 项目状态

**源码可用｜`0.1.0-alpha.2`｜DSH `0.1.0-rc.8` 闭环已验证**

当前版本可以从源码构建、初始化项目、安装本地 DSH Profile 与 Codex Plugin、运行健康检查，并通过 MCP 驱动 DSH 完成隔离 Worktree 任务。Alpha 1 的脱敏证据保存在 [`tests/e2e/evidence`](tests/e2e/evidence/)；Alpha 2 已通过可复现的 setup lifecycle、DeepSeek 闭环和 Kimi/DeepSeek model matrix，但按发布策略不提交本地执行日志。

当前发布形态是源码安装；npm 包和 Marketplace 公共发布尚未进行。第一版锁定的 DSH 兼容基线是 `0.1.0-rc.8`。DSH 处于 Developer Preview，因此升级 DSH 必须经过兼容性测试，不能仅凭版本号推断可用。

## 它解决什么问题？

当一个任务不值得消耗主控模型的完整上下文时，Codex 可以把它交给 DSH：

```text
Codex（计划 / 委派 / 审查）
        │
        │  Direct Mode：默认、低额外成本
        ▼
本地 MCP Gateway + Task Engine
        │
        ▼
DSH Plugin（Profile / 模型 / 工具 / Sub-Agent）
        │
        ▼
隔离 Worktree → Diff、测试、摘要、Artifact
```

Bridge 不把 DSH 宣称为 Codex 原生模型或原生 Sub-Agent。默认的 **Direct Mode** 是 Codex 主线程直接调用 Bridge MCP；可选的 **Native Shell Mode** 会生成一个窄职责的 Codex 自定义 Agent 作为调度外壳，以获得更接近原生线程的体验，但会额外消耗 Codex 用量。

## 3 分钟安装与首次设置（源码版）

当前请使用源码路径；npm 与 Marketplace 尚未发布，不要从公共 registry 或目录安装同名包。

前置条件：Node.js `22.19+` 或 `24+`、pnpm、Git、DSH `0.1.0-rc.8` 和 Codex CLI/Desktop。Provider 凭据只在 DSH 中配置，不要粘贴给 Codex 或写入 `bridge.yaml`。

```bash
git clone https://github.com/HazenSun/dsh-codex-bridge.git
cd dsh-codex-bridge
corepack enable
pnpm install --frozen-lockfile
pnpm build

BRIDGE_PROJECT=/absolute/path/to/your-project
pnpm dsh-bridge setup --project "$BRIDGE_PROJECT" --source . --dry-run
pnpm dsh-bridge setup --project "$BRIDGE_PROJECT" --source .
```

第二条 `setup` 命令安装本地 DSH Profile 与 Codex Plugin。若项目还没有 `bridge.yaml`，它会停在 `needs_execution_profile`，不会猜测模型或复制凭据。新建 Codex 任务并直接说：

```text
帮我完成 DSH Bridge 初次设置。所有配置先预览，确认后再写入。
```

Codex 会检查状态、读取 DSH 已配置的 Provider/Model、建议一个语义化 Profile，并在首次创建前展示精确的 `setup` 计划。`bridge.yaml` 存在后，所有 Profile 变更都先展示语义 Diff。DSH 尚未配置 Provider 时，流程会停下并引导你在 DSH Settings 中完成凭据设置。

也可以完全使用 CLI。先发现 DSH 模型，再用精确 ID 完成首次配置：

```bash
pnpm dsh-bridge models list --config "$BRIDGE_PROJECT/bridge.yaml" --details
pnpm dsh-bridge setup \
  --project "$BRIDGE_PROJECT" \
  --source . \
  --provider <dsh-provider-id> \
  --model <dsh-model-id> \
  --profile-id default-code \
  --reasoning-effort <advertised-effort>
```

首次设置完成后，在新 Codex 任务中直接说：

```text
使用 DSH 处理这个任务，自己判断单 Agent 还是多 Agent。
```

`delegate-to-dsh` Skill 会发现可用 Profile，根据独立工作流和审查收益选择 `single` 或 `multi`，并把理由和角色写入任务。显式说“单 Agent”或“多 Agent”始终覆盖自动判断。多 Agent 只有在 DSH Session 中观察到足够的子 Agent 调用和完成事件后才算通过。

## 用 Codex 新增、切换和回滚模型

新模型的底层支持只需在 DSH 中增加 Provider/Model；但要让 Codex 安全调用，还需将它映射成 Bridge 的命名 Profile。完成 DSH 配置后，可以直接告诉 Codex：

```text
显示 DSH 当前可用模型。
把 kimi-k2.7-code 加成 fast-code Profile，先预览，不要写入。
把 deepseek-v4-flash 设为当前项目默认模型，确认后再修改。
回滚上一次 Bridge 模型配置。
```

Codex 只能选择 `discover_dsh_models` 实际返回的路由。每次写入都必须先预览，使用 SHA-256 Revision 防止覆盖并发修改，成功前会创建 `0600` 权限的有界备份。等价 CLI：

```bash
# 预览新增；输出 before_revision
pnpm dsh-bridge profiles add fast-code \
  --config "$BRIDGE_PROJECT/bridge.yaml" \
  --provider <dsh-provider-id> \
  --model <dsh-model-id> \
  --reasoning-effort high

# 审查后写入
pnpm dsh-bridge profiles add fast-code \
  --config "$BRIDGE_PROJECT/bridge.yaml" \
  --provider <dsh-provider-id> \
  --model <dsh-model-id> \
  --reasoning-effort high \
  --apply --expected-revision <before_revision>

# 预览把已有 Profile 切到另一个 DSH 模型
pnpm dsh-bridge profiles update fast-code \
  --config "$BRIDGE_PROJECT/bridge.yaml" \
  --provider <dsh-provider-id> \
  --model <dsh-model-id> \
  --reasoning-effort high

# 设置默认同样先预览，再带 Revision 重复执行并加 --apply
pnpm dsh-bridge profiles set-default fast-code \
  --config "$BRIDGE_PROJECT/bridge.yaml" \
  --project-id <project-id>
```

默认情况下，配置变更只影响后续任务；工具返回 `restart_required: true` 时请新建 Codex 任务。完整命令与安全边界见[安装手册](docs/installation.md)和[配置参考](docs/configuration.md)。

安装/配置只会处理 `bridge.yaml`、`.dsh-codex-bridge/config-backups/`、DSH `codex-bridge` Profile 和 Codex Plugin；不会修改项目源码、主分支、`.env` 或 DSH 凭据。

### 真实 DSH 闭环验证

该命令会启动真实的 DSH `0.1.0-rc.8` Profile，并调用当前机器已配置的 Provider；它不是 Fake LLM 或离线模拟：

```bash
pnpm test:e2e:dsh
pnpm test:e2e:model-matrix
pnpm test:e2e:setup
```

发布验证时可用 `DSH_BRIDGE_EVIDENCE_DIR=/tmp/dsh-bridge-evidence` 把 E2E 运行证据写到仓库外；`test:e2e:setup` 只向 stdout 返回脱敏检查摘要。

对应证据：[`real-dsh-rc8.json`](tests/e2e/evidence/real-dsh-rc8.json)、[`real-dsh-rc8.patch`](tests/e2e/evidence/real-dsh-rc8.patch)、[`real-dsh-rc8-continue.patch`](tests/e2e/evidence/real-dsh-rc8-continue.patch) 与 [`model-matrix.json`](tests/e2e/evidence/model-matrix.json)。运行前必须完成 DSH Provider 配置；测试会产生真实网络/模型调用，并在临时 Git Fixture 中验证任务状态、模型路由、自动单/多 Agent 决策、子 Agent 事件、Artifact Hash、同 Session 继续、真实取消和主工作区不变。

### 未来发布安装（npm / Marketplace）

npm 包和 Codex Plugin Marketplace 包仍未发布。未来的包名、审核状态、Node 运行时和 DSH 版本约束，以正式 Release Notes 为准；当前版本不要执行未经发布说明确认的全局安装命令。

## 两种运行模式

| 模式                          | 调用链                                 | 适合场景                                      | 代价                                 |
| ----------------------------- | -------------------------------------- | --------------------------------------------- | ------------------------------------ |
| **Direct Mode（默认）**       | Codex → MCP → DSH                      | 批量执行、低额外 Codex 用量、清晰的结构化结果 | DSH 任务不是 Codex 原生 Agent Thread |
| **Native Shell Mode（可选）** | Codex → `dsh_orchestrator` → MCP → DSH | 需要线程可见性和显式调度外壳                  | 增加一层 Codex Agent 和相应用量      |

两种模式共用协议、Profile、任务状态、Worktree 和 Artifact；切换模式不应改变任务结果格式。

## 文档导航

- [完整安装手册](docs/installation.md)：环境、源码构建、Direct/Native Shell、升级和卸载边界。
- [完整使用手册](docs/usage.md)：自然语言触发、单/多 Agent、Profile、结果审查、继续和取消。
- [10 分钟入门](docs/getting-started.md)：从源码安装到第一个可审查任务。
- [配置参考](docs/configuration.md)：Profile、模型路由、工作区、并发与策略。
- [技术可行性报告](docs/feasibility.md)：公开 API 证据、边界和 M0 PoC。
- [软件架构规划](docs/architecture.md)：Gateway、Task Engine、DSH Adapter 与协议。
- [施工与发布规划](docs/implementation-plan.md)：里程碑、测试和 Definition of Done。
- [安全模型](docs/security.md)：密钥、路径、网络、Shell、递归和产物边界。
- [故障排查](docs/troubleshooting.md)：doctor、MCP、DSH、Provider、Worktree 和恢复。
- [贡献指南](CONTRIBUTING.md)：本地开发、测试、变更和 Pull Request 规范。
- [安全漏洞披露](SECURITY.md)：不要在公开 Issue 中提交敏感漏洞细节。
- [行为准则](CODE_OF_CONDUCT.md)：参与项目时共同维护的协作标准。
- [支持渠道](SUPPORT.md)：Bug、功能建议和安全问题应该去哪里。
- [变更记录](CHANGELOG.md)：当前 Alpha 的功能与已知限制。

## 当前限制

- 仅支持源码安装；npm 包和公共 Codex Plugin Directory 尚未发布。
- 当前写入运行时只支持 Git isolated Worktree。
- Bridge 不自动提交、合并、部署或发布 DSH 结果。
- Profile 中部分网络、拒绝路径、文件数和磁盘策略仍是协议声明，尚未全部映射为 Bridge 侧执行器。
- 确定性的跨模型执行应使用多个命名 Profile；角色级子模型强制路由仍需 DSH Child Setup Contract。

## 设计承诺

- **Protocol first**：Codex、DSH 和未来的其他 Host 只交换版本化 JSON，不暴露 Cordis 私有类型。
- **Profile over model**：用户选择语义化 Profile；Provider、Model 和 Reasoning 是可验证的解析结果。
- **Safety by default**：默认隔离 Worktree、最小权限、资源上限、可取消和秘密脱敏。
- **Codex owns the decision**：DSH 返回证据，Codex 决定接受、继续、取消或放弃。
- **Release as one unit**：Codex Plugin、DSH Plugin 和共享协议固定版本同步发布。

## 开源许可

代码采用 Apache-2.0。第三方依赖、示例和 DSH 本身保留各自的版权与许可证；正式发布前会生成依赖许可证清单、SBOM 和构建来源证明。

## 贡献与反馈

项目已具备可复现的源码闭环。提交 Issue 前请先阅读 [贡献指南](CONTRIBUTING.md) 与 [故障排查](docs/troubleshooting.md)；涉及安全问题请遵循 [SECURITY.md](SECURITY.md)，不要把密钥、Cookie、完整日志或私有代码贴到公开 Issue。
