import { useEffect, useState } from 'react';
import type { Monitor } from '../../shared/types.ts';

export interface MonitorFormValues {
  name: string;
  url: string;
  intervalMinutes: number;
  extractRule: string;
  keyword: string;
  notifyWebhook: string;
  notifyEmail: boolean;
}

export const INTERVALS = [
  { v: 5, l: '每 5 分钟' },
  { v: 10, l: '每 10 分钟' },
  { v: 15, l: '每 15 分钟' },
  { v: 30, l: '每 30 分钟' },
  { v: 60, l: '每小时' },
  { v: 120, l: '每 2 小时' },
  { v: 180, l: '每 3 小时' },
  { v: 360, l: '每 6 小时' },
  { v: 720, l: '每 12 小时' },
  { v: 1440, l: '每天' },
];

export function MonitorFormModal({
  open,
  editing,
  onClose,
  onSubmit,
  busy,
  error,
}: {
  open: boolean;
  editing: Monitor | null;
  onClose: () => void;
  onSubmit: (v: MonitorFormValues) => void;
  busy: boolean;
  error: string | null;
}) {
  const [v, setV] = useState<MonitorFormValues>({
    name: '',
    url: '',
    intervalMinutes: 60,
    extractRule: '',
    keyword: '',
    notifyWebhook: '',
    notifyEmail: false,
  });

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setV({
        name: editing.name,
        url: editing.url,
        intervalMinutes: editing.intervalMinutes,
        extractRule: editing.extractRule,
        keyword: editing.keyword ?? '',
        // 编辑时不回填已脱敏的 webhook，避免把掩码当成真值提交
        notifyWebhook: '',
        notifyEmail: editing.notifyEmail,
      });
    } else {
      setV({ name: '', url: '', intervalMinutes: 60, extractRule: '', keyword: '', notifyWebhook: '', notifyEmail: false });
    }
  }, [open, editing]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="mon-form-title">
        <div className="modal-head">
          <h3 id="mon-form-title">{editing ? '编辑监控' : '添加网页监控'}</h3>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(v);
          }}
        >
          <div className="modal-body">
            <div className="form-grid">
              <div className="field">
                <label htmlFor="f-name">监控名称</label>
                <input
                  id="f-name"
                  type="text"
                  value={v.name}
                  onChange={(e) => setV({ ...v, name: e.target.value })}
                  placeholder="例如：产品定价页"
                  maxLength={80}
                  required
                />
              </div>

              <div className="field">
                <label htmlFor="f-url">网页地址</label>
                <input
                  id="f-url"
                  type="url"
                  value={v.url}
                  onChange={(e) => setV({ ...v, url: e.target.value })}
                  placeholder="https://example.com/pricing"
                  disabled={!!editing}
                  required
                />
                <span className="hint">
                  只支持公开的 HTTP/HTTPS 页面。内网地址、云元数据地址、IP 字面量都会被拒绝。
                  {editing && ' 网址创建后不可修改，需要换地址请新建监控。'}
                </span>
              </div>

              <div className="row-2">
                <div className="field">
                  <label htmlFor="f-interval">检查间隔</label>
                  <select
                    id="f-interval"
                    value={v.intervalMinutes}
                    onChange={(e) => setV({ ...v, intervalMinutes: Number(e.target.value) })}
                  >
                    {INTERVALS.map((i) => (
                      <option key={i.v} value={i.v}>
                        {i.l}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="f-keyword">关键词规则（可选）</label>
                  <input
                    id="f-keyword"
                    type="text"
                    value={v.keyword}
                    onChange={(e) => setV({ ...v, keyword: e.target.value })}
                    placeholder="降价 -售罄"
                    maxLength={200}
                  />
                  <span className="hint">空格分隔多个词；<code>-词</code> 表示排除。</span>
                </div>
              </div>

              <div className="field">
                <label htmlFor="f-rule">内容提取规则（可选）</label>
                <input
                  id="f-rule"
                  type="text"
                  value={v.extractRule}
                  onChange={(e) => setV({ ...v, extractRule: e.target.value })}
                  placeholder="例如：main 或 #content 或 article.post"
                />
                <span className="hint">
                  留空则比对整页正文。支持标签名、<code>#id</code>、<code>.class</code> 与空格后代组合；
                  不支持 CSS 伪类或属性选择器。
                </span>
              </div>

              <div className="field">
                <label htmlFor="f-webhook">Webhook 地址（可选）</label>
                <input
                  id="f-webhook"
                  type="url"
                  value={v.notifyWebhook}
                  onChange={(e) => setV({ ...v, notifyWebhook: e.target.value })}
                  placeholder="https://hooks.example.com/pageradar"
                />
                <span className="hint">
                  内容变化时向该地址 POST JSON。
                  {editing?.notifyWebhook && ` 当前已配置：${editing.notifyWebhook}（留空表示不修改）。`}
                </span>
              </div>

              <label className="check">
                <input
                  type="checkbox"
                  checked={v.notifyEmail}
                  onChange={(e) => setV({ ...v, notifyEmail: e.target.checked })}
                />
                同时记录邮件通知意图（需要服务端配置邮件服务后才会真正发送）
              </label>

              {error && (
                <div className="alert alert--error" role="alert">
                  <span aria-hidden>!</span>
                  <div>{error}</div>
                </div>
              )}
            </div>
          </div>
          <div className="modal-foot">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {busy ? <span className="spinner" /> : null}
              {editing ? '保存修改' : '开始监控'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
