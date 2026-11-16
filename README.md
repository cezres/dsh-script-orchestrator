# dsh-script-orchestrator

DeepSeek Harness（DSH）的脚本编排插件：定时执行脚本，根据执行结果发送事件、调用已注册动作，或创建 AI 会话继续处理。

## 功能

一条编排由四部分组成：**触发 → 脚本 → 判定 → 动作**。

| 环节 | 支持能力 |
| --- | --- |
| 触发 | 固定间隔 `every`（`fixed-rate` / `fixed-delay`）、cron 子集，以及手动执行 |
| 脚本 | 子进程执行、超时控制、输出截断；同一编排的执行不重叠 |
| 判定 | 根据退出码、标准输出（stdout）、标准错误（stderr）等匹配规则，选择要执行的动作 |
| 动作 | `event`：发送 Cordis 事件；`plugin`：调用已注册的具名动作；`session`：新建 AI 会话并投递首条消息 |

Web 侧边栏提供管理面板，用于查看编排、管理运行状态和查看执行记录。模型可通过以下工具操作：

- **创建与修改**：`script_create`、`script_edit`。
- **查询与执行**：`script_list`、`script_view`、`script_run`。
- **结果上报**：编排创建的会话可通过 `script_report` 将处理结果写回执行记录。

本插件不提供 webhook 出站或编排间串联，也不替代 `@deepseek-ai/dsh-schedule`：后者用于定时投递 prompt，本插件用于根据脚本执行结果触发后续动作。

## 环境要求

- **DSH `0.2.2-rc.3`**：当前包精确要求此宿主版本。

包名为 `@echo/dsh-script-orchestrator`，不发布到 npm。

## 安装与更新

在 DSH 的插件管理器中添加插件，安装来源填写以下 GitHub 仓库地址：

```text
https://github.com/cezres/dsh-script-orchestrator.git#path:/pkg
```

`#path:/pkg` 指定仓库中的 [插件包目录](<pkg/>)，安装时请保留此后缀，无需手动克隆仓库。

更新时，在 DSH 插件管理器中移除 `@echo/dsh-script-orchestrator`，再使用上述地址重新安装，并按 DSH 提示重启以加载更新。

## 安全边界

- **脚本以插件进程的权限运行，没有脚本沙箱。** 只运行可信脚本，并在启用定时执行前检查命令、参数和后续动作。
- `allowedRoots` 用于限制脚本与会话的工作目录（cwd）；默认为空，不限制路径根。
- 工作目录限制不等于文件系统隔离，不能阻止脚本访问其进程权限允许访问的其他资源。
