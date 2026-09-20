import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../engine.js';
import {
  DEFAULT_WAREHOUSE_CAPACITY,
  WarehouseRuleError,
  reserveStaging,
  commitInbound,
  rollbackReservation,
  expireReservation,
  openSnapshot,
  closeSnapshot,
  warehouseView,
  getReservation,
  increaseCapacity,
  islandWarehouseView
} from '../warehouse.js';

function freshState() {
  return createInitialState({ seed: 'warehouse-test' });
}

function reserve(state, overrides = {}) {
  return reserveStaging(state, {
    islandId: 'sun',
    zone: 'staging',
    weight: 10,
    reference: 'L01-01',
    ...overrides
  });
}

test('占位会占用统一暂存/转运容量，两个仓区互不串用', () => {
  const state = freshState();
  reserve(state, { islandId: 'sun', zone: 'staging', weight: 10 });
  const second = reserve(state, { islandId: 'sun', zone: 'transit', weight: 12 });

  const sun = islandWarehouseView(state.warehouse, 'sun');
  assert.equal(sun.staging.used, 10);
  assert.equal(sun.transit.used, 12);
  assert.equal(sun.staging.free, DEFAULT_WAREHOUSE_CAPACITY - 10);
  assert.equal(second.reservation.status, 'held');
});

test('容量不足时拒绝占位，且不会留下任何记录或占用', () => {
  const state = freshState();
  reserve(state, { weight: 25 });
  const revisionBefore = state.warehouse.revision;
  const reservationCount = Object.keys(state.warehouse.reservations).length;

  assert.throws(
    () => reserve(state, { weight: 10 }),
    (error) => error instanceof WarehouseRuleError && error.code === 'CAPACITY_EXCEEDED'
  );

  const sun = islandWarehouseView(state.warehouse, 'sun');
  assert.equal(sun.staging.used, 25);
  assert.equal(state.warehouse.revision, revisionBefore);
  assert.equal(Object.keys(state.warehouse.reservations).length, reservationCount);
});

test('入库失败显式回滚占位并释放容量，回滚全程留痕', () => {
  const state = freshState();
  const { reservation } = reserve(state, { weight: 8 });
  const result = rollbackReservation(state, reservation.id, { reason: '舱门故障' });

  assert.equal(result.reservation.status, 'released');
  assert.equal(result.reservation.releaseReason, '舱门故障');
  assert.ok(result.reservation.releasedAt);
  const sun = islandWarehouseView(state.warehouse, 'sun');
  assert.equal(sun.staging.used, 0);
  assert.equal(sun.staging.free, DEFAULT_WAREHOUSE_CAPACITY);
  assert.ok(state.warehouse.audit.some((entry) => entry.type === 'released' && entry.reservationId === reservation.id));
});

test('入库成功提交占位，提交后不可重复入库或回滚', () => {
  const state = freshState();
  const { reservation } = reserve(state, { weight: 6 });
  const committed = commitInbound(state, reservation.id, { islandId: 'sun' });
  assert.equal(committed.reservation.status, 'committed');
  assert.ok(committed.reservation.committedAt);

  assert.throws(
    () => commitInbound(state, reservation.id, { islandId: 'sun' }),
    (error) => error.code === 'RESERVATION_NOT_HELD'
  );
  assert.throws(
    () => rollbackReservation(state, reservation.id),
    (error) => error.code === 'RESERVATION_NOT_HELD'
  );
});

test('入库重量与占位不一致时整体失败，占位仍然有效', () => {
  const state = freshState();
  const { reservation } = reserve(state, { weight: 6 });
  assert.throws(
    () => commitInbound(state, reservation.id, { islandId: 'sun', weight: 5 }),
    (error) => error.code === 'WEIGHT_MISMATCH'
  );
  const stillHeld = getReservation(state, reservation.id);
  assert.equal(stillHeld.status, 'held');
});

test('盘点快照期间禁止混入新承诺', () => {
  const state = freshState();
  reserve(state, { weight: 5 });
  openSnapshot(state, { note: '月末盘点' });

  assert.throws(
    () => reserve(state, { weight: 1 }),
    (error) => error.code === 'SNAPSHOT_FROZEN'
  );
  assert.equal(warehouseView(state.warehouse).frozen, true);
  assert.equal(Object.values(state.warehouse.reservations).filter((hold) => hold.status === 'held').length, 1);
});

test('盘点期间旧占位的提交与回滚仍被允许，并在关闭快照时逐项对账', () => {
  const state = freshState();
  const committed = reserve(state, { islandId: 'sun', weight: 4, reference: 'commit-me' }).reservation;
  const released = reserve(state, { islandId: 'gale', zone: 'transit', weight: 3, reference: 'rollback-me' }).reservation;
  const untouched = reserve(state, { islandId: 'mist', weight: 2, reference: 'keep-me' }).reservation;

  const snapshot = openSnapshot(state).snapshot;
  assert.equal(snapshot.heldAtBarrier.length, 3);

  commitInbound(state, committed.id, { islandId: 'sun' });
  rollbackReservation(state, released.id, { reason: '收件岛拒收' });

  const closed = closeSnapshot(state).snapshot;
  const byId = new Map(closed.reconciled.map((item) => [item.reservationId, item]));
  assert.equal(byId.get(committed.id).statusAtClose, 'committed');
  assert.equal(byId.get(released.id).statusAtClose, 'released');
  assert.equal(byId.get(released.id).releasedReason, '收件岛拒收');
  assert.equal(byId.get(untouched.id).statusAtClose, 'held');
  assert.deepEqual(closed.intrudedReservationIds, []);
  assert.equal(warehouseView(state.warehouse).frozen, false);

  // 快照关闭后新承诺恢复
  const after = reserve(state, { weight: 5 });
  assert.equal(after.reservation.status, 'held');
});

test('旧占位不会静默失效：只能通过显式回滚或作废离场且都有审计', () => {
  const state = freshState();
  const { reservation } = reserve(state, { weight: 7 });
  expireReservation(state, reservation.id, { reason: '寄件人撤单' });
  const expired = getReservation(state, reservation.id);

  assert.equal(expired.status, 'expired');
  assert.equal(expired.releaseReason, '寄件人撤单');
  assert.ok(expired.expiredAt);
  assert.ok(state.warehouse.audit.some((entry) => entry.type === 'expired' && entry.reservationId === reservation.id));
  const sun = islandWarehouseView(state.warehouse, 'sun');
  assert.equal(sun.staging.used, 0);
});

test('容量只能扩容，缩容请求被拒绝以防旧承诺失效', () => {
  const state = freshState();
  reserve(state, { weight: 20 });
  assert.throws(
    () => increaseCapacity(state, 'staging', 10),
    (error) => error.code === 'CAPACITY_SHRINK_FORBIDDEN'
  );
  const upgraded = increaseCapacity(state, 'staging', 40);
  assert.equal(upgraded.warehouse.capacities.staging, 40);
});

test('expectedRevision 提供乐观并发控制，过期请求不会覆盖新状态', () => {
  const state = freshState();
  reserve(state, { weight: 5 });
  assert.throws(
    () => reserve(state, { weight: 1, expectedRevision: 0 }),
    (error) => error.code === 'REVISION_CONFLICT'
  );
});

test('重复开启或关闭快照会被明确拒绝', () => {
  const state = freshState();
  openSnapshot(state);
  assert.throws(() => openSnapshot(state), (error) => error.code === 'SNAPSHOT_ALREADY_OPEN');
  closeSnapshot(state);
  assert.throws(() => closeSnapshot(state), (error) => error.code === 'SNAPSHOT_NOT_OPEN');
});
