import type { DiffOp } from '../../shared/types.ts';

export interface DiffViewProps {
  ops: DiffOp[];
  mode: 'rich' | 'plain';
  added: number;
  removed: number;
  truncatedNote?: string;
}

/** 富文本模式：新增/删除用不同底色与行首标记。 */
export function DiffView({ ops, mode, added, removed, truncatedNote }: DiffViewProps) {
  const lines: Array<{ type: DiffOp['type']; text: string }> = [];
  for (const op of ops) {
    for (const line of op.text.split('\n')) lines.push({ type: op.type, text: line });
  }

  const shown = lines.slice(0, 1200);
  const clipped = lines.length > shown.length;

  return (
    <div>
      <div className="diff-box" data-testid="diff-box">
        {mode === 'rich' ? (
          shown.map((l, i) => (
            <div className={`diff-line diff-line--${l.type}`} key={i}>
              <span className="diff-gutter" aria-hidden />
              <span className="diff-text">{l.text || ' '}</span>
            </div>
          ))
        ) : (
          <div className="diff-plain">
            {shown.map((l) => `${l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  '}${l.text}`).join('\n')}
          </div>
        )}
        {clipped && (
          <div style={{ padding: '8px 12px', fontSize: 11.5, color: 'var(--faint)' }}>
            差异内容较长，仅显示前 {shown.length} 行。
          </div>
        )}
      </div>
      <div className="diff-meta">
        <span>
          新增 <span className="add">+{added}</span> 字符
        </span>
        <span>
          删除 <span className="del">−{removed}</span> 字符
        </span>
        {truncatedNote && <span>{truncatedNote}</span>}
      </div>
    </div>
  );
}
