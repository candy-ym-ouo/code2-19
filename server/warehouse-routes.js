import { Router } from 'express';
import {
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
  publicWarehouseState
} from './warehouse.js';

function assertExpectedRevision(state, expectedRevision) {
  if (!Number.isInteger(expectedRevision)) {
    const error = new Error('提交中转仓操作时必须提供整数 expectedRevision。');
    error.statusCode = 400;
    throw error;
  }
  if (state.revision !== expectedRevision) {
    const error = new Error('中转仓状态已在其他请求中更新，请刷新后再提交。');
    error.statusCode = 409;
    throw error;
  }
}

function getObject(body) {
  if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('请求体必须是 JSON 对象。');
    error.statusCode = 400;
    throw error;
  }
  return body;
}

export function createWarehouseRouter(warehouseStore) {
  const router = Router();

  router.get('/', (request, response) => {
    const before = warehouseStore.getState();
    const sweep = warehouseStore.mutate((state) => sweepExpired(state));
    const state = publicWarehouseState(warehouseStore.getState());
    const recovery = warehouseStore.getRecovery?.();
    response.json({
      state: recovery ? { ...state, recovery } : state,
      sweep: sweep?.expired?.length ? { expired: sweep.expired } : null,
      swept: before.revision !== state.revision
    });
  });

  router.post('/inbound/stage', (request, response) => {
    const body = getObject(request.body);
    assertExpectedRevision(warehouseStore.getState(), body.expectedRevision);
    const hold = warehouseStore.mutate((state) => stageInbound(state, {
      letterId: body.letterId,
      sourceIslandId: body.sourceIslandId,
      weightKg: body.weightKg
    }));
    response.status(201).json({ hold, state: publicWarehouseState(warehouseStore.getState()) });
  });

  router.post('/inbound/commit', (request, response) => {
    const body = getObject(request.body);
    assertExpectedRevision(warehouseStore.getState(), body.expectedRevision);
    const hold = warehouseStore.mutate((state) => commitInbound(state, { holdId: body.holdId }));
    response.json({ hold, state: publicWarehouseState(warehouseStore.getState()) });
  });

  router.post('/inbound/reject', (request, response) => {
    const body = getObject(request.body);
    assertExpectedRevision(warehouseStore.getState(), body.expectedRevision);
    const result = warehouseStore.mutate((state) => rejectInbound(state, {
      holdId: body.holdId,
      reason: typeof body.reason === 'string' && body.reason.trim() ? body.reason : undefined
    }));
    response.json({ ...result, state: publicWarehouseState(warehouseStore.getState()) });
  });

  router.post('/holds/release', (request, response) => {
    const body = getObject(request.body);
    assertExpectedRevision(warehouseStore.getState(), body.expectedRevision);
    const result = warehouseStore.mutate((state) => releaseHold(state, {
      holdId: body.holdId,
      reason: typeof body.reason === 'string' && body.reason.trim() ? body.reason : undefined
    }));
    response.json({ ...result, state: publicWarehouseState(warehouseStore.getState()) });
  });

  router.post('/transfer/reserve', (request, response) => {
    const body = getObject(request.body);
    assertExpectedRevision(warehouseStore.getState(), body.expectedRevision);
    const hold = warehouseStore.mutate((state) => reserveTransfer(state, {
      holdId: body.holdId,
      destinationIslandId: body.destinationIslandId
    }));
    response.json({ hold, state: publicWarehouseState(warehouseStore.getState()) });
  });

  router.post('/transfer/complete', (request, response) => {
    const body = getObject(request.body);
    assertExpectedRevision(warehouseStore.getState(), body.expectedRevision);
    const result = warehouseStore.mutate((state) => completeTransfer(state, { holdId: body.holdId }));
    response.json({ ...result, state: publicWarehouseState(warehouseStore.getState()) });
  });

  router.post('/transfer/fail', (request, response) => {
    const body = getObject(request.body);
    assertExpectedRevision(warehouseStore.getState(), body.expectedRevision);
    const hold = warehouseStore.mutate((state) => failTransfer(state, {
      holdId: body.holdId,
      reason: typeof body.reason === 'string' && body.reason.trim() ? body.reason : undefined
    }));
    response.json({ hold, state: publicWarehouseState(warehouseStore.getState()) });
  });

  router.post('/snapshot/start', (request, response) => {
    const body = getObject(request.body);
    assertExpectedRevision(warehouseStore.getState(), body.expectedRevision);
    const snapshot = warehouseStore.mutate((state) => startSnapshot(state));
    response.status(201).json({ snapshot, state: publicWarehouseState(warehouseStore.getState()) });
  });

  router.post('/snapshot/finalize', (request, response) => {
    const body = getObject(request.body);
    assertExpectedRevision(warehouseStore.getState(), body.expectedRevision);
    const result = warehouseStore.mutate((state) => finalizeSnapshot(state, { snapshotId: body.snapshotId }));
    response.json({ snapshot: result, state: publicWarehouseState(warehouseStore.getState()) });
  });

  return router;
}
