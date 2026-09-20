import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWarehouseState,
  stageInbound,
  commitInbound,
  rejectInbound,
  releaseHold,
  reserveTransfer,
  completeTransfer,
  failTransfer,
  sweepExpired,
  startSnapshot,
  finalizeSnapshot,
  getOccupancy,
  getHold,
  HOLD_STATUS,
  HOLD_TTL_MS
} from '../warehouse.js';

const T0 = Date.parse('2026-09-20T08:00:00.000Z');
const MINUTE = 60 * 1000;

function inbound(state, overrides = {}) {
  return stageInbound(state, {
    letterId: overrides.letterId || `L-${state.holdSeq + 1}`,
    sourceIslandId: overrides.sourceIslandId || 'sun',
    weightKg: overrides.weightKg ?? 2,
    now: overrides.now ?? T0,
    ttlMs: overrides.ttlMs ?? HOLD_TTL_MS
  });
}

test('暂存与转运共用统一容量池：占位即占用，校验失败不留半条记录', () => {
  const state = createWarehouseState({ now: T0 });
  assert.deepEqual(getOccupancy(state), { weightKg: 0, slots: 0 });

  inbound(state, { letterId: 'A', weightKg: 10 });
  inbound(state, { letterId: 'B', weightKg: 15 });
  assert.deepEqual(getOccupancy(state), { weightKg: 25, slots: 2 });

  // 超重：抛错且没有新占位、没有占用变化
  assert.throws(
    () => inbound(state, { letterId: 'C', weightKg: 10 }),
    /承重不足/
  );
  assert.equal(state.holds.length, 2);
  assert.deepEqual(getOccupancy(state), { weightKg: 25, slots: 2 });
  assert.ok(!state.audit.some((entry) => entry.holdId === 'H-003'));

  // 填满槽位（上限 10 位）
  const small = createWarehouseState({ now: T0, capacity: { weightKg: 100, slots: 2 } });
  inbound(small, { letterId: 'A', weightKg: 1 });
  inbound(small, { letterId: 'B', weightKg: 1 });
  assert.throws(() => inbound(small, { letterId: 'C', weightKg: 1 }), /暂存位已满/);
  assert.equal(small.holds.length, 2);
});

test('入库失败回滚占位：状态显式留痕，容量立即归还', () => {
  const state = createWarehouseState({ now: T0 });
  const hold = inbound(state, { letterId: 'A', weightKg: 8 });

  const result = rejectInbound(state, { holdId: hold.id, reason: '外箱破损', now: T0 + MINUTE });
  assert.equal(result.hold.status, HOLD_STATUS.ROLLED_BACK);
  assert.equal(result.freedWeightKg, 8);
  assert.equal(result.freedSlots, 1);
  assert.equal(getHold(state, hold.id).reason, '外箱破损');
  assert.deepEqual(getOccupancy(state), { weightKg: 0, slots: 0 });

  // 记录仍在（不静默删除），审计可追溯
  assert.equal(state.holds.length, 1);
  assert.ok(state.audit.some((entry) => entry.action === 'rollback-inbound' && entry.holdId === hold.id));

  // 回滚后空出的容量可被新货物使用
  const replacement = inbound(state, { letterId: 'B', weightKg: 30, now: T0 + 2 * MINUTE });
  assert.equal(replacement.status, HOLD_STATUS.STAGED);
  assert.deepEqual(getOccupancy(state), { weightKg: 30, slots: 1 });

  // 已回滚占位不能重复操作
  assert.throws(() => commitInbound(state, { holdId: hold.id }), /只有暂存中/);
});

test('已上架货物入库失败同样可以回滚', () => {
  const state = createWarehouseState({ now: T0 });
  const hold = inbound(state, { letterId: 'A', weightKg: 12 });
  commitInbound(state, { holdId: hold.id, now: T0 + MINUTE });
  rejectInbound(state, { holdId: hold.id, reason: '验收复查残损', now: T0 + 2 * MINUTE });
  assert.equal(getHold(state, hold.id).status, HOLD_STATUS.ROLLED_BACK);
  assert.deepEqual(getOccupancy(state), { weightKg: 0, slots: 0 });
});

test('转运占位在离场前持续占用统一容量，完成后才归还', () => {
  const state = createWarehouseState({ now: T0 });
  const hold = inbound(state, { letterId: 'A', weightKg: 20 });
  commitInbound(state, { holdId: hold.id, now: T0 + MINUTE });
  reserveTransfer(state, { holdId: hold.id, destinationIslandId: 'gale', now: T0 + 2 * MINUTE });

  assert.equal(getHold(state, hold.id).status, HOLD_STATUS.TRANSFERRING);
  assert.deepEqual(getOccupancy(state), { weightKg: 20, slots: 1 });
  // 转运中不能再申请入库回滚
  assert.throws(() => rejectInbound(state, { holdId: hold.id }), /正在转运中/);

  const done = completeTransfer(state, { holdId: hold.id, now: T0 + 30 * MINUTE });
  assert.equal(done.hold.status, HOLD_STATUS.TRANSFERRED);
  assert.equal(done.freedWeightKg, 20);
  assert.deepEqual(getOccupancy(state), { weightKg: 0, slots: 0 });
});

test('转运失败时货物回仓，容量全程不丢失', () => {
  const state = createWarehouseState({ now: T0 });
  const hold = inbound(state, { letterId: 'A', weightKg: 18 });
  commitInbound(state, { holdId: hold.id });
  reserveTransfer(state, { holdId: hold.id, destinationIslandId: 'mist' });
  const returned = failTransfer(state, { holdId: hold.id, reason: '天气关闭航道', now: T0 + MINUTE });

  assert.equal(returned.status, HOLD_STATUS.COMMITTED);
  assert.equal(returned.destinationIslandId, null);
  assert.deepEqual(getOccupancy(state), { weightKg: 18, slots: 1 });
  assert.ok(state.audit.some((entry) => entry.action === 'transfer-fail-return'));
});

test('盘点快照期间冻结一切新承诺', () => {
  const state = createWarehouseState({ now: T0 });
  const hold = inbound(state, { letterId: 'A', weightKg: 5 });
  commitInbound(state, { holdId: hold.id });
  const snapshot = startSnapshot(state, { now: T0 + MINUTE });

  assert.equal(state.phase, 'auditing');
  assert.deepEqual(snapshot.manifestHoldIds, [hold.id]);

  assert.throws(() => inbound(state, { letterId: 'B', weightKg: 1, now: T0 + 2 * MINUTE }), /禁止混入/);
  assert.throws(() => reserveTransfer(state, { holdId: hold.id, destinationIslandId: 'gale' }), /禁止混入/);
  assert.throws(() => rejectInbound(state, { holdId: hold.id }), /禁止混入/);
  assert.throws(() => releaseHold(state, { holdId: hold.id }), /禁止混入/);
  assert.throws(() => completeTransfer(state, { holdId: hold.id }), /禁止混入/);
  // 冻结期间容量与占位保持不变
  assert.deepEqual(getOccupancy(state), { weightKg: 5, slots: 1 });
  assert.equal(getHold(state, hold.id).status, HOLD_STATUS.COMMITTED);

  const finalized = finalizeSnapshot(state, { now: T0 + 2 * MINUTE });
  assert.equal(finalized.status, 'finalized');
  assert.equal(state.phase, 'open');
  assert.deepEqual(finalized.anomalies, []);

  // 解冻后新承诺恢复
  const second = inbound(state, { letterId: 'B', weightKg: 4, now: T0 + 3 * MINUTE });
  assert.equal(second.status, HOLD_STATUS.STAGED);
});

test('旧占位不会静默失效：必须由清扫显式标记 expired 并审计', () => {
  const state = createWarehouseState({ now: T0 });
  const hold = inbound(state, { letterId: 'A', weightKg: 6, ttlMs: 10 * MINUTE });

  // 时间流逝但没有清扫：占位仍然有效、容量仍占用
  assert.equal(getHold(state, hold.id).status, HOLD_STATUS.STAGED);
  assert.deepEqual(getOccupancy(state), { weightKg: 6, slots: 1 });

  const result = sweepExpired(state, { now: T0 + 11 * MINUTE });
  assert.equal(result.expired.length, 1);
  assert.equal(result.expired[0].id, hold.id);
  assert.equal(getHold(state, hold.id).status, HOLD_STATUS.EXPIRED);
  assert.equal(getHold(state, hold.id).reason, '占位超过保留时限');
  assert.deepEqual(getOccupancy(state), { weightKg: 0, slots: 0 });
  assert.ok(state.audit.some((entry) => entry.action === 'expire' && entry.holdId === hold.id));

  // 已提交（committed）的货架占位没有 TTL，不会被清扫
  const other = inbound(state, { letterId: 'B', weightKg: 3, now: T0 + 12 * MINUTE });
  commitInbound(state, { holdId: other.id, now: T0 + 13 * MINUTE });
  const later = sweepExpired(state, { now: T0 + 60 * MINUTE });
  assert.equal(later.expired.length, 0);
  assert.equal(getHold(state, other.id).status, HOLD_STATUS.COMMITTED);
});

test('盘点冻结期间到期的占位顺延到解冻后处理，并在快照中登记异常', () => {
  const state = createWarehouseState({ now: T0 });
  const hold = inbound(state, { letterId: 'A', weightKg: 7, ttlMs: 5 * MINUTE });
  startSnapshot(state, { now: T0 + MINUTE });

  // 冻结期内清扫被推迟，占位保持 staged，容量不丢
  const deferred = sweepExpired(state, { now: T0 + 10 * MINUTE });
  assert.equal(deferred.deferred, true);
  assert.deepEqual(deferred.expired, []);
  assert.equal(getHold(state, hold.id).status, HOLD_STATUS.STAGED);
  assert.deepEqual(getOccupancy(state), { weightKg: 7, slots: 1 });

  const snapshot = finalizeSnapshot(state, { now: T0 + 10 * MINUTE });
  assert.equal(getHold(state, hold.id).status, HOLD_STATUS.EXPIRED);
  assert.deepEqual(snapshot.deferredExpirationHoldIds, [hold.id]);
  assert.ok(snapshot.anomalies.some((item) => item.code === 'EXPIRED_DURING_AUDIT'));
  assert.deepEqual(getOccupancy(state), { weightKg: 0, slots: 0 });
});

test('盘点基线占位若在冻结期被破坏，结快照时产生异常而不是静默修正', () => {
  const state = createWarehouseState({ now: T0 });
  const hold = inbound(state, { letterId: 'A', weightKg: 5 });
  const snapshot = startSnapshot(state, { now: T0 + MINUTE });
  assert.equal(snapshot.manifestHoldIds.includes(hold.id), true);

  // 模拟底层存档被外部破坏：冻结期内占位丢失
  state.holds = state.holds.filter((item) => item.id !== hold.id);
  const finalized = finalizeSnapshot(state, { now: T0 + 2 * MINUTE });
  assert.ok(finalized.anomalies.some((item) => item.code === 'MANIFOLD_HOLD_MISSING'));
  assert.ok(finalized.anomalies.some((item) => item.code === 'OCCUPANCY_DRIFT'));
});

test('同一封邮件不能重复占位，主动释放会留痕并归还容量', () => {
  const state = createWarehouseState({ now: T0 });
  const hold = inbound(state, { letterId: 'A', weightKg: 2 });
  assert.throws(() => inbound(state, { letterId: 'A', weightKg: 2 }), /不能重复占位/);

  const result = releaseHold(state, { holdId: hold.id, now: T0 + MINUTE });
  assert.equal(result.hold.status, HOLD_STATUS.RELEASED);
  assert.deepEqual(getOccupancy(state), { weightKg: 0, slots: 0 });
  // 释放后可以重新占位
  const again = inbound(state, { letterId: 'A', weightKg: 2, now: T0 + 2 * MINUTE });
  assert.equal(again.status, HOLD_STATUS.STAGED);
});

test('每次成功变更都递增 revision', () => {
  const state = createWarehouseState({ now: T0 });
  assert.equal(state.revision, 0);
  const hold = inbound(state, { letterId: 'A', weightKg: 1 });
  assert.equal(state.revision, 1);
  commitInbound(state, { holdId: hold.id });
  assert.equal(state.revision, 2);
  rejectInbound(state, { holdId: hold.id });
  assert.equal(state.revision, 3);
  // 清扫无过期物时不递增
  const before = state.revision;
  sweepExpired(state, { now: T0 });
  assert.equal(state.revision, before);
});
