import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { advanceDay, GameRuleError, previewPlan, publicGameState } from './engine.js';
import { assertPlanningPhase } from './store.js';
import {
  WarehouseRuleError,
  warehouseView,
  reserveStaging,
  commitInbound,
  rollbackReservation,
  expireReservation,
  openSnapshot,
  closeSnapshot,
  increaseCapacity,
  getReservation
} from './warehouse.js';

function getAssignments(body) {
  if (body === undefined || body === null) {
    throw new GameRuleError('请求体必须是 JSON 对象，并提供 assignments 数组。');
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new GameRuleError('请求体必须是 JSON 对象。');
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'assignments')) {
    throw new GameRuleError('请求体必须提供 assignments 数组。');
  }
  if (!Array.isArray(body.assignments)) {
    throw new GameRuleError('assignments 必须是数组。');
  }
  return body.assignments;
}

function assertExpectedRevision(state, expectedRevision) {
  if (!Number.isInteger(expectedRevision)) {
    throw new GameRuleError('提交游戏进度时必须提供整数 expectedRevision。');
  }
  if (state.revision !== expectedRevision) {
    throw new GameRuleError('游戏进度已在其他请求中更新，请刷新后再提交。', [], 409);
  }
}

export function createApp({ store, clientDist }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (request, response) => {
    const state = store.getState();
    response.json({
      ok: true,
      phase: state.phase,
      day: state.day,
      version: state.version
    });
  });

  app.get('/api/game', (request, response) => {
    const state = publicGameState(store.getState());
    const recovery = store.getRecovery?.();
    response.json({ state: recovery ? { ...state, recovery } : state });
  });

  app.get('/api/warehouse', (request, response) => {
    const state = store.getState();
    response.json({ warehouse: warehouseView(state.warehouse) });
  });

  app.post('/api/game/plan/preview', (request, response) => {
    const state = store.getState();
    assertPlanningPhase(state);
    response.json({ preview: previewPlan(state, getAssignments(request.body)) });
  });

  app.post('/api/game/day/advance', (request, response) => {
    const report = store.mutate((state) => {
      assertPlanningPhase(state);
      assertExpectedRevision(state, request.body?.expectedRevision);
      return advanceDay(state, getAssignments(request.body));
    });
    response.json({
      report,
      state: publicGameState(store.getState())
    });
  });

  app.post('/api/game/reset', (request, response) => {
    const requestedSeed = request.body?.seed;
    const seed = requestedSeed === undefined || requestedSeed === null || requestedSeed === ''
      ? Date.now()
      : String(requestedSeed);
    const state = store.reset(seed);
    response.json({ state: publicGameState(state) });
  });

  // —— 岛屿中转仓：统一暂存/转运容量、占位回滚、盘点快照 ——

  function getJsonBody(request) {
    return request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body
      : {};
  }

  function warehouseMutation(request, response, handler) {
    const result = store.mutate((state) => handler(state, getJsonBody(request)));
    response.json(result);
  }

  app.get('/api/warehouse/reservations/:id', (request, response) => {
    const state = store.getState();
    response.json({ reservation: getReservation(state, request.params.id) });
  });

  app.post('/api/warehouse/reservations', (request, response) => {
    const body = getJsonBody(request);
    if (!body.islandId || !body.zone || !Number.isFinite(body.weight)) {
      throw new WarehouseRuleError('占位必须提供 islandId、zone 与正数 weight。', 'RESERVATION_INPUT_INVALID', 400);
    }
    warehouseMutation(request, response, (state, input) => reserveStaging(state, input));
  });

  app.post('/api/warehouse/reservations/:id/commit', (request, response) => {
    const id = request.params.id;
    warehouseMutation(request, response, (state, input) => commitInbound(state, id, input));
  });

  app.post('/api/warehouse/reservations/:id/rollback', (request, response) => {
    const id = request.params.id;
    warehouseMutation(request, response, (state, input) => rollbackReservation(state, id, input));
  });

  app.post('/api/warehouse/reservations/:id/expire', (request, response) => {
    const id = request.params.id;
    warehouseMutation(request, response, (state, input) => expireReservation(state, id, input));
  });

  app.post('/api/warehouse/snapshots/open', (request, response) => {
    warehouseMutation(request, response, (state, input) => openSnapshot(state, input));
  });

  app.post('/api/warehouse/snapshots/close', (request, response) => {
    warehouseMutation(request, response, (state, input) => closeSnapshot(state, input));
  });

  app.post('/api/warehouse/capacity', (request, response) => {
    const body = getJsonBody(request);
    if (!body.zone || !Number.isFinite(body.capacity)) {
      throw new WarehouseRuleError('扩容必须提供 zone 与正数 capacity。', 'CAPACITY_INPUT_INVALID', 400);
    }
    warehouseMutation(request, response, (state, input) => (
      increaseCapacity(state, input.zone, input.capacity, { expectedRevision: input.expectedRevision })
    ));
  });

  app.use('/api', (request, response) => {
    response.status(404).json({ error: '接口不存在。' });
  });

  if (clientDist && fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.use((request, response, next) => {
      if (request.method !== 'GET') return next();
      response.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    const statusCode = error.statusCode || 500;
    if (statusCode >= 500) console.error(error);
    response.status(statusCode).json({
      error: error.message || '服务器发生未知错误。',
      issues: error.issues || undefined,
      code: error.code || undefined
    });
  });

  return app;
}
