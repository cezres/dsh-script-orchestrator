# dsh-script-orchestrator

DeepSeek Harness（DSH）插件：按时间跑一段脚本，按退出结果判定，再分发到事件、已注册动作或新的 AI 会话。

包名 `@echo/dsh-script-orchestrator`，版本 `0.1.0`。`private: true`，用 `file:` 装进本机 profile，不上 npm。宿主精确锁 `engines.dsh = 0.2.2-rc.3`。

## 做什么

一条编排 = 触发 + 脚本 + 判定 + 动作。

1. **触发**：`every`（fixed-rate / fixed-delay）或 cron 子集；也可以手动跑一次。
2. **脚本**：子进程执行，带超时、输出截断和单飞（同一编排不重叠执行）。
3. **判定**：按退出码、stdout / stderr 等选出动作键。
4. **动作**：`event`（Cordis 事件）、`plugin`（已注册具名动作）、`session`（新建会话并投下首条消息）。

Web 侧边栏有管理面板。模型侧工具：`script_create`、`script_edit`、`script_list`、`script_view`、`script_run`。

不做：webhook 出站、编排之间串联、脚本沙箱。不替代 `@deepseek-ai/dsh-schedule`（那是按时投递 prompt；本插件是脚本驱动的编排）。

## 仓库布局

| 路径 | 内容 |
|---|---|
| `pkg/` | 插件包。`lib/` 与 `skills/` 即交付物，零构建 |
| `pkg/lib/index.js` | Host 入口 |
| `pkg/lib/client.js` | Web client |
| `docs/temp/` | v0.1 契约。实现以契约为准 |
| `docs/agents/` | 议题、分诊、领域文档的 agent 说明 |
| `scripts/install-script-orchestrator.ps1` | 安装或更新到本机 DSH profile |

## 要求

- DSH `0.2.2-rc.3`
- 安装脚本需要 PowerShell 7（`#Requires -Version 7.0`）

## 安装

DSH 未运行时：

```powershell
pwsh -NoProfile -File .\scripts\install-script-orchestrator.ps1
```

只看将执行的操作、不写文件：

```powershell
pwsh -NoProfile -File .\scripts\install-script-orchestrator.ps1 -DryRun
```

DSH 正在运行时，脚本不会改 profile。在插件管理器里对该 bundle 执行 remove → install，或完全退出 DSH 后再跑脚本。可选参数：`-Profile`（默认 `desktop`）、`-DshHome`（默认 `~/.dsh`）、`-AssumeStopped`。

脚本默认以插件进程权限运行，没有沙箱。`allowedRoots` 为空时不限制路径根。

## 测试

```powershell
pnpm --dir pkg test
```

## 契约

对外行为以 [`docs/temp/README.md`](docs/temp/README.md) 为索引。改契约先走 `docs/temp/10-decisions.md` 的记录流程，再改实现。

## 许可

尚未选择开源许可证。在补上 `LICENSE` 之前，保留所有权利。
