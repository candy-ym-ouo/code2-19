import { useEffect, useMemo, useState } from 'react';
import { warehouseApi } from '../api.js';

const HOLD_META = {
  staged: { label: '到港暂存', className: 'hold-staged' },
  committed: { label: '在架可转运', className: 'hold-committed' },
  transferring: { label: '转运中', className: 'hold-transferring' },
  rolled_back: { label: '入库回滚', className: 'hold-rolled' },
  released: { label: '已释放', className: 'hold-terminal' },
  transferred: { label: '已转运离场', className: 'hold-terminal' },
  expired: { label: '超时失效', className: 'hold-expired' }
};

const AUDIT_META = {
  stage: '到港暂存',
  commit: '验收入库',
  'rollback-inbound': '入库失败回滚',
  release: '释放占位',
  'transfer-reserve': '申请转运',
  'transfer-complete': '转运完成',
  'transfer-fail-return': '转运失败回仓',
  expire: '超时显式失效',
  'snapshot-start': '盘点开始',
  'snapshot-finalize': '盘点完成'
};

function formatTime(isoString) {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleTimeString('zh-CN', { hour12: false });
}

function HoldRow({ hold, islands, frozen, busy, onAction }) {
  const meta = HOLD_META[hold.status] || { label: hold.status, className: '' };
  const source = islands.find((island) => island.id === hold.sourceIslandId);
  const destination = islands.find((island) => island.id === hold.destinationIslandId);
  const transferTargets = islands.filter((island) => island.id !== 'skyport' && island.id !== hold.sourceIslandId);

  return (
    <li className={`wh-hold ${meta.className}`}>
      <div className="wh-hold-head">
        <code>{hold.id}</code>
        <span className={`wh-hold-status ${meta.className}`}>{meta.label}</span>
        <b>{hold.weightKg.toFixed(1)} kg</b>
      </div>
      <div className="wh-hold-body">
        <span className="wh-hold-letter">{hold.letterId}</span>
        <span>{source?.name || hold.sourceIslandId}{destination ? ` → ${destination.name}` : ''}</span>
        {hold.expiresAt && <span className="wh-hold-expiry">保留至 {formatTime(hold.expiresAt)}</span>}
        {hold.reason && <span className="wh-hold-reason">{hold.reason}</span>}
      </div>
      <div className="wh-hold-actions">
        {hold.status === 'staged' && (
          <>
            <button type="button" className="wh-action primary" disabled={busy || frozen} onClick={() => onAction('commit', hold)}>
              验收入库
            </button>
            <button type="button" className="wh-action danger" disabled={busy || frozen} onClick={() => onAction('reject', hold)}>
              入库失败回滚
            </button>
            <button type="button" className="wh-action" disabled={busy || frozen} onClick={() => onAction('release', hold)}>
              释放
            </button>
          </>
        )}
        {hold.status === 'committed' && (
          <>
            <select
              aria-label={`${hold.id} 转运目标`}
              defaultValue=""
              disabled={busy || frozen}
              onChange={(event) => event.target.value && onAction('reserve', hold, event.target.value)}
            >
              <option value="" disabled>申请转运至…</option>
              {transferTargets.map((island) => (
                <option key={island.id} value={island.id}>{island.name}</option>
              ))}
            </select>
            <button type="button" className="wh-action danger" disabled={busy || frozen} onClick={() => onAction('reject', hold)}>
              残损回滚
            </button>
            <button type="button" className="wh-action" disabled={busy || frozen} onClick={() => onAction('release', hold)}>
              释放
            </button>
          </>
        )}
        {hold.status === 'transferring' && (
          <>
            <button type="button" className="wh-action primary" disabled={busy || frozen} onClick={() => onAction('complete', hold)}>
              确认送达离场
            </button>
            <button type="button" className="wh-action danger" disabled={busy || frozen} onClick={() => onAction('fail', hold)}>
              转运失败回仓
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function StageForm({ islands, frozen, busy, onStage }) {
  const [letterId, setLetterId] = useState('');
  const [sourceIslandId, setSourceIslandId] = useState('sun');
  const [weight, setWeight] = useState(2);
  const targets = islands.filter((island) => island.id !== 'skyport');

  function submit(event) {
    event.preventDefault();
    const trimmed = letterId.trim();
    if (!trimmed) return;
    onStage({ letterId: trimmed, sourceIslandId, weightKg: Number(weight) });
    setLetterId('');
  }

  return (
    <form className="wh-stage-form" onSubmit={submit}>
      <input
        value={letterId}
        onChange={(event) => setLetterId(event.target.value)}
        placeholder="邮件编号，如 L01-03"
        aria-label="邮件编号"
        disabled={busy || frozen}
      />
      <select value={sourceIslandId} onChange={(event) => setSourceIslandId(event.target.value)} disabled={busy || frozen} aria-label="来源岛屿">
        {targets.map((island) => <option key={island.id} value={island.id}>{island.name}</option>)}
      </select>
      <input
        type="number" min="0.1" step="0.1" value={weight}
        onChange={(event) => setWeight(event.target.value)}
        aria-label="重量 kg"
        className="wh-weight-input"
        disabled={busy || frozen}
      />
      <button type="submit" className="wh-action primary" disabled={busy || frozen || !letterId.trim()}>
        到港暂存占位
      </button>
    </form>
  );
}

export default function WarehousePanel({ islands }) {
  const [warehouse, setWarehouse] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function refresh() {
    try {
      const result = await warehouseApi.getState();
      setWarehouse(result.state);
      if (result.sweep?.expired?.length) {
        setNotice(`已将 ${result.sweep.expired.length} 个超时占位显式标记为失效并归还容量。`);
      }
      if (result.state.recovery?.reason) setError(result.state.recovery.reason);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 20 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  const activeHolds = useMemo(
    () => (warehouse?.holds || []).filter((hold) => ['staged', 'committed', 'transferring'].includes(hold.status)),
    [warehouse]
  );
  const recentHolds = useMemo(
    () => (warehouse?.holds || []).filter((hold) => !['staged', 'committed', 'transferring'].includes(hold.status)).slice(-8).reverse(),
    [warehouse]
  );
  const recentAudit = useMemo(() => (warehouse?.audit || []).slice(-10).reverse(), [warehouse]);
  const openSnapshot = warehouse?.activeAuditSnapshot || null;
  const frozen = warehouse?.phase === 'auditing';

  async function run(requestFactory, successMessage) {
    setBusy(true);
    setError('');
    try {
      const result = await requestFactory();
      setWarehouse(result.state);
      if (successMessage) setNotice(successMessage);
    } catch (requestError) {
      if (requestError.status === 409) {
        await refresh();
      }
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  function handleStage(payload) {
    run(
      () => warehouseApi.stage(payload, warehouse.revision),
      `邮件 ${payload.letterId} 已暂存占位（${payload.weightKg} kg）。`
    );
  }

  function handleAction(action, hold, destinationIslandId) {
    const revision = warehouse.revision;
    switch (action) {
      case 'commit':
        run(() => warehouseApi.commit(hold.id, revision), `${hold.id} 已验收入库。`);
        break;
      case 'reject':
        run(() => warehouseApi.reject(hold.id, '入库验收失败', revision), `${hold.id} 入库失败，占位已回滚。`);
        break;
      case 'release':
        run(() => warehouseApi.release(hold.id, '调度台主动释放', revision), `${hold.id} 已释放，容量归还。`);
        break;
      case 'reserve':
        run(() => warehouseApi.reserveTransfer(hold.id, destinationIslandId, revision), `${hold.id} 已申请转运，容量离场前继续占用。`);
        break;
      case 'complete':
        run(() => warehouseApi.completeTransfer(hold.id, revision), `${hold.id} 已送达离场，容量归还。`);
        break;
      case 'fail':
        run(() => warehouseApi.failTransfer(hold.id, revision), `${hold.id} 转运失败，货物已回仓。`);
        break;
      default:
        break;
    }
  }

  function startAudit() {
    run(() => warehouseApi.startSnapshot(warehouse.revision), '盘点快照已开始，仓位冻结。');
  }

  function finishAudit() {
    run(
      () => warehouseApi.finalizeSnapshot(openSnapshot.id, warehouse.revision),
      '盘点完成，仓位已解冻。'
    );
  }

  if (!warehouse) {
    return (
      <section className="panel warehouse-panel" aria-labelledby="warehouse-title">
        <div className="panel-heading"><h2 id="warehouse-title">岛屿中转仓</h2></div>
        <p className="empty-lane">正在读取仓位…</p>
      </section>
    );
  }

  const weightPercent = Math.min(100, warehouse.occupancy.weightKg / warehouse.capacity.weightKg * 100);
  const slotsPercent = Math.min(100, warehouse.occupancy.slots / warehouse.capacity.slots * 100);

  return (
    <section className="panel warehouse-panel" aria-labelledby="warehouse-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">统一暂存 · 转运容量池</p>
          <h2 id="warehouse-title">岛屿中转仓</h2>
        </div>
        {frozen ? (
          <span className="wh-frozen-badge">盘点冻结中</span>
        ) : (
          <button type="button" className="wh-action" disabled={busy} onClick={startAudit}>开始盘点快照</button>
        )}
      </div>

      {frozen && (
        <div className="wh-audit-banner" role="alert">
          <div>
            <strong>{openSnapshot.id} 盘点进行中</strong>
            <span>基线 {openSnapshot.baseline.weightKg} kg / {openSnapshot.baseline.slots} 位 · 禁止混入新承诺</span>
          </div>
          <button type="button" className="wh-action primary" disabled={busy} onClick={finishAudit}>核对完成并解冻</button>
        </div>
      )}

      {error && <div className="wh-message danger" role="alert">{error}</div>}
      {!error && notice && <div className="wh-message info">{notice}</div>}

      <div className="wh-capacity">
        <div className="wh-capacity-row">
          <span>承重 {warehouse.occupancy.weightKg} / {warehouse.capacity.weightKg} kg</span>
          <div className={`capacity-track ${weightPercent >= 100 ? 'full' : ''}`}><i style={{ width: `${weightPercent}%` }} /></div>
          <b>{Math.round(weightPercent)}%</b>
        </div>
        <div className="wh-capacity-row">
          <span>暂存位 {warehouse.occupancy.slots} / {warehouse.capacity.slots} 位</span>
          <div className={`capacity-track ${slotsPercent >= 100 ? 'full' : ''}`}><i style={{ width: `${slotsPercent}%` }} /></div>
          <b>{Math.round(slotsPercent)}%</b>
        </div>
      </div>

      <StageForm islands={islands} frozen={frozen} busy={busy} onStage={handleStage} />

      <h3 className="wh-section-title">在仓占位 <b>{activeHolds.length}</b></h3>
      {activeHolds.length === 0 ? (
        <p className="empty-lane">暂无暂存或转运中的货物。</p>
      ) : (
        <ul className="wh-hold-list">
          {activeHolds.map((hold) => (
            <HoldRow key={hold.id} hold={hold} islands={islands} frozen={frozen} busy={busy} onAction={handleAction} />
          ))}
        </ul>
      )}

      {recentHolds.length > 0 && (
        <>
          <h3 className="wh-section-title">已结清占位</h3>
          <ul className="wh-history-list">
            {recentHolds.map((hold) => (
              <li key={hold.id}>
                <code>{hold.id}</code>
                <span>{(HOLD_META[hold.status] || {}).label || hold.status}</span>
                <span>{hold.letterId}</span>
                <small>{hold.reason || ''}</small>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 className="wh-section-title">审计留痕</h3>
      <ol className="wh-audit-list">
        {recentAudit.map((entry) => (
          <li key={entry.seq}>
            <time>{formatTime(entry.at)}</time>
            <span>{AUDIT_META[entry.action] || entry.action}</span>
            {entry.holdId && <code>{entry.holdId}</code>}
            {entry.snapshotId && <code>{entry.snapshotId}</code>}
            {entry.detail?.reason && <small>{entry.detail.reason}</small>}
            {entry.detail?.anomalies > 0 && <small className="wh-anomaly-tag">{entry.detail.anomalies} 项异常</small>}
          </li>
        ))}
      </ol>
    </section>
  );
}
