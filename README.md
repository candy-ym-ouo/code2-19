# 浮空岛邮政调度员

React 调度面板 + Node.js 权威游戏服务。完整的玩法、规则、接口、运行和验收说明见 [项目文档.md](./项目文档.md)。

```bash
npm install
npm run dev
```

开发模式访问 `http://localhost:5173`，生产模式执行：

```bash
npm run build
npm start
```

然后访问 `http://localhost:3001`。

## 岛屿中转仓

中转仓为调度体系提供统一的暂存与转运容量池（默认 30 kg / 10 位），独立存档于 `server/data/warehouse-state.json`（可用 `WAREHOUSE_DATA_FILE` 覆盖）。

容量与占位规则：

- **统一容量池**：到港暂存（staged）、在架（committed）、转运中（transferring）三类占位都占用同一份承重与暂存位；容量不足时入库请求直接失败，不会写入半条占位。
- **入库失败回滚占位**：暂存或在架货物验收失败时占位标记为 `rolled_back` 并立即归还容量，记录与原因保留在审计流中，不删除、不静默丢失；转运失败则货物回仓（恢复 committed），容量全程不释放。
- **盘点快照冻结**：`/api/warehouse/snapshot/start` 后仓库进入 `auditing`，所有暂存/入库/转运/释放操作返回 409；`snapshot/finalize` 核对基线占位与占用漂移，异常写入快照 `anomalies`。
- **旧占位不静默失效**：staged/transferring 占位有保留时限（默认 15 分钟），只有显式清扫（GET 仓状态时自动执行）才会标记 `expired` 并审计；盘点冻结期间到期会顺延，解冻后补扫并在快照中登记。

接口（除 GET 外均需携带整数 `expectedRevision` 乐观锁）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/warehouse` | 仓位状态（含 occupancy/available、审计流），读取时顺带清扫超时占位 |
| POST | `/api/warehouse/inbound/stage` | 到港暂存占位 |
| POST | `/api/warehouse/inbound/commit` | 验收入库（staged → committed） |
| POST | `/api/warehouse/inbound/reject` | 入库失败回滚占位 |
| POST | `/api/warehouse/holds/release` | 主动释放占位 |
| POST | `/api/warehouse/transfer/reserve` | 申请转运（committed → transferring） |
| POST | `/api/warehouse/transfer/complete` | 确认送达离场，归还容量 |
| POST | `/api/warehouse/transfer/fail` | 转运失败，货物回仓 |
| POST | `/api/warehouse/snapshot/start` | 开始盘点快照并冻结 |
| POST | `/api/warehouse/snapshot/finalize` | 核对完成并解冻 |

