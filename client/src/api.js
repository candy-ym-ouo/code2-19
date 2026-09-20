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

function withRevision(body, expectedRevision) {
  return { ...body, expectedRevision };
}

export const warehouseApi = {
  getState: () => request('/api/warehouse'),
  stage: (payload, expectedRevision) => request('/api/warehouse/inbound/stage', {
    method: 'POST',
    body: JSON.stringify(withRevision(payload, expectedRevision))
  }),
  commit: (holdId, expectedRevision) => request('/api/warehouse/inbound/commit', {
    method: 'POST',
    body: JSON.stringify({ holdId, expectedRevision })
  }),
  reject: (holdId, reason, expectedRevision) => request('/api/warehouse/inbound/reject', {
    method: 'POST',
    body: JSON.stringify({ holdId, reason, expectedRevision })
  }),
  release: (holdId, reason, expectedRevision) => request('/api/warehouse/holds/release', {
    method: 'POST',
    body: JSON.stringify({ holdId, reason, expectedRevision })
  }),
  reserveTransfer: (holdId, destinationIslandId, expectedRevision) => request('/api/warehouse/transfer/reserve', {
    method: 'POST',
    body: JSON.stringify({ holdId, destinationIslandId, expectedRevision })
  }),
  completeTransfer: (holdId, expectedRevision) => request('/api/warehouse/transfer/complete', {
    method: 'POST',
    body: JSON.stringify({ holdId, expectedRevision })
  }),
  failTransfer: (holdId, expectedRevision) => request('/api/warehouse/transfer/fail', {
    method: 'POST',
    body: JSON.stringify({ holdId, expectedRevision })
  }),
  startSnapshot: (expectedRevision) => request('/api/warehouse/snapshot/start', {
    method: 'POST',
    body: JSON.stringify({ expectedRevision })
  }),
  finalizeSnapshot: (snapshotId, expectedRevision) => request('/api/warehouse/snapshot/finalize', {
    method: 'POST',
    body: JSON.stringify({ snapshotId, expectedRevision })
  })
};
