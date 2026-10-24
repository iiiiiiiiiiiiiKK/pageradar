import type { CheckRun, Snapshot } from '../../shared/types.ts';
import { formatTime } from '../format.ts';
import { IconAlert, IconCheck, IconClock } from '../icons.tsx';

export interface TimelineItem {
  id: string;
  at: number;
  kind: 'first' | 'change' | 'nochange' | 'error';
  title: string;
  detail?: string;
}

export function buildTimeline(history: Snapshot[], runs: CheckRun[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const s of history) {
    items.push({
      id: `s-${s.id}`,
      at: s.createdAt,
      kind: s.isFirst ? 'first' : 'change',
      title: s.isFirst ? '首次快照' : '内容发生变化',
      detail: `${s.wordCount} 词${s.changed ? ' · 已生成差异' : ''}`,
    });
  }
  // 只把失败与无变化补进来（避免和历史快照重复）
  for (const r of runs) {
    if (r.status === 'error' || r.status === 'quota-exceeded' || r.status === 'blocked') {
      items.push({
        id: `r-${r.id}`,
        at: r.startedAt,
        kind: 'error',
        title: r.status === 'quota-exceeded' ? '超出配额' : r.status === 'blocked' ? '被 robots.txt 阻止' : '抓取失败',
        detail: r.error ?? undefined,
      });
    }
  }
  return items.sort((a, b) => b.at - a.at).slice(0, 40);
}

export function Timeline({ items }: { items: TimelineItem[] }) {
  if (items.length === 0) {
    return (
      <div className="empty">
        <h3>还没有历史记录</h3>
        <p>第一次检查完成后，时间线会显示每次快照与失败原因。</p>
      </div>
    );
  }
  return (
    <div className="timeline" data-testid="timeline">
      {items.map((it) => (
        <div
          className={`tl-item is-${it.kind === 'nochange' ? '' : it.kind}`}
          key={it.id}
          title={it.detail}
        >
          <div className="tl-time" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {it.kind === 'change' ? <IconClock style={{ width: 13, height: 13, color: 'var(--accent)' }} /> : null}
            {it.kind === 'error' ? <IconAlert style={{ width: 13, height: 13, color: 'var(--del)' }} /> : null}
            {it.kind === 'first' ? <IconCheck style={{ width: 13, height: 13, color: 'var(--ok)' }} /> : null}
            {formatTime(it.at)}
          </div>
          <div className="tl-desc">
            {it.title}
            {it.detail ? ` · ${it.detail}` : ''}
          </div>
        </div>
      ))}
    </div>
  );
}
