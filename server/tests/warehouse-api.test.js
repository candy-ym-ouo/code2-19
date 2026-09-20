import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app.js';
import { GameStore } from '../store.js';

async function startServer(context) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-post-warehouse-'));
  const store = new GameStore(path.join(temporaryDirectory, 'state.json'), { seed: 'warehouse-api' });
  store.load();
  const server = createApp({ store, clientDist: null }).listen(0);
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
    return { status: response.status, body: await response.json() };
  };
  return { request, dataFile: path.join(temporaryDirectory, 'state.json') };
}

test('中转仓完成占位、提交、回滚闭环并持久化', async (context) => {
  const { request, dataFile } = await startServer(context);

  const viewResponse = await request('/api/warehouse');
  assert.equal(viewResponse.status, 200);
  assert.equal(viewResponse.body.warehouse.capacities.staging, 30);
  assert.equal(viewResponse.body.warehouse.frozen, false);

  const reserved = await request('/api/warehouse/reservations', {
    method: 'POST',
    body: JSON.stringify({ islandId: 'sun', zone: 'staging', weight: 12, reference: 'L01-01' })
  });
  assert.equal(reserved.status, 200);
  const holdId = reserved.body.reservation.id;
  assert.equal(reserved.body.reservation.status, 'held');
  assert.equal(reserved.body.warehouse.islands.sun.staging.used, 12);

  // 容量不足被拒绝，且没有残留占用
  const overflow = await request('/api/warehouse/reservations', {
    method: 'POST',
    body: JSON.stringify({ islandId: 'sun', zone: 'staging', weight: 25 })
  });
  assert.equal(overflow.status, 409);
  assert.equal(overflow.body.code, 'CAPACITY_EXCEEDED');
  const afterOverflow = await request('/api/warehouse');
  assert.equal(afterOverflow.body.warehouse.islands.sun.staging.used, 12);

  const committed = await request(`/api/warehouse/reservations/${holdId}/commit`, {
    method: 'POST',
    body: JSON.stringify({ islandId: 'sun' })
  });
  assert.equal(committed.status, 200);
  assert.equal(committed.body.reservation.status, 'committed');

  // 另一个占位走回滚路径，容量释放
  const second = await request('/api/warehouse/reservations', {
    method: 'POST',
    body: JSON.stringify({ islandId: 'gale', zone: 'transit', weight: 9 })
  });
  const secondId = second.body.reservation.id;
  const rolledBack = await request(`/api/warehouse/reservations/${secondId}/rollback`, {
    method: 'POST',
    body: JSON.stringify({ reason: '风暴封港' })
  });
  assert.equal(rolledBack.status, 200);
  assert.equal(rolledBack.body.reservation.status, 'released');
  assert.equal(rolledBack.body.reservation.releaseReason, '风暴封港');
  assert.equal(rolledBack.body.warehouse.islands.gale.transit.used, 0);

  // 重复回滚被明确拒绝，旧承诺不会静默消失
  const again = await request(`/api/warehouse/reservations/${secondId}/rollback`, {
    method: 'POST',
    body: '{}'
  });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'RESERVATION_NOT_HELD');

  // 落盘后重新打开存档，台账完整
  const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(persisted.warehouse.reservations[holdId].status, 'committed');
  assert.equal(persisted.warehouse.reservations[secondId].status, 'released');
});

test('盘点快照期间拒绝新承诺，关闭时输出对账结果', async (context) => {
  const { request } = await startServer(context);

  const keep = await request('/api/warehouse/reservations', {
    method: 'POST',
    body: JSON.stringify({ islandId: 'mist', zone: 'staging', weight: 5, reference: 'keep' })
  });
  const abandon = await request('/api/warehouse/reservations', {
    method: 'POST',
    body: JSON.stringify({ islandId: 'forge', zone: 'transit', weight: 4, reference: 'abandon' })
  });

  const opened = await request('/api/warehouse/snapshots/open', {
    method: 'POST',
    body: JSON.stringify({ note: '月末盘点' })
  });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.snapshot.heldAtBarrier.length, 2);

  const blocked = await request('/api/warehouse/reservations', {
    method: 'POST',
    body: JSON.stringify({ islandId: 'sun', zone: 'staging', weight: 1 })
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'SNAPSHOT_FROZEN');

  // 盘点期间旧承诺仍可履约/回滚
  await request(`/api/warehouse/reservations/${abandon.body.reservation.id}/rollback`, {
    method: 'POST',
    body: JSON.stringify({ reason: '发件人取消' })
  });

  const closed = await request('/api/warehouse/snapshots/close', {
    method: 'POST',
    body: '{}'
  });
  assert.equal(closed.status, 200);
  const statuses = Object.fromEntries(closed.body.snapshot.reconciled.map((item) => [item.reservationId, item.statusAtClose]));
  assert.equal(statuses[keep.body.reservation.id], 'held');
  assert.equal(statuses[abandon.body.reservation.id], 'released');
  assert.deepEqual(closed.body.snapshot.intrudedReservationIds, []);

  // 关闭后恢复接收新承诺
  const resumed = await request('/api/warehouse/reservations', {
    method: 'POST',
    body: JSON.stringify({ islandId: 'sun', zone: 'staging', weight: 1 })
  });
  assert.equal(resumed.status, 200);
});

test('乐观并发：过期 expectedRevision 的占位请求返回 409', async (context) => {
  const { request } = await startServer(context);
  const first = await request('/api/warehouse/reservations', {
    method: 'POST',
    body: JSON.stringify({ islandId: 'sun', zone: 'staging', weight: 5, expectedRevision: 0 })
  });
  assert.equal(first.status, 200);
  const stale = await request('/api/warehouse/reservations', {
    method: 'POST',
    body: JSON.stringify({ islandId: 'sun', zone: 'staging', weight: 5, expectedRevision: 0 })
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'REVISION_CONFLICT');
});

test('损坏的中转仓台账会触发存档备份恢复', async (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-post-warehouse-corrupt-'));
  context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const dataFile = path.join(temporaryDirectory, 'state.json');
  const store = new GameStore(dataFile, { seed: 'corrupt-warehouse' });
  const state = store.load();
  state.warehouse.capacities = null;
  fs.writeFileSync(dataFile, JSON.stringify(state), 'utf8');

  const recovered = new GameStore(dataFile, { seed: 'recovered' }).load();
  assert.equal(recovered.phase, 'planning');
  assert.ok(recovered.warehouse);
  assert.equal(recovered.warehouse.capacities.staging, 30);
});
