async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `请求失败（${response.status}）`);
    error.status = response.status;
    error.issues = body.issues || [];
    throw error;
  }
  return body;
}

export const gameApi = {
  getState: () => request('/api/game'),
  preview: (assignments) => request('/api/game/plan/preview', {
    method: 'POST',
    body: JSON.stringify({ assignments })
  }),
  advance: (assignments, expectedRevision) => request('/api/game/day/advance', {
    method: 'POST',
    body: JSON.stringify({ assignments, expectedRevision })
  }),
  reset: (seed) => request('/api/game/reset', {
    method: 'POST',
    body: JSON.stringify(seed === undefined || seed === null ? {} : { seed })
  })
};

function warehouseRequest(path, body) {
  return request(path, {
    method: 'POST',
    body: JSON.stringify(body ?? {})
  });
}

export const warehouseApi = {
  get: () => request('/api/warehouse'),
  reserve: (input) => warehouseRequest('/api/warehouse/reservations', input),
  commit: (id, input) => warehouseRequest(`/api/warehouse/reservations/${id}/commit`, input),
  rollback: (id, input) => warehouseRequest(`/api/warehouse/reservations/${id}/rollback`, input),
  expire: (id, input) => warehouseRequest(`/api/warehouse/reservations/${id}/expire`, input),
  openSnapshot: (input) => warehouseRequest('/api/warehouse/snapshots/open', input),
  closeSnapshot: (input) => warehouseRequest('/api/warehouse/snapshots/close', input),
  increaseCapacity: (zone, capacity, expectedRevision) => warehouseRequest('/api/warehouse/capacity', {
    zone,
    capacity,
    expectedRevision
  })
};
