# 08 · 存储

## 域

| 项 | 值 |
|---|---|
| 域名称 | `script-orchestrator` |
| 版本 | `1` |
| 布局 | `single`（整个域一个单元；JSON 后端为 `<DSH_HOME>/storages/script-orchestrator.json`） |
| 表 | `orchestrations`、`runs` |
| 全局 | 无（`global: null`） |

打开方式：`ctx.storageDomain.open(defineDomain({...}))`，关闭由插件自身 `ctx.effect` 负责。

## 信封

```jsonc
{
  "unit": { "name": "script-orchestrator", "version": 1 },
  "global": null,
  "tables": {
    "orchestrations": {
      "nightly-deploy-check": { /* 编排记录，键 = record.id */ }
    },
    "runs": {
      "run-7f3c1a9e": { /* 执行记录，键 = record.runId */ }
    }
  }
}
```

### 编排记录

`01-domain-model` 的全部字段 + `status`、`createdAt`、`updatedAt`、`nextOccurrence`。`enabled` 与 `status` 的一致性由写入层保证：`enabled: false` 等价于 `paused`。

### 执行记录

`run` 全部字段。`run.actions[].error` 只存 `{ code, message }`，不存堆栈；`stdoutTail` / `stderrTail` 已在入表前截到 2048 字符。

## 保留与裁剪

| 规则 | 值 |
|---|---|
| 每条编排保留最近 run | `maxRunsPerOrchestration`（默认 100） |
| 全库 run 上限 | `1000`（超出按 `settledAt` 淘汰最旧） |
| 裁剪时机 | 追加新 run 时顺带裁剪，不单独定期清理 |
| 删除编排 | 同时删除其全部 run（同一批写入） |

## 读写路径

- **启动**：一次性 `loadAll`，逐条按 schema 校验；校验失败的记录按 `invalidRecords: 'backup-and-skip'` 处理（备份后跳过，并记录诊断），不让单条坏数据阻断整个域。
- **查询**：全部在内存完成（列表、过滤、分页），不触达后端。
- **写入**：所有变更进单一 FIFO 队列；`create`/`edit`/`delete` 与 run 的「开始」「结算」两次写入都经过它，保证写序与内存视图一致。
- **运行期**：run 只写两次（开始、结算），中途状态（`running`/`judging`/`dispatching`）为内存态，不落盘——崩溃后统一判为 `interrupted`。

## 升级策略

- 增加可选字段：不升版本，解码器给默认值。
- 改变字段语义或必填性：升 `version`，在 `compatibleVersions` 里保留旧版本号，并在读取时把旧记录归一化为新形状后落库。
- 不提供跨大版本的自动迁移脚本：无法解码的旧单元拒绝打开并报 `storage_unavailable`，由维护者决定是备份重建还是写迁移。
