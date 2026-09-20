import { randomUUID } from 'node:crypto';
import { GameRuleError } from './engine.js';
import { ISLANDS } from './engine.js';

// 统一暂存与转运容量（单位：kg）。所有岛屿共用同一容量口径。
export const DEFAULT_WAREHOUSE_CAPACITY = 30;
// 审计日志只保留最近若干条，避免存档无限增长。
const AUDIT_LIMIT = 200;

export class WarehouseRuleError extends GameRuleError {
  constructor(message, code, statusCode = 409, extra = {}) {
    super(message, [], statusCode);
    this.name = 'WarehouseRuleError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export const WAREHOUSE_ZONES = {
  staging: { label: '暂存' },
  transit: { label: '转运' }
};

export function createWarehouseState(capacity = DEFAULT_WAREHOUSE_CAPACITY) {
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new WarehouseRuleError('中转仓容量必须是正数。', 'CAPACITY_INVALID', 400);
  }
  const normalizedCapacity = Math.round(capacity * 10) / 10;
  return {
    revision: 0,
    capacities: { staging: normalizedCapacity, transit: normalizedCapacity },
    islands: Object.fromEntries(ISLANDS.map((island) => [
      island.id,
      { stagingUsed: 0, transitUsed: 0 }
    ])),
    reservations: {},
    openSnapshot: null,
    snapshots: [],
    audit: []
  };
}

// 旧存档没有 warehouse 字段时就地挂载，保证模块升级不丢局。
export function ensureWarehouse(state, capacity = DEFAULT_WAREHOUSE_CAPACITY) {
  if (!state.warehouse) {
    state.warehouse = createWarehouseState(capacity);
  }
  return state.warehouse;
}

function appendAudit(warehouse, entry) {
  warehouse.audit.push({ id: `A-${randomUUID()}`, at: new Date().toISOString(), ...entry });
  if (warehouse.audit.length > AUDIT_LIMIT) {
    warehouse.audit.splice(0, warehouse.audit.length - AUDIT_LIMIT);
  }
}

function touchWarehouse(warehouse) {
  warehouse.revision = Number.isInteger(warehouse.revision) ? warehouse.revision + 1 : 1;
}

function assertZone(zone) {
  if (!Object.hasOwn(WAREHOUSE_ZONES, zone)) {
    throw new WarehouseRuleError(
      `仓区必须是 ${Object.keys(WAREHOUSE_ZONES).join(' / ')} 之一。`,
      'ZONE_INVALID',
      400
    );
  }
}

function assertWeight(weight) {
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new WarehouseRuleError('占位重量必须是正数。', 'WEIGHT_INVALID', 400);
  }
  return Math.round(weight * 1000) / 1000;
}

function assertIsland(warehouse, islandId) {
  if (!Object.hasOwn(warehouse.islands, islandId)) {
    throw new WarehouseRuleError(`岛屿 ${islandId || '(空)'} 没有中转仓。`, 'ISLAND_NO_WAREHOUSE', 404);
  }
}

function assertRevision(warehouse, expectedRevision) {
  if (expectedRevision !== undefined && expectedRevision !== null) {
    if (!Number.isInteger(expectedRevision)) {
      throw new WarehouseRuleError('expectedRevision 必须是整数。', 'REVISION_INVALID', 400);
    }
    if (warehouse.revision !== expectedRevision) {
      throw new WarehouseRuleError('中转仓状态已被其他请求更新，请刷新后重试。', 'REVISION_CONFLICT', 409);
    }
  }
}

function activeReservations(warehouse) {
  return Object.values(warehouse.reservations).filter((hold) => hold.status === 'held');
}

function usedOf(warehouse, islandId, zone) {
  return activeReservations(warehouse)
    .filter((hold) => hold.islandId === islandId && hold.zone === zone)
    .reduce((sum, hold) => sum + hold.weight, 0);
}

// 以承诺台账为唯一事实来源，回填各岛各仓区占用，任何不一致都会被纠正而不是静默累积。
function recomputeUsage(warehouse) {
  for (const islandId of Object.keys(warehouse.islands)) {
    warehouse.islands[islandId] = {
      stagingUsed: Math.round(usedOf(warehouse, islandId, 'staging') * 1000) / 1000,
      transitUsed: Math.round(usedOf(warehouse, islandId, 'transit') * 1000) / 1000
    };
  }
}

function getHeld(warehouse, reservationId) {
  const hold = warehouse.reservations[reservationId];
  if (!hold) {
    throw new WarehouseRuleError(`占位 ${reservationId || '(空)'} 不存在。`, 'RESERVATION_NOT_FOUND', 404);
  }
  if (hold.status !== 'held') {
    throw new WarehouseRuleError(
      `占位 ${reservationId} 已${hold.status === 'committed' ? '入库' : hold.status === 'released' ? '回滚释放' : '作废'}，不能重复操作。`,
      'RESERVATION_NOT_HELD',
      409,
      { status: hold.status }
    );
  }
  return hold;
}

// 承诺占位：在统一容量口径上预占暂存或转运位。
export function reserveStaging(state, input = {}) {
  const warehouse = ensureWarehouse(state);
  assertRevision(warehouse, input.expectedRevision);
  assertZone(input.zone);
  const weight = assertWeight(input.weight);
  assertIsland(warehouse, input.islandId);
  if (warehouse.openSnapshot) {
    throw new WarehouseRuleError(
      `盘点快照 ${warehouse.openSnapshot.id} 进行中，禁止混入新承诺；快照关闭后再占位。`,
      'SNAPSHOT_FROZEN',
      409,
      { snapshotId: warehouse.openSnapshot.id }
    );
  }

  const usedKey = input.zone === 'staging' ? 'stagingUsed' : 'transitUsed';
  const usedBefore = warehouse.islands[input.islandId][usedKey];
  const capacity = warehouse.capacities[input.zone];
  if (usedBefore + weight > capacity + 0.0001) {
    throw new WarehouseRuleError(
      `${input.islandId} ${WAREHOUSE_ZONES[input.zone].label}容量不足：已承诺 ${round1(usedBefore)}/${capacity} kg，本次申请 ${round1(weight)} kg。`,
      'CAPACITY_EXCEEDED',
      409,
      { used: round1(usedBefore), capacity, requested: round1(weight) }
    );
  }

  const now = new Date().toISOString();
  const id = `H-${randomUUID()}`;
  const hold = {
    id,
    islandId: input.islandId,
    zone: input.zone,
    weight,
    reference: typeof input.reference === 'string' ? input.reference.slice(0, 80) : null,
    note: typeof input.note === 'string' ? input.note.slice(0, 120) : null,
    status: 'held',
    seq: warehouse.revision + 1,
    createdAt: now,
    committedAt: null,
    releasedAt: null,
    expiredAt: null,
    releaseReason: null
  };
  warehouse.reservations[id] = hold;
  recomputeUsage(warehouse);
  touchWarehouse(warehouse);
  appendAudit(warehouse, {
    type: 'reserved',
    reservationId: id,
    islandId: hold.islandId,
    zone: hold.zone,
    weight,
    reference: hold.reference
  });
  return { reservation: structuredClone(hold), warehouse: warehouseView(warehouse) };
}

// 入库确认：占位转为实际入库。任何一步校验失败，调用方都不会看到半写入状态。
export function commitInbound(state, reservationId, input = {}) {
  const warehouse = ensureWarehouse(state);
  assertRevision(warehouse, input.expectedRevision);
  assertIsland(warehouse, input.islandId ?? '');
  const hold = getHeld(warehouse, reservationId);
  if (hold.islandId !== input.islandId) {
    throw new WarehouseRuleError(`占位 ${reservationId} 不属于岛屿 ${input.islandId}。`, 'RESERVATION_ISLAND_MISMATCH', 409);
  }
  if (input.zone !== undefined) assertZone(input.zone);
  if (input.zone && hold.zone !== input.zone) {
    throw new WarehouseRuleError(`占位 ${reservationId} 属于${WAREHOUSE_ZONES[hold.zone].label}区，不能从其他仓区入库。`, 'RESERVATION_ZONE_MISMATCH', 409);
  }
  const committedWeight = input.weight === undefined ? hold.weight : assertWeight(input.weight);
  if (Math.abs(committedWeight - hold.weight) > 0.001) {
    throw new WarehouseRuleError(
      `入库重量 ${round1(committedWeight)} kg 与占位重量 ${round1(hold.weight)} kg 不一致，请先回滚再重新占位。`,
      'WEIGHT_MISMATCH',
      409
    );
  }

  const now = new Date().toISOString();
  hold.status = 'committed';
  hold.committedAt = now;
  // 占位即承诺，入库不改变占用量；这里仅纠正台账与占用口径。
  recomputeUsage(warehouse);
  touchWarehouse(warehouse);
  appendAudit(warehouse, {
    type: 'committed',
    reservationId: hold.id,
    islandId: hold.islandId,
    zone: hold.zone,
    weight: hold.weight,
    reference: hold.reference
  });
  return { reservation: structuredClone(hold), warehouse: warehouseView(warehouse) };
}

// 入库失败回滚：显式释放占位并记录原因，绝不允许占位静默消失。
export function rollbackReservation(state, reservationId, input = {}) {
  const warehouse = ensureWarehouse(state);
  assertRevision(warehouse, input.expectedRevision);
  const hold = getHeld(warehouse, reservationId);
  const reason = typeof input.reason === 'string' && input.reason.trim()
    ? input.reason.trim().slice(0, 160)
    : '入库失败';

  const now = new Date().toISOString();
  hold.status = 'released';
  hold.releasedAt = now;
  hold.releaseReason = reason;
  recomputeUsage(warehouse);
  touchWarehouse(warehouse);
  appendAudit(warehouse, {
    type: 'released',
    reservationId: hold.id,
    islandId: hold.islandId,
    zone: hold.zone,
    weight: hold.weight,
    reference: hold.reference,
    reason
  });
  return { reservation: structuredClone(hold), warehouse: warehouseView(warehouse) };
}

// 显式作废旧占位（例如撤单）。同样留痕，避免静默失效。
export function expireReservation(state, reservationId, input = {}) {
  const warehouse = ensureWarehouse(state);
  assertRevision(warehouse, input.expectedRevision);
  const hold = getHeld(warehouse, reservationId);
  const reason = typeof input.reason === 'string' && input.reason.trim()
    ? input.reason.trim().slice(0, 160)
    : '承诺显式作废';

  const now = new Date().toISOString();
  hold.status = 'expired';
  hold.expiredAt = now;
  hold.releaseReason = reason;
  recomputeUsage(warehouse);
  touchWarehouse(warehouse);
  appendAudit(warehouse, {
    type: 'expired',
    reservationId: hold.id,
    islandId: hold.islandId,
    zone: hold.zone,
    weight: hold.weight,
    reference: hold.reference,
    reason
  });
  return { reservation: structuredClone(hold), warehouse: warehouseView(warehouse) };
}

// 容量只允许扩容；缩容会让旧承诺静默失效，因此禁止。
export function increaseCapacity(state, zone, nextCapacity, input = {}) {
  const warehouse = ensureWarehouse(state);
  assertRevision(warehouse, input.expectedRevision);
  assertZone(zone);
  const capacity = assertWeight(nextCapacity);
  const current = warehouse.capacities[zone];
  if (capacity < current - 0.0001) {
    throw new WarehouseRuleError(
      `${WAREHOUSE_ZONES[zone].label}容量只能增加（当前 ${current} kg），缩容会使旧占位静默失效。`,
      'CAPACITY_SHRINK_FORBIDDEN',
      409,
      { current, requested: capacity }
    );
  }
  warehouse.capacities[zone] = capacity;
  touchWarehouse(warehouse);
  appendAudit(warehouse, { type: 'capacity-increased', zone, from: current, to: capacity });
  return { warehouse: warehouseView(warehouse) };
}

// 开启盘点快照：建立屏障，期间拒绝一切新占位，快照固定屏障前的承诺清单。
export function openSnapshot(state, input = {}) {
  const warehouse = ensureWarehouse(state);
  assertRevision(warehouse, input.expectedRevision);
  if (warehouse.openSnapshot) {
    throw new WarehouseRuleError(
      `盘点快照 ${warehouse.openSnapshot.id} 尚未关闭，不能重复开启。`,
      'SNAPSHOT_ALREADY_OPEN',
      409,
      { snapshotId: warehouse.openSnapshot.id }
    );
  }
  const note = typeof input.note === 'string' ? input.note.slice(0, 160) : null;
  const now = new Date().toISOString();
  const heldAtBarrier = activeReservations(warehouse).map((hold) => ({
    reservationId: hold.id,
    islandId: hold.islandId,
    zone: hold.zone,
    weight: hold.weight,
    reference: hold.reference,
    createdAt: hold.createdAt
  }));
  const id = `S-${randomUUID()}`;
  warehouse.openSnapshot = {
    id,
    openedAt: now,
    closedAt: null,
    note,
    barrierSeq: warehouse.revision,
    heldAtBarrier
  };
  touchWarehouse(warehouse);
  appendAudit(warehouse, {
    type: 'snapshot-opened',
    snapshotId: id,
    heldCount: heldAtBarrier.length,
    note
  });
  return { snapshot: structuredClone(warehouse.openSnapshot), warehouse: warehouseView(warehouse) };
}

// 关闭盘点快照：以屏障清单为基准记录差异（旧占位在期间被提交/回滚/作废都会显式呈现）。
export function closeSnapshot(state, input = {}) {
  const warehouse = ensureWarehouse(state);
  assertRevision(warehouse, input.expectedRevision);
  if (!warehouse.openSnapshot) {
    throw new WarehouseRuleError('当前没有进行中的盘点快照。', 'SNAPSHOT_NOT_OPEN', 409);
  }
  const snapshot = warehouse.openSnapshot;
  const now = new Date().toISOString();

  const barrierById = new Map(snapshot.heldAtBarrier.map((item) => [item.reservationId, item]));
  const reconciled = snapshot.heldAtBarrier.map((item) => {
    const current = warehouse.reservations[item.reservationId];
    return {
      reservationId: item.reservationId,
      islandId: item.islandId,
      zone: item.zone,
      weight: item.weight,
      statusAtBarrier: 'held',
      statusAtClose: current ? current.status : 'missing',
      releasedReason: current ? current.releaseReason : '台账缺失'
    };
  });
  // 理论上屏障后无法新建占位（reserve 被拒绝），这里仍审计任何异常混入。
  const intruded = activeReservations(warehouse)
    .filter((hold) => !barrierById.has(hold.id))
    .map((hold) => hold.id);

  const record = {
    id: snapshot.id,
    openedAt: snapshot.openedAt,
    closedAt: now,
    note: snapshot.note,
    barrierSeq: snapshot.barrierSeq,
    heldAtBarrier: structuredClone(snapshot.heldAtBarrier),
    reconciled,
    intrudedReservationIds: intruded
  };
  warehouse.snapshots.push(record);
  if (warehouse.snapshots.length > 50) warehouse.snapshots.shift();
  warehouse.openSnapshot = null;
  touchWarehouse(warehouse);
  appendAudit(warehouse, {
    type: 'snapshot-closed',
    snapshotId: record.id,
    heldCount: record.heldAtBarrier.length,
    intrudedCount: intruded.length
  });
  return { snapshot: structuredClone(record), warehouse: warehouseView(warehouse) };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

export function islandWarehouseView(warehouse, islandId) {
  assertIsland(warehouse, islandId);
  const usage = warehouse.islands[islandId];
  return {
    islandId,
    staging: {
      used: round1(usage.stagingUsed),
      capacity: warehouse.capacities.staging,
      free: round1(warehouse.capacities.staging - usage.stagingUsed)
    },
    transit: {
      used: round1(usage.transitUsed),
      capacity: warehouse.capacities.transit,
      free: round1(warehouse.capacities.transit - usage.transitUsed)
    }
  };
}

export function warehouseView(warehouse) {
  return {
    revision: warehouse.revision,
    capacities: structuredClone(warehouse.capacities),
    frozen: warehouse.openSnapshot !== null,
    openSnapshot: warehouse.openSnapshot ? structuredClone(warehouse.openSnapshot) : null,
    islands: Object.fromEntries(
      Object.keys(warehouse.islands).map((islandId) => [islandId, islandWarehouseView(warehouse, islandId)])
    ),
    heldReservations: activeReservations(warehouse).map((hold) => structuredClone(hold)),
    recentAudit: structuredClone(warehouse.audit.slice(-20).reverse())
  };
}

export function getReservation(state, reservationId) {
  const warehouse = ensureWarehouse(state);
  const hold = warehouse.reservations[reservationId];
  if (!hold) {
    throw new WarehouseRuleError(`占位 ${reservationId || '(空)'} 不存在。`, 'RESERVATION_NOT_FOUND', 404);
  }
  return structuredClone(hold);
}

const HOLD_STATUSES = new Set(['held', 'committed', 'released', 'expired']);

// 存档校验：任何字段缺失或口径不一致都视为损坏，由 store 走备份恢复，绝不带病加载。
export function isValidWarehouseShape(warehouse, islandIds = ISLANDS.map((island) => island.id)) {
  if (!warehouse || typeof warehouse !== 'object' || Array.isArray(warehouse)) return false;
  if (!Number.isInteger(warehouse.revision) || warehouse.revision < 0) return false;
  if (!warehouse.capacities || typeof warehouse.capacities !== 'object') return false;
  for (const zone of Object.keys(WAREHOUSE_ZONES)) {
    if (!Number.isFinite(warehouse.capacities[zone]) || warehouse.capacities[zone] <= 0) return false;
  }
  if (!warehouse.islands || typeof warehouse.islands !== 'object') return false;
  for (const islandId of islandIds) {
    const usage = warehouse.islands[islandId];
    if (!usage) return false;
    if (!Number.isFinite(usage.stagingUsed) || usage.stagingUsed < 0) return false;
    if (!Number.isFinite(usage.transitUsed) || usage.transitUsed < 0) return false;
  }
  if (!warehouse.reservations || typeof warehouse.reservations !== 'object') return false;
  for (const [id, hold] of Object.entries(warehouse.reservations)) {
    if (typeof id !== 'string' || !hold || typeof hold !== 'object') return false;
    if (!islandIds.includes(hold.islandId)) return false;
    if (!Object.hasOwn(WAREHOUSE_ZONES, hold.zone)) return false;
    if (!Number.isFinite(hold.weight) || hold.weight <= 0) return false;
    if (!HOLD_STATUSES.has(hold.status)) return false;
    if (typeof hold.createdAt !== 'string') return false;
  }
  if (!Array.isArray(warehouse.snapshots) || !Array.isArray(warehouse.audit)) return false;
  if (warehouse.openSnapshot !== null && (typeof warehouse.openSnapshot !== 'object' || !Array.isArray(warehouse.openSnapshot.heldAtBarrier))) {
    return false;
  }
  return true;
}
