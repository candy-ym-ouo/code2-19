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

统一的暂存 / 转运容量台账，容量按岛按仓区独立记账，承诺即占位：

- **统一容量**：每个投递岛的暂存区与转运区各有容量上限（默认 30kg），`POST /api/warehouse/reservations` 成功即预占；超容返回 `409 CAPACITY_EXCEEDED` 且不产生任何残留记录。
- **入库失败回滚占位**：占位经 `.../:id/commit` 入库；入库失败必须调 `.../:id/rollback` 显式释放并填写原因。占位不允许静默消失，撤单走 `.../:id/expire`，两条路径都写审计日志。
- **盘点快照屏障**：`POST /api/warehouse/snapshots/open` 后禁止一切新占位（返回 `409 SNAPSHOT_FROZEN`），旧占位仍可提交 / 回滚；`snapshots/close` 输出屏障前后的逐项对账（含异常混入的承诺 ID）。
- **旧占位保护**：容量只允许扩容（`POST /api/warehouse/capacity`），缩容返回 `CAPACITY_SHRINK_FORBIDDEN`，防止旧承诺被静默作废。
- **并发控制**：所有写操作接受 `expectedRevision`，过期请求返回 `409 REVISION_CONFLICT`。

领域逻辑在 `server/warehouse.js`（纯函数、可单测），存档校验与旧档迁移在 `server/store.js`。
