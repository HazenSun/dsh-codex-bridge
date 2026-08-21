# Security Policy

DSH × Codex Bridge 会让 Agent 访问本地代码、执行工具并调用外部模型 Provider。请把安全问题当作高优先级维护事项处理。

## 支持范围

当前项目处于 `0.1.0-alpha.1` 源码可用阶段：

- 仅把仓库中明确标注的版本视为受支持；
- DSH 兼容基线为 `0.1.0-rc.8`；
- 未发布的 npm 包、Marketplace 包和规划命令不构成安全承诺；
- 当前源码标签、配置、兼容矩阵和测试证据必须作为一个版本单元使用。

## 如何报告漏洞

请不要在公开 Issue、讨论区或 Pull Request 中发布可利用细节、真实 API Key、Cookie、Authorization Header、私有代码或完整生产日志。

首选方式是本仓库的 GitHub Security Advisories 私密报告入口（Security → Advisories → Report a vulnerability）。如果入口暂时不可用，请先通过 GitHub 联系维护者 [`@HazenSun`](https://github.com/HazenSun)，只请求建立私密渠道，不要在公开消息中附带漏洞细节。

报告至少包含：

- 受影响的 Bridge、DSH、Node、OS 和 Plugin 版本；
- 运行模式（Direct / Native Shell）和 Profile；
- 漏洞影响范围与攻击前提；
- 最小复现步骤或脱敏 PoC；
- 是否已经暴露密钥、代码、Artifact 或用户数据；
- 临时缓解措施（如果已知）。

如果问题可能导致 Provider credential、源码、Cookie、Worktree 或主工作区暴露，请在标题中标记 `URGENT`，但仍不要把秘密本身放进报告。

## 报告处理原则

维护者会：

1. 确认收到并建立内部追踪记录；
2. 复现问题，判断影响范围和受影响版本；
3. 评估是否需要临时关闭某个 Profile、工具或发布包；
4. 与报告者协商修复、测试和披露时间；
5. 发布修复版本、迁移说明和必要的安全公告。

具体响应时间取决于维护能力和漏洞严重度；在项目尚未公开运营前，不承诺固定 SLA。

## 安全边界

项目的目标安全基线包括：

- 默认 isolated Worktree，不直接写主工作区；
- Provider credential 只留在 DSH，不进入 Codex、MCP、Artifact 或日志；
- Allowed Root、符号链接、Worktree、任务超时、Artifact 大小和 Delegation 证据由代码执行；
- DSH Sub-Agent 的 Bridge 深度在创建前校验，数量和完成情况在 Run 后验收，128 次协议上限失败关闭；
- 任务可取消，Bridge 崩溃后保守标记为 `interrupted`；
- Artifact 带大小、Hash 和分页读取约束；
- 输出与模型摘要均被视为不可信输入。

请以对应版本的测试、[Compatibility Matrix](docs/compatibility.md) 和 Release Notes 判断具体能力；没有证据的 Provider、OS 或模型组合不自动视为受支持。

当前 Alpha 尚未把 `network`、`allowed_domains`、`denied_paths`、`max_files` 和 `disk_quota_bytes` 全部映射为 Bridge 侧执行器。配置声明不等于操作系统级隔离证明；高敏感场景应增加独立容器、网络和文件系统边界。

## 维护者与贡献者

贡献代码时请遵守 [CONTRIBUTING.md](CONTRIBUTING.md)：不要提交 `.env`、Provider credential、测试用真实 Token、私有日志或用户项目快照；安全修复应包含回归测试、威胁边界和升级说明。

## 依赖与供应链

正式 Release 的目标是提供依赖许可证清单、SBOM、可验证构建来源和同步版本的 Codex Plugin/DSH Plugin。发现依赖漏洞时，请说明可利用路径和受影响版本，不要只复制未经验证的扫描器输出。
