import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app.js';
import { GameStore } from '../store.js';
import { WarehouseStore } from '../warehouse-store.js';

async function withServer(context, warehouseOptions = {}) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-post-warehouse-api-'));
  const gameStore = new GameStore(path.join(temporaryDirectory, 'game.json'), { seed: 'warehouse-api' });
  const warehouseStore = new WarehouseStore(path.join(temporaryDirectory, 'warehouse.json'), warehouseOptions);
  gameStore.load();
  warehouseStore.load();
  const server = createApp({ store: gameStore, warehouseStore, clientDist: null }).listen(0);
  context.after(() => {
    server.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.once('listening', resolve));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, options = {}) => {
    const response = await fetch(`${baseUrl}${url}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    return { status: response.status, body: await response.json().catch(() => ({})), headers: response.headers };
  };
  return { request, warehouseStore, temporaryDirectory };
}

test('中转仓 API 完成暂存、入库、转运、离场闭环并归还容量', async (context) => {
  const { request } = await withServer(context);

  const initial = await request('/api/warehouse');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.state.revision, 0);
  assert.deepEqual(initial.body.state.occupancy, { weightKg: 0, slots: 0 });

  const stage = await request('/api/warehouse/inbound/stage', {
    method: 'POST',
    body: JSON.stringify({ letterId: 'L01-01', sourceIslandId: 'sun', weightKg: 12, expectedRevision: 0 })
  });
  assert.equal(stage.status, 201);
  assert.equal(stage.body.hold.status, 'staged');
  assert.deepEqual(stage.body.state.occupancy, { weightKg: 12, slots: 1 });
  const rev1 = stage.body.state.revision;

  // 容量不足的入库被拒绝，且状态不变（回滚占位语义在 API 层生效）
  const overfull = await request('/api/warehouse/inbound/stage', {
    method: 'POST',
    body: JSON.stringify({ letterId: 'L01-02', sourceIslandId: 'gale', weightKg: 25, expectedRevision: rev1 })
  });
  assert.equal(overfull.status, 400);
  assert.equal(overfull.body.error, '中转仓承重不足：当前 12 kg，新增 25 kg 后超过 30 kg 上限。');
  assert.equal(overfull.body.state, undefined);

  const commit = await request('/api/warehouse/inbound/commit', {
    method: 'POST',
    body: JSON.stringify({ holdId: stage.body.hold.id, expectedRevision: rev1 })
  });
  assert.equal(commit.status, 200);
  assert.equal(commit.body.hold.status, 'committed');

  const reserve = await request('/api/warehouse/transfer/reserve', {
    method: 'POST',
    body: JSON.stringify({ holdId: stage.body.hold.id, destinationIslandId: 'mist', expectedRevision: commit.body.state.revision })
  });
  assert.equal(reserve.status, 200);
  assert.equal(reserve.body.hold.status, 'transferring');
  // 转运中仍占容量
  assert.deepEqual(reserve.body.state.occupancy, { weightKg: 12, slots: 1 });

  const complete = await request('/api/warehouse/transfer/complete', {
    method: 'POST',
    body: JSON.stringify({ holdId: stage.body.hold.id, expectedRevision: reserve.body.state.revision })
  });
  assert.equal(complete.status, 200);
  assert.equal(complete.body.hold.status, 'transferred');
  assert.deepEqual(complete.body.state.occupancy, { weightKg: 0, slots: 0 });
});

test('入库失败通过 reject 回滚占位，记录保留且容量归还', async (context) => {
  const { request } = await withServer(context);

  const stage = await request('/api/warehouse/inbound/stage', {
    method: 'POST',
    body: JSON.stringify({ letterId: 'L01-03', sourceIslandId: 'forge', weightKg: 9, expectedRevision: 0 })
  });
  const reject = await request('/api/warehouse/inbound/reject', {
    method: 'POST',
    body: JSON.stringify({ holdId: stage.body.hold.id, reason: '包装破损', expectedRevision: stage.body.state.revision })
  });
  assert.equal(reject.status, 200);
  assert.equal(reject.body.hold.status, 'rolled_back');
  assert.equal(reject.body.freedWeightKg, 9);
  assert.deepEqual(reject.body.state.occupancy, { weightKg: 0, slots: 0 });

  const fetched = await request('/api/warehouse');
  const hold = fetched.body.state.holds.find((item) => item.id === stage.body.hold.id);
  assert.equal(hold.status, 'rolled_back');
  assert.equal(hold.reason, '包装破损');
  assert.ok(fetched.body.state.audit.some((entry) => entry.action === 'rollback-inbound'));
});

test('盘点期间所有变更请求返回 409，完成盘点后恢复', async (context) => {
  const { request } = await withServer(context);

  const stage = await request('/api/warehouse/inbound/stage', {
    method: 'POST',
    body: JSON.stringify({ letterId: 'L01-04', sourceIslandId: 'sun', weightKg: 4, expectedRevision: 0 })
  });
  const rev = stage.body.state.revision;

  const snapshotStart = await request('/api/warehouse/snapshot/start', {
    method: 'POST',
    body: JSON.stringify({ expectedRevision: rev })
  });
  assert.equal(snapshotStart.status, 201);
  assert.equal(snapshotStart.body.state.phase, 'auditing');
  const auditRev = snapshotStart.body.state.revision;

  const frozenStage = await request('/api/warehouse/inbound/stage', {
    method: 'POST',
    body: JSON.stringify({ letterId: 'L01-05', sourceIslandId: 'sun', weightKg: 1, expectedRevision: auditRev })
  });
  assert.equal(frozenStage.status, 409);
  assert.match(frozenStage.body.error, /盘点快照进行中/);

  const frozenTransfer = await request('/api/warehouse/transfer/reserve', {
    method: 'POST',
    body: JSON.stringify({ holdId: stage.body.hold.id, destinationIslandId: 'gale', expectedRevision: auditRev })
  });
  assert.equal(frozenTransfer.status, 409);

  const finalize = await request('/api/warehouse/snapshot/finalize', {
    method: 'POST',
    body: JSON.stringify({ snapshotId: snapshotStart.body.snapshot.id, expectedRevision: auditRev })
  });
  assert.equal(finalize.status, 200);
  assert.equal(finalize.body.snapshot.status, 'finalized');
  assert.deepEqual(finalize.body.snapshot.anomalies, []);
  assert.equal(finalize.body.state.phase, 'open');

  const after = await request('/api/warehouse/inbound/stage', {
    method: 'POST',
    body: JSON.stringify({ letterId: 'L01-05', sourceIslandId: 'sun', weightKg: 1, expectedRevision: finalize.body.state.revision })
  });
  assert.equal(after.status, 201);
});

test('expectedRevision 不匹配时拒绝变更（乐观并发）', async (context) => {
  const { request } = await withServer(context);

  await request('/api/warehouse/inbound/stage', {
    method: 'POST',
    body: JSON.stringify({ letterId: 'L01-06', sourceIslandId: 'sun', weightKg: 1, expectedRevision: 0 })
  });
  const stale = await request('/api/warehouse/inbound/stage', {
    method: 'POST',
    body: JSON.stringify({ letterId: 'L01-07', sourceIslandId: 'sun', weightKg: 1, expectedRevision: 0 })
  });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /已在其他请求中更新/);
});

test('缺少 expectedRevision 返回 400', async (context) => {
  const { request } = await withServer(context);
  const response = await request('/api/warehouse/inbound/stage', {
    method: 'POST',
    body: JSON.stringify({ letterId: 'X', sourceIslandId: 'sun', weightKg: 1 })
  });
  assert.equal(response.status, 400);
});

test('中转仓存档可由新 Store 实例恢复', async (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-post-warehouse-persist-'));
  const dataFile = path.join(temporaryDirectory, 'warehouse.json');
  const store = new WarehouseStore(dataFile, { seed: 'persist' });
  store.load();
  store.mutate((state) => {
    // 直接注入一个已提交占位
    state.holds.push({
      id: 'H-001',
      letterId: 'KEEP-1',
      kind: 'staging',
      sourceIslandId: 'sun',
      destinationIslandId: null,
      weightKg: 3.5,
      status: 'committed',
      createdAt: new Date().toISOString(),
      expiresAt: null,
      committedAt: new Date().toISOString(),
      releasedAt: null,
      reason: null
    });
    state.holdSeq = 1;
  });

  const reloaded = new WarehouseStore(dataFile).load();
  assert.equal(reloaded.holds.length, 1);
  assert.equal(reloaded.holds[0].letterId, 'KEEP-1');
  assert.equal(reloaded.holds[0].status, 'committed');
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('损坏的中转仓存档会备份并重建为空仓', async (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-post-warehouse-corrupt-'));
  const dataFile = path.join(temporaryDirectory, 'warehouse.json');
  fs.writeFileSync(dataFile, JSON.stringify({ phase: 'open', holds: '不是数组' }), 'utf8');

  const store = new WarehouseStore(dataFile);
  const recovered = store.load();
  const backups = fs.readdirSync(temporaryDirectory).filter((name) => name.includes('.corrupt-'));

  assert.equal(recovered.phase, 'open');
  assert.deepEqual(recovered.holds, []);
  assert.ok(recovered.recovery);
  assert.equal(backups.length, 1);
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});
