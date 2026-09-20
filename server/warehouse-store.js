import fs from 'node:fs';
import path from 'node:path';
import {
  WAREHOUSE_VERSION,
  WAREHOUSE_CAPACITY,
  WAREHOUSE_PHASE,
  HOLD_STATUS,
  createWarehouseState
} from './warehouse.js';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIsoDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function hasValidHold(hold) {
  if (!isPlainObject(hold)) return false;
  return (
    typeof hold.id === 'string' &&
    typeof hold.letterId === 'string' &&
    (hold.kind === 'staging' || hold.kind === 'transfer') &&
    typeof hold.sourceIslandId === 'string' &&
    (hold.destinationIslandId === null || typeof hold.destinationIslandId === 'string') &&
    Number.isFinite(hold.weightKg) && hold.weightKg > 0 &&
    Object.values(HOLD_STATUS).includes(hold.status) &&
    isIsoDate(hold.createdAt) &&
    (hold.expiresAt === null || isIsoDate(hold.expiresAt)) &&
    (hold.committedAt === null || isIsoDate(hold.committedAt)) &&
    (hold.releasedAt === null || isIsoDate(hold.releasedAt)) &&
    (hold.reason === null || typeof hold.reason === 'string')
  );
}

function hasValidSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) return false;
  return (
    typeof snapshot.id === 'string' &&
    (snapshot.status === 'open' || snapshot.status === 'finalized') &&
    isIsoDate(snapshot.startedAt) &&
    (snapshot.finalizedAt === null || isIsoDate(snapshot.finalizedAt)) &&
    isPlainObject(snapshot.baseline) &&
    Number.isFinite(snapshot.baseline.weightKg) &&
    Number.isInteger(snapshot.baseline.slots) &&
    Array.isArray(snapshot.manifestHoldIds) &&
    snapshot.manifestHoldIds.every((id) => typeof id === 'string') &&
    Array.isArray(snapshot.deferredExpirationHoldIds) &&
    Array.isArray(snapshot.anomalies)
  );
}

function hasValidAudit(entry) {
  return isPlainObject(entry) &&
    Number.isInteger(entry.seq) &&
    typeof entry.action === 'string' &&
    isIsoDate(entry.at) &&
    (entry.holdId === null || typeof entry.holdId === 'string') &&
    (entry.snapshotId === null || typeof entry.snapshotId === 'string');
}

function hasValidWarehouseShape(state) {
  if (!isPlainObject(state)) return false;
  if (state.version !== WAREHOUSE_VERSION) return false;
  if (state.phase !== WAREHOUSE_PHASE.OPEN && state.phase !== WAREHOUSE_PHASE.AUDITING) return false;
  if (!isPlainObject(state.capacity)) return false;
  if (!Number.isFinite(state.capacity.weightKg) || state.capacity.weightKg <= 0) return false;
  if (!Number.isInteger(state.capacity.slots) || state.capacity.slots <= 0) return false;
  if (!Array.isArray(state.holds) || !state.holds.every(hasValidHold)) return false;
  if (!Array.isArray(state.snapshots) || !state.snapshots.every(hasValidSnapshot)) return false;
  if (!Array.isArray(state.audit) || !state.audit.every(hasValidAudit)) return false;
  if (!Number.isInteger(state.holdSeq) || !Number.isInteger(state.snapshotSeq) || !Number.isInteger(state.auditSeq)) return false;
  if (!Number.isInteger(state.revision) || state.revision < 0) return false;

  const holdIds = state.holds.map((hold) => hold.id);
  if (new Set(holdIds).size !== holdIds.length) return false;

  const openSnapshots = state.snapshots.filter((snapshot) => snapshot.status === 'open');
  if (openSnapshots.length > 1) return false;
  if (openSnapshots.length === 1 && state.phase !== WAREHOUSE_PHASE.AUDITING) return false;
  if (openSnapshots.length === 0 && state.phase === WAREHOUSE_PHASE.AUDITING) return false;

  for (const holdId of openSnapshots.flatMap((snapshot) => snapshot.manifestHoldIds)) {
    if (!holdIds.includes(holdId)) return false;
  }
  return true;
}

export class WarehouseStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.options = options;
    this.state = null;
    this.recovery = null;
  }

  load() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      this.recovery = null;
      const initialState = createWarehouseState(this.options);
      try {
        this.state = initialState;
        this.save();
      } catch (error) {
        this.state = null;
        throw error;
      }
      return this.getState();
    }

    const rawState = fs.readFileSync(this.filePath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(rawState);
      if (!hasValidWarehouseShape(parsed)) {
        throw new Error('中转仓存档结构不完整或版本不受支持');
      }
    } catch (error) {
      return this.recoverCorruptState(error);
    }

    this.state = parsed;
    this.recovery = null;
    return this.getState();
  }

  recoverCorruptState(error) {
    let backupPath = `${this.filePath}.corrupt-${Date.now()}`;
    let suffix = 1;
    while (fs.existsSync(backupPath)) {
      backupPath = `${this.filePath}.corrupt-${Date.now()}-${suffix}`;
      suffix += 1;
    }

    fs.renameSync(this.filePath, backupPath);
    const recoveredState = createWarehouseState({
      ...this.options,
      capacity: this.options.capacity || WAREHOUSE_CAPACITY
    });
    this.recovery = {
      reason: `中转仓存档无法读取，已备份为 ${path.basename(backupPath)}：${error.message}`
    };
    try {
      this.state = recoveredState;
      this.save();
    } catch (saveError) {
      this.state = null;
      throw saveError;
    }
    return {
      ...this.getState(),
      recovery: structuredClone(this.recovery)
    };
  }

  getState() {
    if (!this.state) this.load();
    return structuredClone(this.state);
  }

  getRecovery() {
    return this.recovery ? structuredClone(this.recovery) : null;
  }

  mutate(mutator) {
    if (!this.state) this.load();
    const previousState = this.state;
    const nextState = structuredClone(this.state);
    const result = mutator(nextState);
    try {
      this.state = nextState;
      this.save();
    } catch (error) {
      this.state = previousState;
      throw error;
    }
    return result === undefined ? undefined : structuredClone(result);
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
      fs.renameSync(temporaryPath, this.filePath);
    } finally {
      if (fs.existsSync(temporaryPath)) {
        try {
          fs.unlinkSync(temporaryPath);
        } catch {
          // 临时文件清理失败不应覆盖原始写入错误。
        }
      }
    }
  }
}
