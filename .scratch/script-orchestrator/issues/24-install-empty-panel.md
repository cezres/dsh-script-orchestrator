# 24: 安装插件并查看空编排列表

**What to build:** 用户在隔离 profile 安装插件后，能打开 Web 面板并看到由 Host 权威数据驱动的空编排列表，而不是只有静态界面或插件骨架。

**Blocked by:** None (can start immediately)

**Status:** claimed

- [ ] 单包 Host/client 声明、同步 Config、依赖边界和自插入条目可用，`--dump-config` 能看到插件条目，侧边栏与主面板能挂载。
- [ ] Host 管理服务与 Connection 桥提供空 `list` 闭环，返回 `{ items: [], total: 0, nextOffset: null }`，面板覆盖空态、加载态和传输错误态。
- [ ] 存储域以既定 per-record 布局打开并关闭，内部服务层 FIFO 可入队、排干且单槽失败不毒化后续操作。
- [ ] Config 默认值和非法配置诊断有测试，非法配置不能留下半初始化服务或游离异步任务。
- [ ] 冷重启后面板通过权威回读恢复空列表；卸载插件后面板与 Loader 条目无残留。
- [ ] 在隔离环境完成安装、启停、面板渲染和存储生命周期的自动化验证，不修改真实用户 profile。
