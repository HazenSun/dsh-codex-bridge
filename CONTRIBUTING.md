# Contributing to DSH × Codex Bridge

感谢参与。这个项目的核心难点不是再包一层命令，而是把 Codex 的委派体验、DSH 的 Agent Runtime、MCP 协议、Worktree 隔离和可复核证据做成一个可以长期维护的开源系统。

项目目前处于 `0.1.0-alpha.2` 源码可用阶段。提交代码前，请先确认改动属于当前里程碑，并阅读 [架构规划](docs/architecture.md)、[施工规划](docs/implementation-plan.md) 和 [安全模型](docs/security.md)。

## 1. 贡献范围

欢迎：

- Protocol Schema、错误码和状态机的改进；
- DSH `0.1.0-rc.8` Adapter、生命周期和 Contract Test；
- MCP 工具、CLI、Codex Plugin 和 DSH Plugin 的纵向闭环；
- Worktree、Artifact、恢复、取消和资源限制；
- 安全测试、故障注入、性能基准和跨平台修复；
- Quickstart、配置参考、示例和翻译。

暂不欢迎直接进入主线的方向：

- 解析 DSH CLI/UI 文本或模拟键盘操作；
- 把 DSH 描述为 Codex 原生模型或原生 Sub-Agent；
- 自动写入用户主分支、自动部署或无条件访问网络；
- 未经 RFC 的新 Host、远程 SaaS 或复杂 Dashboard；
- 让 DSH 私有类型泄露到共享 Protocol。

## 2. 开发环境

### 前置条件

- Node.js `22.19+` 或 `24+`；
- pnpm；
- Git；
- DSH `0.1.0-rc.8`（仅在 DSH Adapter、集成和 E2E 测试中需要）；
- Codex CLI/Desktop（验证 Codex Plugin/MCP 时需要）。

### 获取源码

```bash
git clone https://github.com/HazenSun/dsh-codex-bridge.git
cd dsh-codex-bridge
corepack enable
pnpm install
```

以根目录 `package.json` 的实际 scripts 为准。完整检查命令如下：

```bash
pnpm verify
```

凭据齐全且改动涉及 DSH Runtime 时，另运行 `pnpm test:e2e:dsh`；它会产生真实 Provider 调用。

## 3. 先理解架构边界

代码应保持以下依赖方向：

```text
protocol ← config ← task-engine ← mcp-server / cli
                                  ↘ workspace / artifacts
dsh-runtime ← dsh-plugin
codex-plugin → mcp-server contract
```

- `protocol` 不依赖 DSH、Codex 或 MCP 宿主类型；
- DSH 包的导入集中在 `dsh-runtime` / `dsh-plugin`；
- Codex Plugin 只提供 Skill、MCP 声明和可选 Agent 模板；
- Task Engine 不应直接操作 Codex Thread，也不应解析终端输出；
- 每个新增 Task 状态都必须定义恢复、取消、超时和终态行为。

## 4. 分支与提交

建议从最新主分支创建短生命周期分支：

```bash
git switch main
git pull --ff-only
git switch -c feat/<short-description>
```

提交应小而聚焦，标题使用清晰的动词和范围，例如：

```text
feat(protocol): add v1alpha1 artifact manifest
fix(workspace): reject symlink escape outside allowed root
test(dsh): cover cancel followed by dispose
docs(quickstart): clarify source and release installation
```

不要在一个提交中同时重构架构、改协议、升级 DSH 和重写文档。涉及协议或公共 CLI 的变更必须同时更新 Schema、测试和文档。

## 5. 实现要求

### 协议与 Schema

- 所有 Host 交互使用版本化 JSON Schema；
- 新字段说明兼容性和默认值；
- 未知或冲突字段 fail-loud；
- 错误包含稳定 code、可操作 message 和 trace/task ID；
- 大 Artifact 使用引用、Hash、大小和分页，而不是无限内联。

### DSH Adapter

- 只面向锁定的 DSH `0.1.0-rc.8` 编写行为适配；
- 使用 `ctx.agents.create()`、`followup()`、`cancel()`、`whenIdle()`、`dispose()` 的生命周期证据；
- Preset、Model Selection、Session Event 的变化必须有 Contract Fixture；
- DSH 升级必须更新 Compatibility Matrix，不要在业务层散落版本判断。

### 安全与可靠性

- Prompt 不是权限系统；路径、网络、命令和资源由代码执行；
- 默认使用 isolated Worktree，不覆盖主工作区；
- Provider credential 不进入 Bridge、Codex、Artifact 或日志；
- 取消、超时、SIGTERM、MCP EOF 和进程崩溃都要有可复核状态；
- 日志记录事件和证据，不记录模型隐藏推理；
- 错误和模型输出均视为不可信输入。

## 6. 测试分层

### 单元测试

覆盖 Schema 边界、状态机、幂等、Profile 优先级、路径 Realpath、Artifact Hash/分页和原子 Store。

### Contract Test

覆盖 DSH 导出、Agent 生命周期、Preset、Model Selection、Session Event 和 MCP Tool Schema Golden Files。Contract Test 不应依赖真实 Provider。

### 集成测试

使用 Fake LLM、Git Fixture 和受控 Shell，验证两个任务并发、冲突、失败、取消、超时、递归上限和 Artifact 收集。

### E2E

至少包含：

- Codex CLI → MCP → DSH → Worktree → Result；
- Direct Mode 与 Native Shell Mode 各一条；
- Provider 429/5xx、MCP EOF、Bridge SIGTERM、进程崩溃；
- 从干净环境跑 Quickstart；
- 真实 DSH `0.1.0-rc.8` 闭环（凭据不能进入 CI 日志）。

## 7. 修改文档

用户文档必须：

- 区分“已实现”“施工目标”和“未来发布”；
- 说明 Direct Mode 是默认路径，Native Shell 是显式可选项；
- 不承诺未通过 E2E 的能力；
- 给出失败时的下一步和可脱敏的诊断方式；
- 命令、配置字段和实际 `--help` 输出保持一致。

文档只改中文会让术语漂移；首次出现时同时给出英文术语，例如“隔离工作树（isolated Worktree）”“结构化产物（Artifact Manifest）”。

## 8. Changeset 与同步版本

只要改动会进入发布包，就添加 Changeset：

```bash
pnpm changeset
```

Codex Plugin、DSH Plugin 和共享协议的版本关系必须符合兼容矩阵。不得单独发布一个与协议不匹配的 Plugin；如果是仅文档或测试变更，也应在 PR 中说明无需 Changeset。

## 9. Pull Request 清单

PR 描述至少包含：

- 背景、用户影响和实现边界；
- 相关 Milestone / Issue；
- 是否改变 Protocol、CLI、Plugin、Profile 或安全策略；
- 测试命令和结果；
- 失败路径、取消路径、恢复策略；
- 文档、示例、Compatibility Matrix 是否同步；
- 是否添加/更新 Changeset；
- 是否使用了真实 Provider（如是，说明如何保护凭据）。

提交前确认：

- [ ] 无 API Key、Cookie、Token、私有日志或本地路径快照；
- [ ] lint、类型检查、单元/Contract 测试通过；
- [ ] 相关集成/E2E 通过，或明确记录环境限制；
- [ ] 主工作区保护和 Worktree 清理没有回归；
- [ ] `README`、Quickstart、配置、安全和故障排查内容一致。

## 10. 提交 Issue 前

先搜索已有 Issue，并附上最小可复现信息：Bridge/DSH/Node/OS 版本、Mode、Profile、Task/Trace ID、期望与实际行为、脱敏 doctor 输出。安全问题请看 [SECURITY.md](SECURITY.md)，不要公开利用细节。

## 11. 设计讨论

影响以下内容的改动应先开 RFC 或 ADR：

- Host-neutral Protocol 或状态机；
- DSH Adapter 边界和版本策略；
- 权限、网络、Shell、密钥和默认 Worktree 行为；
- Codex Plugin 的 Skill/MCP/Native Shell 体验；
- 远程运行时、非 Git 项目或新 Host。

讨论时优先提供：问题、约束、被拒绝的替代方案、迁移路径、测试计划和文档影响。好的开源设计不是把所有未来可能性都提前实现，而是让当前边界清楚、可验证、可替换。

## 12. 行为标准

参与项目即同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。感谢你帮助把一个有用的本地工具，建设成值得信任的开源基础设施。
