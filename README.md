# DSH × Codex Bridge

> **把 Codex 的决策力与 DSH 的执行力连接起来。**

[![CI](https://github.com/HazenSun/dsh-codex-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/HazenSun/dsh-codex-bridge/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933.svg)](package.json)
[![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2-5B5BD6.svg)](docs/compatibility.md)

中文 · [English](README.en.md) · [安装](docs/installation.md) · [使用](docs/usage.md) · [架构](docs/architecture.md)

`dsh-codex-bridge` 是一个面向开发者的开源 Agent 基础设施：Codex 负责拆解目标、选择委派策略和验收证据；DeepSeek Harness（DSH）负责在指定 Profile 中执行代码、测试和内部 Sub-Agent 工作；Bridge 负责协议、隔离工作区、任务生命周期和可审查产物。

## 项目状态

**源码安装｜`0.1.0-alpha.3`｜目标 DSH `0.2.0-rc.2`**

Bridge 提供源码构建、项目设置、本地 DSH Profile/Codex Plugin 安装、模型管理和隔离 Worktree 任务。当前版本的实际验证范围见[兼容矩阵](docs/compatibility.md)。[`tests/e2e/evidence`](tests/e2e/evidence/) 中的 rc.8 模型调用是历史证据，不能作为新版 DSH 的验证结果。

Bridge npm 包和 Marketplace 公共发布尚未进行。Alpha 3 对接官方 npm 的 DSH `0.2.0-rc.2`，使用精确版本，并可与已有 DSH 安装并存。

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

## 让 Codex 完成安装和首次配置

在有文件和终端权限的 Codex 任务中，替换下面三个绝对路径后直接发送：

```text
请帮我从 https://github.com/HazenSun/dsh-codex-bridge 安装 DSH × Codex Bridge。
目标 Git 项目：/absolute/path/to/your-project
Bridge 源码目录：/absolute/path/to/dsh-codex-bridge
Bridge 专用 DSH 安装目录：/absolute/path/to/dsh-bridge-runtime

先检查环境并展示安装计划，再构建 Bridge、安装官方 DSH 0.2.0-rc.2 和本地插件。
安装时使用 --dsh-bin 指向专用 DSH，保存启动配置并注册本地 MCP。
首次使用旧 DSH Home 前备份，或先用独立 DSH_HOME 验证；保留现有 DSH 和其他项目。
从 codex-bridge Profile 的实时模型目录选择精确 Provider/Model，展示配置 Diff 后完成 default-code。
如果缺少凭据，引导我在 DSH 中配置；最后运行 doctor 和配置校验，报告是否需要新建 Codex 任务。
安装期间不要运行真实模型任务。
```

当前安装需要 Node.js、pnpm、Git 和支持本地 Plugin/STDIO MCP 的 Codex CLI。凭据由 DSH 管理。Codex 可以完成命令执行和模型 Profile 配置；账号登录或缺失的 Provider 凭据仍需你在 DSH 中设置。

## 手动安装（源码版）

前置条件：Node.js `^22.19.0` 或 `>=24.0.0`、pnpm `11.19.0`、Git 和 Codex CLI/Desktop。Provider 凭据只在 DSH 中配置，不要粘贴给 Codex 或写入 `bridge.yaml`。

```bash
git clone https://github.com/HazenSun/dsh-codex-bridge.git
cd dsh-codex-bridge
corepack enable
pnpm install --frozen-lockfile
pnpm build

BRIDGE_RUNTIME=/absolute/path/to/dsh-bridge-runtime
npm install --prefix "$BRIDGE_RUNTIME" --no-audit --no-fund @deepseek-ai/dsh@0.2.0-rc.2
export DSH_BRIDGE_DSH_BIN="$BRIDGE_RUNTIME/node_modules/.bin/dsh"
"$DSH_BRIDGE_DSH_BIN" --version

BRIDGE_PROJECT=/absolute/path/to/your-project
pnpm dsh-bridge setup --project "$BRIDGE_PROJECT" --source . \
  --dsh-bin "$DSH_BRIDGE_DSH_BIN" --dry-run
pnpm dsh-bridge setup --project "$BRIDGE_PROJECT" --source . \
  --dsh-bin "$DSH_BRIDGE_DSH_BIN"
```

`setup` 安装本地 DSH Profile 与 Codex Plugin，并把选中的可执行路径及 DSH Home 保存到 Codex Home 的 `dsh-codex-bridge/runtime.json`。Desktop 后续 MCP 从该文件启动，无需继承终端的 `export`。首次使用已有 DSH Home 时，DSH 0.2 可能迁移旧 `settings.yaml`；先备份或使用独立 Home 验证，详见[安装手册](docs/installation.md)。

安装器同时通过官方 `codex mcp add` 注册明确的 Node、启动脚本和配置路径；不依赖插件 JSON 的路径变量展开。只安装 Marketplace 中的 Skill 插件还不等于完成本机运行时设置，首次使用应运行上述 `setup`。

保留 Bridge 源码和专用 DSH 目录，注册的启动路径会引用它们。使用自定义 `CODEX_HOME` 时，在该 Home 下安装和检查 MCP。后续若要让 Desktop 切换 DSH 路径或 Home，重新执行 `setup` 保存新选择；只在另一个终端 `export` 不会更新 Desktop。停用 Skill 插件也不会移除已注册的 MCP，完整停用步骤见[安装手册](docs/installation.md#11-卸载边界)。

没有 `bridge.yaml` 时，安装停在 `needs_execution_profile`。通过插件的 Setup 入口，或新建 Codex 任务后直接说：

```text
帮我完成 DSH Bridge 初次设置。所有配置先预览，确认后再写入。
```

Codex 会检查状态、读取 `codex-bridge` DSH Profile 可见的 Provider/Model、建议一个命名 Profile，并在首次创建前展示精确的 `setup` 计划。`bridge.yaml` 存在后，Profile 变更先展示语义 Diff。如果模型配置已在同一 DSH Home 的 `web` Profile 中，可以先用 `models sync --from-profile web` 预览同步 Provider 配置和安全凭据引用；没有配置时在 DSH 中完成。具体步骤见[安装手册](docs/installation.md)。

也可以完全使用 CLI。先发现 DSH 模型，再用精确 ID 完成首次配置：

```bash
pnpm dsh-bridge models list --config "$BRIDGE_PROJECT/bridge.yaml" --details
# 将这两个值替换为上一步返回的精确 ID
DSH_PROVIDER_ID='returned-provider-id'
DSH_MODEL_ID='returned-model-id'
pnpm dsh-bridge setup \
  --project "$BRIDGE_PROJECT" \
  --source . \
  --provider "$DSH_PROVIDER_ID" \
  --model "$DSH_MODEL_ID" \
  --profile-id default-code
```

首次设置完成后，在新 Codex 任务中直接说：

```text
使用 DSH 处理这个任务，自己判断单 Agent 还是多 Agent。
```

`delegate-to-dsh` Skill 会发现可用 Profile，根据独立工作流和审查收益选择 `single` 或 `multi`，并把理由和角色写入任务。显式说“单 Agent”或“多 Agent”始终覆盖自动判断。多 Agent 只有在 DSH Session 中观察到足够的子 Agent 调用和完成事件后才算通过。

## 用 Codex 新增、切换和回滚模型

先让新模型在 `codex-bridge` DSH Profile 中可见，再将它映射成 Bridge 的命名 Profile。已有 `web` 模型配置可通过受控同步复用；新增 Provider 协议仍需 DSH Adapter 支持。完成 DSH 配置后，可以直接告诉 Codex：

```text
显示 DSH 当前可用模型。
把目录中我选中的 Provider/Model 加成 fast-code Profile，先预览。
把 fast-code 设为当前项目默认 Profile，确认刚才的 Diff 后写入。
回滚上一次 Bridge 模型配置。
```

Codex 只能选择 `discover_dsh_models` 实际返回的路由。每次写入都必须先预览，使用 SHA-256 Revision 防止覆盖并发修改，成功前会创建 `0600` 权限的有界备份。等价 CLI：

```bash
# 预览新增；输出 before_revision
pnpm dsh-bridge profiles add fast-code \
  --config "$BRIDGE_PROJECT/bridge.yaml" \
  --provider "$DSH_PROVIDER_ID" \
  --model "$DSH_MODEL_ID"

# 审查后写入
pnpm dsh-bridge profiles add fast-code \
  --config "$BRIDGE_PROJECT/bridge.yaml" \
  --provider "$DSH_PROVIDER_ID" \
  --model "$DSH_MODEL_ID" \
  --apply --expected-revision 'before_revision-from-preview'

# 预览把已有 Profile 切到另一个 DSH 模型
# 先把 DSH_PROVIDER_ID/DSH_MODEL_ID 换成新路由的精确值
pnpm dsh-bridge profiles update fast-code \
  --config "$BRIDGE_PROJECT/bridge.yaml" \
  --provider "$DSH_PROVIDER_ID" \
  --model "$DSH_MODEL_ID"

# 设置默认同样先预览，再带 Revision 重复执行并加 --apply
pnpm dsh-bridge profiles set-default fast-code \
  --config "$BRIDGE_PROJECT/bridge.yaml" \
  --project-id 'project-id-from-config'
```

配置变更不改变正在执行的 Turn 或已有历史。工具返回 `restart_required: true` 时，新建 Codex 任务加载新配置；新任务和重启后继续的 Run 会使用当前 Profile。已有 Session 续接时必须保留原 Agent Preset，不能在继续时更换。完整说明见[安装手册](docs/installation.md)和[配置参考](docs/configuration.md)。

只有目录明确返回所选模型的推理档位时，才添加 `--reasoning-effort 'advertised-effort-id'`。发现模型和通过配置校验，不等于账号已经完成一次真实调用。

切换已有 Profile 的模型时，省略推理参数会保留旧值。需要使用新模型默认值时，在 `profiles update` 中加入 `--clear-reasoning-effort`，先预览再写入；它不能与 `--reasoning-effort` 同时使用。也可以告诉 Codex：“切换到我选中的模型，并清除旧推理档位，先预览。”

安装处理专用 DSH 目录、DSH `codex-bridge` Profile、本地 Codex Plugin 和启动配置；项目设置处理 `bridge.yaml`，后续变更的备份位于 `.dsh-codex-bridge/config-backups/`。模型管理只改变该项目的 Bridge Profile。启动配置则由同一 Codex Home 下的 Bridge 任务共用，切换运行时或 DSH Home 时需要一并核对。

### 真实 DSH 闭环验证

安装检查不调用生成模型。需要验证模型权限和任务执行时，再选择一个小任务或运行 E2E；以下命令会产生真实 Provider 请求，并可能产生费用：

```bash
pnpm test:e2e:dsh
pnpm test:e2e:model-matrix
pnpm test:e2e:setup
```

E2E 通过 `DSH_BRIDGE_E2E_PROVIDER`、`DSH_BRIDGE_E2E_MODEL` 和可选 `DSH_BRIDGE_E2E_EFFORT` 选择精确路由；多模型测试另有第二路参数。运行日志默认位于仓库外，也可设置 `DSH_BRIDGE_EVIDENCE_DIR`。参数示例见[入门页](docs/getting-started.md#8-真实-dsh-闭环验证)。

测试目标包括任务状态、模型路由、子 Agent 事件、Artifact Hash、继续、取消和 Worktree 隔离。脚本需要它所测试的路由仍存在于当前 DSH 目录；历史 Flash/Kimi ID 不能直接当作新版本默认值。历史 rc.8 证据保留在 [`tests/e2e/evidence`](tests/e2e/evidence/)；本版实际执行结果以[兼容矩阵](docs/compatibility.md)为准。

### 未来发布安装（npm / Marketplace）

npm 包和 Codex Plugin Marketplace 包仍未发布。未来的包名、审核状态、Node 运行时和 DSH 版本约束，以正式 Release Notes 为准；当前版本不要执行未经发布说明确认的全局安装命令。

当前连接使用本地 STDIO MCP。源码安装无需部署公网 HTTPS 服务；公共目录上架是独立的发布步骤。

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

提交 Issue 前请先阅读 [贡献指南](CONTRIBUTING.md) 与 [故障排查](docs/troubleshooting.md)；涉及安全问题请遵循 [SECURITY.md](SECURITY.md)，不要把密钥、Cookie、完整日志或私有代码贴到公开 Issue。
