import { GameRuleError } from './engine.js';

export const WAREHOUSE_VERSION = 1;
export const WAREHOUSE_CAPACITY = { weightKg: 30, slots: 10 };
export const HOLD_TTL_MS = 15 * 60 * 1000;

export const WAREHOUSE_PHASE = {
  OPEN: 'open',
  AUDITING: 'auditing'
};

export const HOLD_STATUS = {
  STAGED: 'staged', // 到港暂存占位，等待入库验收
  COMMITTED: 'committed', // 入库成功，货架占位
  TRANSFERRING: 'transferring', // 转运中，仍占用统一容量池
  ROLLED_BACK: 'rolled_back', // 入库失败，占位已回滚
  RELEASED: 'released', // 主动释放，占位已回收
  TRANSFERRED: 'transferred', // 转运完成离场
  EXPIRED: 'expired' // 占位超时，被显式标记失效
};

export const ACTIVE_HOLD_STATUSES = new Set([
  HOLD_STATUS.STAGED,
  HOLD_STATUS.COMMITTED,
  HOLD_STATUS.TRANSFERRING
]);

const TERMINAL_STATUSES = new Set([
  HOLD_STATUS.ROLLED_BACK,
  HOLD_STATUS.RELEASED,
  HOLD_STATUS.TRANSFERRED,
  HOLD_STATUS.EXPIRED
]);

const ROUND = 0.001;

export class WarehouseRuleError extends GameRuleError {
  constructor(message, code, issues = [], statusCode = 400) {
    super(message, issues, statusCode);
    this.name = 'WarehouseRuleError';
    this.code = code;
  }
}

export function createWarehouseState({ now = Date.now(), capacity = WAREHOUSE_CAPACITY } = {}) {
  return {
    version: WAREHOUSE_VERSION,
    phase: WAREHOUSE_PHASE.OPEN,
    capacity: { weightKg: capacity.weightKg, slots: capacity.slots },
    holds: [],
    snapshots: [],
    audit: [],
    holdSeq: 0,
    snapshotSeq: 0,
    auditSeq: 0,
    revision: 0,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  };
}

export function getActiveHolds(state) {
  return state.holds.filter((hold) => ACTIVE_HOLD_STATUSES.has(hold.status));
}

export function getOccupancy(state) {
  const active = getActiveHolds(state);
  return {
    weightKg: round1(active.reduce((sum, hold) => sum + hold.weightKg, 0)),
    slots: active.length
  };
}

export function getHold(state, holdId) {
  return state.holds.find((hold) => hold.id === holdId) || null;
}

export function getOpenSnapshot(state) {
  return state.snapshots.find((snapshot) => snapshot.status === 'open') || null;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function assertOpenPhase(state) {
  if (state.phase === WAREHOUSE_PHASE.AUDITING) {
    throw new WarehouseRuleError(
      '盘点快照进行中，仓位已冻结，禁止混入新的暂存、入库或转运承诺。',
      'WAREHOUSE_AUDITING',
      [{ code: 'WAREHOUSE_AUDITING', message: '盘点结束前不允许变更占位。' }],
      409
    );
  }
}

function assertHoldActive(hold) {
  if (!hold || !ACTIVE_HOLD_STATUSES.has(hold.status)) {
    throw new WarehouseRuleError(
      `占位 ${hold?.id || '(空)'} 已不在有效状态，不能执行该操作。`,
      'HOLD_NOT_ACTIVE',
      [{ code: 'HOLD_NOT_ACTIVE', holdId: hold?.id || null }]
    );
  }
}

function nextHoldId(state) {
  state.holdSeq += 1;
  return `H-${String(state.holdSeq).padStart(3, '0')}`;
}

function nextSnapshotId(state) {
  state.snapshotSeq += 1;
  return `S-${String(state.snapshotSeq).padStart(3, '0')}`;
}

function appendAudit(state, action, { now, holdId = null, snapshotId = null, detail = null } = {}) {
  state.auditSeq += 1;
  state.audit.push({
    seq: state.auditSeq,
    at: new Date(now).toISOString(),
    action,
    holdId,
    snapshotId,
    detail
  });
  if (state.audit.length > 200) state.audit.splice(0, state.audit.length - 200);
}

function bumpRevision(state) {
  state.revision = Number.isInteger(state.revision) ? state.revision + 1 : 1;
  state.updatedAt = new Date().toISOString();
}

function validateCargoInput({ letterId, sourceIslandId, weightKg }) {
  if (typeof letterId !== 'string' || letterId.length === 0) {
    throw new WarehouseRuleError('入库必须提供邮件编号。', 'LETTER_INVALID');
  }
  if (typeof sourceIslandId !== 'string' || sourceIslandId.length === 0) {
    throw new WarehouseRuleError('入库必须提供来源岛屿。', 'SOURCE_ISLAND_INVALID');
  }
  if (!Number.isFinite(weightKg) || weightKg <= 0) {
    throw new WarehouseRuleError(`货物重量无效：${weightKg}。`, 'WEIGHT_INVALID');
  }
}

function assertCapacityAvailable(state, addedWeightKg) {
  const occupancy = getOccupancy(state);
  if (occupancy.slots + 1 > state.capacity.slots) {
    throw new WarehouseRuleError(
      `中转仓暂存位已满（${occupancy.slots}/${state.capacity.slots} 位），无法再占位。`,
      'WAREHOUSE_SLOTS_FULL',
      [{ code: 'WAREHOUSE_SLOTS_FULL', occupancy, capacity: state.capacity }]
    );
  }
  const nextWeight = round1(occupancy.weightKg + addedWeightKg);
  if (nextWeight > state.capacity.weightKg + ROUND) {
    throw new WarehouseRuleError(
      `中转仓承重不足：当前 ${occupancy.weightKg} kg，新增 ${addedWeightKg} kg 后超过 ${state.capacity.weightKg} kg 上限。`,
      'WAREHOUSE_WEIGHT_FULL',
      [{ code: 'WAREHOUSE_WEIGHT_FULL', occupancy, capacity: state.capacity, nextWeightKg: nextWeight }]
    );
  }
}

/**
 * 到港暂存：在统一容量池中预留一个占位。
 * 任何校验失败都在写入前抛出，调用方持有的状态不会留下半条占位。
 */
export function stageInbound(state, { letterId, sourceIslandId, weightKg, now = Date.now(), ttlMs = HOLD_TTL_MS } = {}) {
  assertOpenPhase(state);
  validateCargoInput({ letterId, sourceIslandId, weightKg });

  const duplicate = getActiveHolds(state).find((hold) => hold.letterId === letterId);
  if (duplicate) {
    throw new WarehouseRuleError(
      `邮件 ${letterId} 已存在有效占位 ${duplicate.id}，不能重复占位。`,
      'HOLD_DUPLICATE',
      [{ code: 'HOLD_DUPLICATE', letterId, holdId: duplicate.id }]
    );
  }

  assertCapacityAvailable(state, weightKg);

  const hold = {
    id: nextHoldId(state),
    letterId,
    kind: 'staging',
    sourceIslandId,
    destinationIslandId: null,
    weightKg: round1(weightKg),
    status: HOLD_STATUS.STAGED,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    committedAt: null,
    releasedAt: null,
    reason: null
  };
  state.holds.push(hold);
  appendAudit(state, 'stage', { now, holdId: hold.id, detail: { letterId, weightKg: hold.weightKg } });
  bumpRevision(state);
  return structuredClone(hold);
}

/**
 * 入库验收通过：暂存占位转为正式货架占位。
 */
export function commitInbound(state, { holdId, now = Date.now() } = {}) {
  assertOpenPhase(state);
  const hold = getHold(state, holdId);
  if (!hold) {
    throw new WarehouseRuleError(`找不到占位 ${holdId || '(空)'}。`, 'HOLD_NOT_FOUND');
  }
  if (hold.status !== HOLD_STATUS.STAGED) {
    throw new WarehouseRuleError(
      `占位 ${hold.id} 当前为 ${hold.status}，只有暂存中的占位可以验收入库。`,
      'HOLD_NOT_STAGED',
      [{ code: 'HOLD_NOT_STAGED', holdId: hold.id, status: hold.status }]
    );
  }
  hold.status = HOLD_STATUS.COMMITTED;
  hold.committedAt = new Date(now).toISOString();
  hold.expiresAt = null;
  appendAudit(state, 'commit', { now, holdId: hold.id });
  bumpRevision(state);
  return structuredClone(hold);
}

function releaseHoldWithStatus(state, hold, status, action, reason, now) {
  hold.status = status;
  hold.releasedAt = new Date(now).toISOString();
  hold.reason = reason || null;
  hold.expiresAt = null;
  appendAudit(state, action, { now, holdId: hold.id, detail: reason ? { reason } : null });
  bumpRevision(state);
}

/**
 * 入库失败回滚：占位不删除，显式标记为 rolled_back 并立即归还统一容量。
 * 暂存或已上架的占位都可回滚（验收后发现残损同样适用）。
 */
export function rejectInbound(state, { holdId, reason = '入库验收失败', now = Date.now() } = {}) {
  assertOpenPhase(state);
  const hold = getHold(state, holdId);
  assertHoldActive(hold);
  if (hold.status === HOLD_STATUS.TRANSFERRING) {
    throw new WarehouseRuleError(
      `占位 ${hold.id} 正在转运中，回仓请使用转运失败接口。`,
      'HOLD_IN_TRANSFER',
      [{ code: 'HOLD_IN_TRANSFER', holdId: hold.id }]
    );
  }
  const occupancyBefore = getOccupancy(state);
  releaseHoldWithStatus(state, hold, HOLD_STATUS.ROLLED_BACK, 'rollback-inbound', reason, now);
  const occupancyAfter = getOccupancy(state);
  return {
    hold: structuredClone(hold),
    freedWeightKg: round1(occupancyBefore.weightKg - occupancyAfter.weightKg),
    freedSlots: occupancyBefore.slots - occupancyAfter.slots
  };
}

/**
 * 主动释放占位（取消到港、撤回预报等），同样显式留痕。
 */
export function releaseHold(state, { holdId, reason = '主动释放占位', now = Date.now() } = {}) {
  assertOpenPhase(state);
  const hold = getHold(state, holdId);
  assertHoldActive(hold);
  const occupancyBefore = getOccupancy(state);
  releaseHoldWithStatus(state, hold, HOLD_STATUS.RELEASED, 'release', reason, now);
  const occupancyAfter = getOccupancy(state);
  return {
    hold: structuredClone(hold),
    freedWeightKg: round1(occupancyBefore.weightKg - occupancyAfter.weightKg),
    freedSlots: occupancyBefore.slots - occupancyAfter.slots
  };
}

/**
 * 申请转运：货架占位转为转运占位。
 * 转运与暂存共用同一个容量池——货物离岛前，这份容量仍被占用。
 */
export function reserveTransfer(state, { holdId, destinationIslandId, now = Date.now(), ttlMs = HOLD_TTL_MS } = {}) {
  assertOpenPhase(state);
  const hold = getHold(state, holdId);
  if (!hold) {
    throw new WarehouseRuleError(`找不到占位 ${holdId || '(空)'}。`, 'HOLD_NOT_FOUND');
  }
  if (hold.status !== HOLD_STATUS.COMMITTED) {
    throw new WarehouseRuleError(
      `占位 ${hold.id} 当前为 ${hold.status}，只有已入库的货物可以申请转运。`,
      'HOLD_NOT_COMMITTED',
      [{ code: 'HOLD_NOT_COMMITTED', holdId: hold.id, status: hold.status }]
    );
  }
  if (typeof destinationIslandId !== 'string' || destinationIslandId.length === 0) {
    throw new WarehouseRuleError('转运必须提供目标岛屿。', 'DESTINATION_INVALID');
  }
  if (destinationIslandId === hold.sourceIslandId) {
    throw new WarehouseRuleError('转运目标不能与来源岛屿相同。', 'DESTINATION_SAME_AS_SOURCE');
  }

  hold.kind = 'transfer';
  hold.status = HOLD_STATUS.TRANSFERRING;
  hold.destinationIslandId = destinationIslandId;
  hold.expiresAt = new Date(now + ttlMs).toISOString();
  appendAudit(state, 'transfer-reserve', {
    now,
    holdId: hold.id,
    detail: { destinationIslandId }
  });
  bumpRevision(state);
  return structuredClone(hold);
}

/**
 * 转运完成：货物离场，归容量。
 */
export function completeTransfer(state, { holdId, now = Date.now() } = {}) {
  assertOpenPhase(state);
  const hold = getHold(state, holdId);
  if (!hold || hold.status !== HOLD_STATUS.TRANSFERRING) {
    throw new WarehouseRuleError(
      `占位 ${holdId || '(空)'} 不处于转运中。`,
      'HOLD_NOT_TRANSFERRING',
      [{ code: 'HOLD_NOT_TRANSFERRING', holdId: holdId || null }]
    );
  }
  const occupancyBefore = getOccupancy(state);
  releaseHoldWithStatus(state, hold, HOLD_STATUS.TRANSFERRED, 'transfer-complete', null, now);
  const occupancyAfter = getOccupancy(state);
  return {
    hold: structuredClone(hold),
    freedWeightKg: round1(occupancyBefore.weightKg - occupancyAfter.weightKg),
    freedSlots: occupancyBefore.slots - occupancyAfter.slots
  };
}

/**
 * 转运失败：货物退回中转仓，恢复为已入库占位，容量全程不释放、不丢失。
 */
export function failTransfer(state, { holdId, reason = '转运失败，货物回仓', now = Date.now() } = {}) {
  assertOpenPhase(state);
  const hold = getHold(state, holdId);
  if (!hold || hold.status !== HOLD_STATUS.TRANSFERRING) {
    throw new WarehouseRuleError(
      `占位 ${holdId || '(空)'} 不处于转运中，无法回仓。`,
      'HOLD_NOT_TRANSFERRING',
      [{ code: 'HOLD_NOT_TRANSFERRING', holdId: holdId || null }]
    );
  }
  hold.kind = 'staging';
  hold.status = HOLD_STATUS.COMMITTED;
  hold.destinationIslandId = null;
  hold.expiresAt = null;
  appendAudit(state, 'transfer-fail-return', { now, holdId: hold.id, detail: { reason } });
  bumpRevision(state);
  return structuredClone(hold);
}

/**
 * 超时清扫：过期占位永不静默消失——显式置为 expired、记录审计并归还容量。
 * 盘点冻结期间不做清扫，过期判定顺延到快照完成之后。
 */
export function sweepExpired(state, { now = Date.now() } = {}) {
  if (state.phase === WAREHOUSE_PHASE.AUDITING) {
    return { expired: [], deferred: true };
  }
  const expired = [];
  for (const hold of getActiveHolds(state)) {
    const canExpire = hold.status === HOLD_STATUS.STAGED || hold.status === HOLD_STATUS.TRANSFERRING;
    if (canExpire && hold.expiresAt && Date.parse(hold.expiresAt) <= now) {
      hold.status = HOLD_STATUS.EXPIRED;
      hold.releasedAt = new Date(now).toISOString();
      hold.reason = '占位超过保留时限';
      const expiresAt = hold.expiresAt;
      hold.expiresAt = null;
      expired.push(structuredClone(hold));
      appendAudit(state, 'expire', { now, holdId: hold.id, detail: { expiredSince: expiresAt } });
    }
  }
  if (expired.length > 0) bumpRevision(state);
  return { expired, deferred: false };
}

/**
 * 开始盘点快照：先清扫再定格基线，随后仓库进入冻结期。
 */
export function startSnapshot(state, { now = Date.now() } = {}) {
  assertOpenPhase(state);
  sweepExpired(state, { now });

  const active = getActiveHolds(state);
  const occupancy = getOccupancy(state);
  const snapshot = {
    id: nextSnapshotId(state),
    status: 'open',
    startedAt: new Date(now).toISOString(),
    finalizedAt: null,
    baseline: { weightKg: occupancy.weightKg, slots: occupancy.slots },
    manifestHoldIds: active.map((hold) => hold.id),
    deferredExpirationHoldIds: [],
    anomalies: []
  };
  state.snapshots.push(snapshot);
  state.phase = WAREHOUSE_PHASE.AUDITING;
  appendAudit(state, 'snapshot-start', { now, snapshotId: snapshot.id });
  bumpRevision(state);
  return structuredClone(snapshot);
}

/**
 * 完成盘点快照：
 * 1. 核对基线占位一个不少（旧占位不得静默失效）；
 * 2. 解冻后补做冻结期间被顺延的超时清扫，逐条登记异常；
 * 3. 记录占用漂移，任何不一致都进入 anomalies 而不是被静默修正。
 */
export function finalizeSnapshot(state, { snapshotId, now = Date.now() } = {}) {
  if (state.phase !== WAREHOUSE_PHASE.AUDITING) {
    throw new WarehouseRuleError('当前没有进行中的盘点快照。', 'NO_OPEN_SNAPSHOT');
  }
  const snapshot = getOpenSnapshot(state);
  if (!snapshot || (snapshotId && snapshot.id !== snapshotId)) {
    throw new WarehouseRuleError(`盘点快照 ${snapshotId || '(空)'} 不处于进行中。`, 'SNAPSHOT_NOT_OPEN');
  }

  for (const holdId of snapshot.manifestHoldIds) {
    const hold = getHold(state, holdId);
    if (!hold || !ACTIVE_HOLD_STATUSES.has(hold.status)) {
      snapshot.anomalies.push({
        code: 'MANIFOLD_HOLD_MISSING',
        holdId,
        message: `基线占位 ${holdId} 在盘点期间消失或状态被改变（当前：${hold?.status || '不存在'}）。`
      });
    }
  }

  const occupancy = getOccupancy(state);
  if (
    Math.abs(occupancy.weightKg - snapshot.baseline.weightKg) > ROUND ||
    occupancy.slots !== snapshot.baseline.slots
  ) {
    snapshot.anomalies.push({
      code: 'OCCUPANCY_DRIFT',
      message: `盘点期间占用发生漂移：基线 ${snapshot.baseline.weightKg} kg / ${snapshot.baseline.slots} 位，当前 ${occupancy.weightKg} kg / ${occupancy.slots} 位。`,
      baseline: snapshot.baseline,
      current: occupancy
    });
  }

  state.phase = WAREHOUSE_PHASE.OPEN;

  // 冻结期内到期的占位在解冻后补扫，并在快照中显式留痕。
  const expiredDuringAudit = [];
  for (const hold of getActiveHolds(state)) {
    const canExpire = hold.status === HOLD_STATUS.STAGED || hold.status === HOLD_STATUS.TRANSFERRING;
    if (canExpire && hold.expiresAt && Date.parse(hold.expiresAt) <= now) {
      expiredDuringAudit.push(hold.id);
    }
  }
  if (expiredDuringAudit.length > 0) {
    const { expired } = sweepExpired(state, { now });
    snapshot.deferredExpirationHoldIds = expired.map((hold) => hold.id);
    for (const hold of expired) {
      snapshot.anomalies.push({
        code: 'EXPIRED_DURING_AUDIT',
        holdId: hold.id,
        message: `占位 ${hold.id} 在盘点冻结期间到期，解冻后已显式标记失效并归还容量。`
      });
    }
  }

  snapshot.status = 'finalized';
  snapshot.finalizedAt = new Date(now).toISOString();
  appendAudit(state, 'snapshot-finalize', {
    now,
    snapshotId: snapshot.id,
    detail: { anomalies: snapshot.anomalies.length, expired: snapshot.deferredExpirationHoldIds.length }
  });
  bumpRevision(state);
  return structuredClone(snapshot);
}

export function publicWarehouseState(state) {
  const clone = structuredClone(state);
  const occupancy = getOccupancy(state);
  return {
    ...clone,
    occupancy,
    available: {
      weightKg: round1(Math.max(0, state.capacity.weightKg - occupancy.weightKg)),
      slots: Math.max(0, state.capacity.slots - occupancy.slots)
    },
    activeHoldIds: getActiveHolds(state).map((hold) => hold.id),
    activeAuditSnapshot: getOpenSnapshot(state)
  };
}

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}
