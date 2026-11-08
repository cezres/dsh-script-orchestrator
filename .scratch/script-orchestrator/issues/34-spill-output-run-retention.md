# 34: 查看完整输出并自动裁剪 run 历史

**What to build:** 用户既能看到 run 的输出尾部，也能在溢写成立时读取完整 stdout/stderr；系统按保留规则自动裁剪历史并清理对应溢写文件。

**Blocked by:** 29 — 取消在途 run 并安全删除编排

**Status:** ready-for-agent

- [ ] stdout/stderr 分别实现内存尾部与 spill 双层收集，`maxSpillBytes` 默认 8 MiB/流、0 禁用，超 cap 撤回对应 spillPath 且不影响内存尾部。
- [ ] 输出按 UTF-8 处理，tail 保留解码后末 2048 code point 和 U+FFFD；`truncated = lossy` 不受 spill 是否存在影响，run 字段与事件载荷保持契约形状。
- [ ] 面板可读取每流完整 spill，文件不存在时显示明确排障态；事件中的 tail 仍遵守 64 KiB 兜底，不广播完整输出。
- [ ] 每编排与全库保留上限均在 run 结算后的同一服务槽位执行，按 `settledAt`/`runId` 定序，未结算 run 永不淘汰，暂时超限可由后续结算收敛。
- [ ] 裁剪与级联删除时 best-effort 清理对应 spill，不做启动扫描；删除记录与文件清理失败均有可诊断行为。
- [ ] Windows 实测复现 W2 的完整 spill 可读和超 cap 撤回，并覆盖 UTF-8 截断、保留定序、未结算保护、级联清理与面板读取。
