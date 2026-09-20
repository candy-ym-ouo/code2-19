import { useEffect, useState } from 'react';
import { warehouseApi } from '../api.js';

const ZONES = [
  { id: 'staging', label: '暂存' },
  { id: 'transit', label: '转运' }
];

const ZONE_LABEL = Object.fromEntries(ZONES.map((zone) => [zone.id, zone.label]));

function CapacityMeter({ metric }) {
  const ratio = Math.min(100, Math.round((metric.used / metric.capacity) * 100));
  const tone = ratio >= 95 ? 'full' : ratio >= 75 ? 'tight' : 'free';
  return (
    <div className={`warehouse-meter ${tone}`}>
      <div className="warehouse-meter-track"><i style={{ width: `${ratio}%` }} /></div>
      <small>{metric.used} / {metric.capacity} kg · 余 {metric.free}</small>
    </div>
  );
}

export default function WarehousePanel({ game }) {
  const [view, setView] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState({ islandId: 'sun', zone: 'staging', weight: 5, reference: '' });

  async function refresh() {
    const { warehouse } = await warehouseApi.get();
    setView(warehouse);
  }

  useEffect(() => {
    refresh().catch((requestError) => setError(requestError.message));
  }, []);

  const islandName = (islandId) => game.islands.find((island) => island.id === islandId)?.name || islandId;

  async function run(action, successMessage) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await refresh();
      if (successMessage) setNotice(successMessage);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  function submitReserve(event) {
    event.preventDefault();
    const weight = Number(form.weight);
    run(
      () => warehouseApi.reserve({
        islandId: form.islandId,
        zone: form.zone,
        weight,
        reference: form.reference || null,
        expectedRevision: view?.revision
      }),
      '占位成功，容量已预留。'
    );
  }

  if (!view) {
    return (
      <section className="panel warehouse-panel" aria-labelledby="warehouse-title">
        <div className="panel-heading compact"><h2 id="warehouse-title">岛屿中转仓</h2></div>
        <p className="warehouse-loading">正在读取台账...</p>
      </section>
    );
  }

  const held = view.heldReservations || [];

  return (
    <section className="panel warehouse-panel" aria-labelledby="warehouse-title">
      <div className="panel-heading compact">
        <div>
          <p className="eyebrow">统一仓容台账</p>
          <h2 id="warehouse-title">岛屿中转仓</h2>
        </div>
        {view.frozen ? (
          <span className="warehouse-badge frozen">盘点中 · 冻结新承诺</span>
        ) : (
          <span className="warehouse-badge open">接收承诺中</span>
        )}
      </div>

      {error && <p className="warehouse-error" role="alert">{error}</p>}
      {notice && <p className="warehouse-notice">{notice}</p>}

      <div className="warehouse-islands">
        {Object.entries(view.islands || {}).map(([islandId, usage]) => (
          <div className="warehouse-island" key={islandId}>
            <h3>{islandName(islandId)}</h3>
            {ZONES.map((zone) => (
              <div className="warehouse-zone" key={zone.id}>
                <span>{zone.label}</span>
                <CapacityMeter metric={usage[zone.id]} />
              </div>
            ))}
          </div>
        ))}
      </div>

      <form className="warehouse-reserve-form" onSubmit={submitReserve}>
        <select
          value={form.islandId}
          disabled={busy || view.frozen}
          onChange={(event) => setForm((current) => ({ ...current, islandId: event.target.value }))}
        >
          {game.islands.filter((island) => island.id !== 'skyport').map((island) => (
            <option key={island.id} value={island.id}>{island.name}</option>
          ))}
        </select>
        <select
          value={form.zone}
          disabled={busy || view.frozen}
          onChange={(event) => setForm((current) => ({ ...current, zone: event.target.value }))}
        >
          {ZONES.map((zone) => <option key={zone.id} value={zone.id}>{zone.label}</option>)}
        </select>
        <input
          type="number"
          min="0.1"
          step="0.1"
          value={form.weight}
          disabled={busy || view.frozen}
          onChange={(event) => setForm((current) => ({ ...current, weight: event.target.value }))}
        />
        <input
          type="text"
          placeholder="关联单号（可选）"
          value={form.reference}
          disabled={busy || view.frozen}
          onChange={(event) => setForm((current) => ({ ...current, reference: event.target.value }))}
        />
        <button type="submit" disabled={busy || view.frozen} title={view.frozen ? '盘点快照期间禁止混入新承诺' : ''}>
          承诺占位
        </button>
      </form>
      {view.frozen && <p className="warehouse-frozen-note">盘点快照 {view.openSnapshot?.id} 进行中，旧占位可继续入库或回滚，但不接收新承诺。</p>}

      <div className="warehouse-holds">
        <h4>生效中的占位 <b>{held.length}</b></h4>
        {held.length === 0 ? <p className="warehouse-empty">当前没有未履约占位。</p> : held.map((hold) => (
          <div className="warehouse-hold" key={hold.id}>
            <div className="warehouse-hold-main">
              <strong>{islandName(hold.islandId)} · {ZONE_LABEL[hold.zone]}</strong>
              <span>{hold.weight} kg{hold.reference ? ` · ${hold.reference}` : ''}</span>
            </div>
            <div className="warehouse-hold-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => run(() => warehouseApi.commit(hold.id, {
                  islandId: hold.islandId,
                  zone: hold.zone,
                  expectedRevision: view.revision
                }), `${hold.id} 已入库。`)}
              >
                入库
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => {
                  const reason = window.prompt('入库失败回滚：请填写原因（将记入审计）', '入库失败');
                  if (reason === null) return;
                  return run(() => warehouseApi.rollback(hold.id, {
                    reason: reason || '入库失败',
                    expectedRevision: view.revision
                  }), `${hold.id} 已回滚释放。`);
                }}
              >
                回滚
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="warehouse-snapshot-actions">
        {view.frozen ? (
          <button
            type="button"
            className="snapshot"
            disabled={busy}
            onClick={() => run(() => warehouseApi.closeSnapshot({ expectedRevision: view.revision }), '盘点完成，快照已对账。')}
          >
            关闭盘点快照并对账
          </button>
        ) : (
          <button
            type="button"
            className="snapshot"
            disabled={busy}
            onClick={() => run(() => warehouseApi.openSnapshot({ expectedRevision: view.revision }), '盘点开始：新承诺已冻结。')}
          >
            开启盘点快照
          </button>
        )}
      </div>
    </section>
  );
}
