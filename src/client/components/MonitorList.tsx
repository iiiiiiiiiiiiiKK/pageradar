import type { Monitor } from '../../shared/types.ts';
import { formatIn, formatTime, hostOf, intervalLabel, pathOf } from '../format.ts';

const STATUS_META: Record<string, { label: string; cls: string; dot: string }> = {
  changed: { label: '有变化', cls: 'badge--changed', dot: 'dot-changed' },
  nochange: { label: '无变化', cls: 'badge--ok', dot: 'dot-ok' },
  ok: { label: '正常', cls: 'badge--ok', dot: 'dot-ok' },
  first: { label: '首次快照', cls: 'badge--ok', dot: 'dot-ok' },
  error: { label: '抓取失败', cls: 'badge--error', dot: 'dot-error' },
  paused: { label: '已暂停', cls: 'badge--warn', dot: 'dot-paused' },
};

export function statusMeta(m: Monitor): { label: string; cls: string; dot: string } {
  if (m.paused) return STATUS_META.paused;
  if (!m.lastStatus) return { label: '等待首次检查', cls: 'badge--idle', dot: 'dot-idle' };
  return STATUS_META[m.lastStatus] ?? STATUS_META.error;
}

export function MonitorList({
  monitors,
  activeId,
  onSelect,
  onAdd,
  loading,
}: {
  monitors: Monitor[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  loading: boolean;
}) {
  return (
    <section className="panel" aria-labelledby="mon-list-title">
      <div className="panel-head">
        <h2 id="mon-list-title">监控列表</h2>
        <span className="count">{monitors.length}</span>
        <div className="panel-actions">
          <button className="btn btn--sm btn--primary" onClick={onAdd} data-testid="add-monitor">
            + 添加
          </button>
        </div>
      </div>
      {loading ? (
        <div className="panel-body" style={{ display: 'grid', gap: 8 }}>
          <div className="skeleton" style={{ width: '70%' }} />
          <div className="skeleton" style={{ width: '50%' }} />
          <div className="skeleton" style={{ width: '80%' }} />
        </div>
      ) : monitors.length === 0 ? (
        <div className="empty">
          <h3>还没有监控</h3>
          <p>添加一个公开网页，PageRadar 会按你设定的间隔在服务端定时检查内容变化。</p>
        </div>
      ) : (
        <div className="mon-list" role="list">
          {monitors.map((m) => {
            const st = statusMeta(m);
            return (
              <button
                key={m.id}
                className={`mon-item${activeId === m.id ? ' is-active' : ''}`}
                onClick={() => onSelect(m.id)}
                role="listitem"
                data-testid="monitor-item"
                aria-current={activeId === m.id}
              >
                <span className="mon-item-title">
                  <span className={`status-dot ${st.dot}`} aria-hidden />
                  <span>{m.name}</span>
                </span>
                <span className="mon-item-url" title={m.url}>
                  {hostOf(m.url)}
                  <span style={{ opacity: 0.7 }}>{pathOf(m.url)}</span>
                </span>
                <span className="mon-item-meta">
                  <span className={`badge ${st.cls}`}>{st.label}</span>
                  <span>{intervalLabel(m.intervalMinutes)}</span>
                  <span>·</span>
                  <span>{m.paused ? '已暂停' : `下次 ${formatIn(m.nextCheckAt)}`}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function MonitorSummary({ m }: { m: Monitor }) {
  const st = statusMeta(m);
  return (
    <div style={{ display: 'grid', gap: 6, fontSize: 12.5 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className={`badge ${st.cls}`}>{st.label}</span>
        <span style={{ color: 'var(--faint)' }}>最近检查 {formatTime(m.lastCheckAt)}</span>
      </div>
      <dl className="kv" style={{ gridTemplateColumns: '84px 1fr' }}>
        <dt>上次成功</dt>
        <dd>{formatTime(m.lastSuccessAt)}</dd>
        <dt>下次检查</dt>
        <dd>{m.paused ? '已暂停，不会自动执行' : `${formatTime(m.nextCheckAt)}（${formatIn(m.nextCheckAt)}）`}</dd>
        {m.lastError && (
          <>
            <dt>失败原因</dt>
            <dd style={{ color: 'var(--del)' }}>{m.lastError}</dd>
          </>
        )}
        {m.consecutiveFailures > 0 && (
          <>
            <dt>连续失败</dt>
            <dd>{m.consecutiveFailures} 次（下次已自动退避）</dd>
          </>
        )}
        {m.lastHttpStatus && (
          <>
            <dt>HTTP 状态</dt>
            <dd>{m.lastHttpStatus}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
