import { useEffect, useMemo, useState } from 'react';
import { api, api as apiClient, ApiRequestError, clearSession, getWorkspace, saveSession, type StoredWorkspace } from './api.ts';
import { MonitorList, MonitorSummary, statusMeta } from './components/MonitorList.tsx';
import { MonitorFormModal, type MonitorFormValues } from './components/MonitorFormModal.tsx';
import { DiffView } from './components/DiffView.tsx';
import { Timeline, buildTimeline } from './components/Timeline.tsx';
import { IconAlert, IconCheck, IconClock, IconEdit, IconGithub, IconLink, IconMoon, IconPause, IconPlay, IconPlus, IconRadar, IconRefresh, IconSun, IconTrash, IconX } from './icons.tsx';
import { formatIn, formatTime, intervalLabel } from './format.ts';
import type { Monitor, MonitorDetail, Quota } from '../shared/types.ts';

const AUTHOR_X = 'https://x.com/0xkillcoin';
const REPO_URL = 'https://github.com/iiiiiiiiiiiiiKK/pageradar';

/** 把令牌下载成 txt，方便用户存到本机（比只放剪贴板更可靠）。 */
function downloadToken(token: string): void {
  const ws = getWorkspace();
  const body = [
    'PageRadar 访问令牌',
    '==================',
    '',
    token,
    '',
    '用途：在 PageRadar 首页选择「已有令牌，进入工作区」，粘贴上面这串即可回到你的工作区。',
    `工作区：${ws?.name ?? '（未知）'}（${ws?.tokenPrefix ?? ''}…）`,
    `导出时间：${new Date().toISOString()}`,
    '',
    '请注意：这等价于密码，不要发给别人，也不要提交到公开仓库。',
    '如果丢失，我们无法帮你找回（服务端只保存哈希）。',
  ].join('\n');
  const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pageradar-token-${(ws?.tokenPrefix ?? 'workspace').replace(/[^\w-]/g, '')}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type Tab = 'overview' | 'diff' | 'history';

export default function App() {
  const [booting, setBooting] = useState(true);
  const [ws, setWs] = useState<StoredWorkspace | null>(null);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MonitorDetail | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [diffMode, setDiffMode] = useState<'rich' | 'plain'>('rich');
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Monitor | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>('system');
  const [toasts, setToasts] = useState<Array<{ id: string; text: string; tone: string }>>([]);

  /* 进入方式：已有令牌 / 新建工作区 */
  const [entryTab, setEntryTab] = useState<'restore' | 'create'>('restore');
  const [tokenInput, setTokenInput] = useState('');
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  /* 演示数据 */
  const [demoBusy, setDemoBusy] = useState(false);
  const demoCount = monitors.filter((m) => m.isDemo).length;

  const toast = (text: string, tone = 'info') => {
    const id = crypto.randomUUID();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  };

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);

  /* ---------- 启动 ---------- */
  useEffect(() => {
    const stored = getWorkspace();
    setWs(stored);
    if (stored) void loadList();
    else setBooting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadList = async () => {
    try {
      const r = await api.listMonitors();
      setMonitors(r.monitors);
      setQuota(r.quota);
      setGlobalError(null);
      setActiveId((prev) => prev ?? r.monitors[0]?.id ?? null);
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 401) {
        clearSession();
        setWs(null);
        setGlobalError('访问令牌已失效，请重新创建工作区。');
      } else {
        setGlobalError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBooting(false);
    }
  };

  /* ---------- 详情 ---------- */
  useEffect(() => {
    if (!activeId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    api
      .getMonitor(activeId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        if (!cancelled) setGlobalError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  /* ---------- 创建 / 编辑 ---------- */
  const submitForm = async (v: MonitorFormValues) => {
    setFormBusy(true);
    setFormError(null);
    try {
      if (editing) {
        const patch: Record<string, unknown> = {
          name: v.name,
          intervalMinutes: v.intervalMinutes,
          extractRule: v.extractRule,
          keyword: v.keyword,
          notifyEmail: v.notifyEmail,
        };
        if (v.notifyWebhook.trim()) patch.notifyWebhook = v.notifyWebhook.trim();
        await api.updateMonitor(editing.id, patch);
        toast('监控已更新', 'ok');
      } else {
        const r = await api.createMonitor({
          name: v.name,
          url: v.url,
          intervalMinutes: v.intervalMinutes,
          extractRule: v.extractRule,
          keyword: v.keyword,
          notifyWebhook: v.notifyWebhook.trim() || undefined,
          notifyEmail: v.notifyEmail,
        });
        setActiveId(r.monitor.id);
        toast('监控已创建，首次检查马上开始', 'ok');
      }
      setFormOpen(false);
      setEditing(null);
      await loadList();
      if (editing) setActiveId(editing.id);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setFormBusy(false);
    }
  };

  /* ---------- 操作 ---------- */
  const checkNow = async () => {
    if (!detail) return;
    setChecking(true);
    try {
      const r = await api.checkNow(detail.monitor.id);
      const st = r.result.status;
      toast(
        st === 'nochange'
          ? '检查完成：内容没有变化'
          : st === 'first'
            ? '检查完成：已保存首次快照'
            : st === 'changed'
              ? '检查完成：内容有变化'
              : `检查失败：${r.result.error ?? '未知原因'}`,
        st === 'error' ? 'error' : 'ok',
      );
      const d = await api.getMonitor(detail.monitor.id);
      setDetail(d);
      await loadList();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setChecking(false);
    }
  };

  const togglePause = async () => {
    if (!detail) return;
    try {
      await api.updateMonitor(detail.monitor.id, { paused: !detail.monitor.paused });
      const d = await api.getMonitor(detail.monitor.id);
      setDetail(d);
      await loadList();
      toast(d.monitor.paused ? '已暂停监控' : '已恢复监控', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const remove = async () => {
    if (!detail) return;
    if (!window.confirm(`确定删除「${detail.monitor.name}」？历史快照会一并删除，无法恢复。`)) return;
    try {
      await api.deleteMonitor(detail.monitor.id);
      toast('监控已删除', 'ok');
      setActiveId(null);
      setDetail(null);
      await loadList();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const createWorkspace = async () => {
    setCreating(true);
    setGlobalError(null);
    try {
      const r = await apiClient.createWorkspace();
      saveSession(r.token, r.workspace);
      setWs(r.workspace);
      setNewToken(r.token);
      await loadList();
    } catch (e) {
      setGlobalError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const leave = () => {
    if (!window.confirm('退出工作区会清除本地保存的访问令牌。\n\n如果你还没把令牌存到别处，退出后就无法再进入这个工作区了。要继续吗？')) return;
    clearSession();
    setWs(null);
    setDetail(null);
    setMonitors([]);
    setNewToken(null);
    setEntryTab('restore');
    setTokenInput('');
    setTokenError(null);
  };

  /** 用已有令牌重新进入工作区。 */
  const restoreSession = async () => {
    const token = tokenInput.trim();
    if (!token) return;
    setRestoring(true);
    setTokenError(null);
    try {
      const r = await apiClient.restoreSession(token);
      saveSession(token, r.workspace);
      setWs(r.workspace);
      setTokenInput('');
      await loadList();
      toast('已回到你的工作区', 'ok');
    } catch (e) {
      setTokenError(e instanceof Error ? e.message : String(e));
    } finally {
      setRestoring(false);
    }
  };

  /** 加载演示数据：创建 3 个带说明的演示监控，用户可以照着改成自己的。 */
  const loadDemo = async () => {
    setDemoBusy(true);
    try {
      const r = await api.loadDemoData();
      await loadList();
      toast(
        r.created > 0
          ? `已创建 ${r.created} 个演示监控。建议先点第一个，再点「立即检查」看看效果。`
          : '演示监控已存在，无需重复创建。',
        r.created > 0 ? 'ok' : 'info',
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setDemoBusy(false);
    }
  };

  const clearDemo = async () => {
    if (!window.confirm('清除全部演示监控及其快照？你自己添加的监控不受影响。')) return;
    setDemoBusy(true);
    try {
      const r = await api.clearDemoData();
      await loadList();
      toast(`已清除 ${r.removed} 个演示监控`, 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setDemoBusy(false);
    }
  };

  /** 令牌帮助：解释去哪里找令牌，以及丢了怎么办。 */
  const showTokenHint = () => {
    window.alert(
      [
        '令牌在哪里？',
        '',
        '① 创建或进入工作区后，在「监控总览」右上角点「令牌在哪？」——这里只是帮助，不是令牌本身。',
        '② 令牌明文只在两个地方出现过：创建工作区时的提示面板，以及你自己复制/下载保存的文件。',
        '③ 如果你当时点了「下载为 txt」，它会保存在浏览器的下载文件夹里，文件名以 pageradar-token- 开头。',
        '④ 令牌也保存在当前浏览器的 localStorage 里，所以同一浏览器下次打开会自动进入，不需要手动粘贴。',
        '',
        '如果我彻底找不到令牌了怎么办？',
        '服务端只保存令牌的哈希，无法还原、无法重置、没有找回入口——这是「无账号体系」的必然代价。',
        '你可以新建一个工作区重新开始；旧数据仍然留在数据库里，但没有任何人能再访问它。',
        '',
        `当前工作区：${ws?.name ?? ''}（${ws?.tokenPrefix ?? ''}…）`,
      ].join('\n'),
    );
  };

  const timeline = useMemo(() => (detail ? buildTimeline(detail.history, detail.runs) : []), [detail]);

  /* ---------- 渲染 ---------- */
  return (
    <div className="app">
      <header className="topbar">
        <div className="container topbar-inner">
          <a className="brand" href="./" aria-label="PageRadar 首页">
            <span className="brand-mark" aria-hidden>
              <IconRadar style={{ width: 15, height: 15 }} />
            </span>
            PageRadar
            <span className="brand-sub">网页变更雷达</span>
          </a>
          <div className="spacer" />
          <div className="topbar-actions">
            {ws && quota && <QuotaChip quota={quota} />}
            <button
              className="icon-btn"
              onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark')}
              aria-label="切换主题"
              title="切换主题（系统 / 浅色 / 深色）"
            >
              {theme === 'dark' ? <IconMoon /> : <IconSun />}
            </button>
            <a className="icon-btn" href={REPO_URL} target="_blank" rel="noreferrer noopener" aria-label="GitHub 仓库" title="GitHub 仓库">
              <IconGithub />
            </a>
            <a className="x-link" href={AUTHOR_X} target="_blank" rel="noreferrer noopener" aria-label="作者 X 主页" data-testid="x-link">
              <IconX />
              <span className="x-handle">@0xkillcoin</span>
            </a>
          </div>
        </div>
      </header>

      <main className="container">
        {globalError && (
          <div className="alert alert--error" style={{ marginTop: 14 }} role="alert">
            <IconAlert />
            <div>
              <div className="alert-title">请求出错</div>
              {globalError}
            </div>
          </div>
        )}

        {newToken && (
          <section className="onboard" data-testid="token-panel" style={{ marginTop: 18 }}>
            <h2>先保存这串令牌，否则你以后进不来</h2>
            <p>
              它等价于这个工作区的密码。服务端只保存了它的哈希，<strong>无法再还原明文、也无法重置</strong>。
              退出工作区或换设备时，就是靠它重新进入。
            </p>
            <div className="token-reveal">
              <strong>访问令牌</strong>
              <code data-testid="new-token">{newToken}</code>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              <button
                className="btn btn--primary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(newToken);
                    toast('已复制到剪贴板，建议粘贴到密码管理器或备忘录', 'ok');
                  } catch {
                    toast('浏览器拒绝了剪贴板访问，请手动选中并复制。', 'error');
                  }
                }}
                data-testid="copy-token"
              >
                复制令牌
              </button>
              <button className="btn" onClick={() => void downloadToken(newToken)} data-testid="download-token">
                下载为 txt
              </button>
              <button className="btn" onClick={() => setNewToken(null)} data-testid="token-saved">
                我已保存，进入工作区
              </button>
            </div>
            <p style={{ marginTop: 14, fontSize: 12.5, color: 'var(--faint)' }}>
              令牌同时也保存在当前浏览器的 localStorage 中，同一浏览器下次打开可直接进入。
              但清除浏览器数据后就需要手动粘贴令牌了 —— 所以别只依赖浏览器。
            </p>
          </section>
        )}

        {!ws && !booting && !newToken && (
          <>
            <section className="hero">
              <h1>网页变了，你会比所有人先知道</h1>
              <p>
                PageRadar 在<span style={{ color: 'var(--text)', fontWeight: 600 }}>服务端</span>按你设定的频率抓取公开网页、
                保存快照并计算差异。关掉浏览器它也会继续跑——因为调度发生在 Cloudflare 的定时任务里，不是页面的定时器。
              </p>
            </section>

            <section className="onboard">
              <div className="entry-tabs" role="tablist" aria-label="进入方式">
                <button
                  role="tab"
                  aria-selected={entryTab === 'restore'}
                  className={entryTab === 'restore' ? 'is-on' : ''}
                  onClick={() => setEntryTab('restore')}
                  data-testid="tab-restore"
                >
                  已有令牌，进入工作区
                </button>
                <button
                  role="tab"
                  aria-selected={entryTab === 'create'}
                  className={entryTab === 'create' ? 'is-on' : ''}
                  onClick={() => setEntryTab('create')}
                  data-testid="tab-create"
                >
                  创建新工作区
                </button>
              </div>

              {entryTab === 'restore' ? (
                <div style={{ marginTop: 16 }}>
                  <h2>用令牌重新进入</h2>
                  <p>
                    上次创建或退出工作区时，系统给过你一串以 <code>pr_</code> 开头的令牌。
                    粘贴到下面就能回到原来的工作区——数据都还在，是同一个地方。
                  </p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void restoreSession();
                    }}
                    style={{ marginTop: 14 }}
                  >
                    <div className="field">
                      <label htmlFor="f-token">访问令牌</label>
                      <input
                        id="f-token"
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="pr_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                        value={tokenInput}
                        onChange={(e) => setTokenInput(e.target.value)}
                        data-testid="token-input"
                      />
                      <span className="hint">
                        令牌就是你唯一的凭据，我们不存明文，所以没有办法「找回」或「重置」。
                        如果彻底丢了，只能新建工作区（旧数据会留在数据库里但无法再访问）。
                      </span>
                    </div>
                    {tokenError && (
                      <div className="alert alert--error" style={{ marginTop: 10 }} role="alert" data-testid="token-error">
                        <IconAlert />
                        <div>{tokenError}</div>
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                      <button
                        type="submit"
                        className="btn btn--primary"
                        disabled={restoring || tokenInput.trim() === ''}
                        data-testid="restore-session"
                      >
                        {restoring ? <span className="spinner" /> : <IconLink />}
                        {restoring ? '验证中…' : '进入工作区'}
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => {
                          setEntryTab('create');
                          setTokenError(null);
                        }}
                      >
                        我没有令牌
                      </button>
                    </div>
                  </form>
                </div>
              ) : (
                <div style={{ marginTop: 16 }}>
                  <h2>创建你的工作区</h2>
                  <p>
                    不需要邮箱和密码。点一下就会生成一个 256 位随机令牌，令牌就是你的凭据。
                    <strong> 请务必先复制保存</strong>，因为它只显示一次。
                  </p>
                  <ol className="onboard-steps">
                    <li>
                      点击下方按钮，服务端生成 <strong>256 位随机令牌</strong>（库里只存哈希）
                    </li>
                    <li>
                      把令牌存到密码管理器或文本文件里 —— 之后靠它「进入工作区」
                    </li>
                    <li>可以选择「加载演示数据」，先看懂差异长什么样，再换自己的网址</li>
                  </ol>
                  <button className="btn btn--primary" onClick={createWorkspace} disabled={creating} data-testid="create-workspace">
                    {creating ? <span className="spinner" /> : <IconPlus />}
                    {creating ? '创建中…' : '创建工作区'}
                  </button>
                </div>
              )}

              <p style={{ marginTop: 16, fontSize: 12.5, color: 'var(--faint)' }}>
                使用前请阅读合理使用说明：只监控你有权访问的公开页面，尊重 robots.txt 与网站条款，
                不用于绕过登录、付费墙或验证码。本站不存储任何目标网站的登录凭据。
              </p>
            </section>
          </>
        )}

        {ws && (
          <>
            <section className="hero" style={{ paddingBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <h1 style={{ fontSize: 20 }}>监控总览</h1>
                <span className="badge badge--idle" title={ws.name}>
                  工作区 {ws.tokenPrefix}…
                </span>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button className="btn btn--sm" onClick={loadList} title="刷新列表">
                    <IconRefresh /> 刷新
                  </button>
                  <button className="btn btn--sm btn--ghost" onClick={showTokenHint} title="我该在哪里找到令牌？">
                    令牌在哪？
                  </button>
                  <button className="btn btn--sm btn--ghost" onClick={leave} data-testid="leave-workspace">
                    退出工作区
                  </button>
                </div>
              </div>
            </section>

            {/* 演示数据引导：只在还没加载过演示时有意义 */}
            {demoCount === 0 && monitors.length <= 1 && (
              <section className="demo-banner" data-testid="demo-banner">
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div className="demo-banner-title">第一次用？先加载演示数据看看效果</div>
                  <p>
                    会建 3 个可以直接交互的演示监控（库存价格页、30 秒翻转页、永不变化页），
                    每个都配好了「内容提取规则」和「关键词规则」示例。你照着改网址就能用。
                  </p>
                </div>
                <button className="btn btn--primary" onClick={loadDemo} disabled={demoBusy} data-testid="load-demo">
                  {demoBusy ? <span className="spinner" /> : <IconPlus />}
                  {demoBusy ? '创建中…' : '加载演示数据'}
                </button>
              </section>
            )}

            {demoCount > 0 && (
              <section className="demo-banner demo-banner--active" data-testid="demo-active">
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div className="demo-banner-title">当前有 {demoCount} 个演示监控</div>
                  <p>演示监控名称以「演示 ·」开头。看完就可以清除，不影响你自己添加的监控。</p>
                </div>
                <button className="btn btn--sm" onClick={clearDemo} disabled={demoBusy} data-testid="clear-demo">
                  <IconTrash /> 清除演示数据
                </button>
              </section>
            )}

            <div className="workspace">
              <MonitorList
                monitors={monitors}
                activeId={activeId}
                onSelect={(id) => {
                  setActiveId(id);
                  setTab('overview');
                }}
                onAdd={() => {
                  setEditing(null);
                  setFormError(null);
                  setFormOpen(true);
                }}
                loading={booting}
              />

              <div style={{ display: 'grid', gap: 16, minWidth: 0 }}>
                {!activeId && (
                  <section className="panel">
                    <div className="empty" style={{ padding: '48px 20px' }}>
                      <h3>从左侧选择一个监控，或添加新的网页</h3>
                      <p>添加后会立刻执行一次检查，建立基线快照。之后的变化都会以差异形式保留。</p>
                      <button
                        className="btn btn--primary"
                        style={{ marginTop: 14 }}
                        onClick={() => {
                          setEditing(null);
                          setFormOpen(true);
                        }}
                      >
                        <IconPlus /> 添加第一个监控
                      </button>
                    </div>
                  </section>
                )}

                {activeId && loadingDetail && !detail && (
                  <section className="panel">
                    <div className="panel-body" style={{ display: 'grid', gap: 10 }}>
                      <div className="skeleton" style={{ width: '40%', height: 18 }} />
                      <div className="skeleton" style={{ width: '75%' }} />
                      <div className="skeleton" style={{ width: '60%' }} />
                    </div>
                  </section>
                )}

                {detail && (
                  <>
                    <section className="panel" data-testid="monitor-detail">
                      <div className="detail-head">
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div className="detail-title">{detail.monitor.name}</div>
                          <a className="detail-url" href={detail.monitor.url} target="_blank" rel="noreferrer noopener">
                            {detail.monitor.url}
                          </a>
                        </div>
                        <div className="detail-actions">
                          <button className="btn btn--sm btn--primary" onClick={checkNow} disabled={checking} data-testid="check-now">
                            {checking ? <span className="spinner" /> : <IconRefresh />}
                            {checking ? '检查中…' : '立即检查'}
                          </button>
                          <button className="btn btn--sm" onClick={togglePause} data-testid="toggle-pause">
                            {detail.monitor.paused ? <IconPlay /> : <IconPause />}
                            {detail.monitor.paused ? '恢复' : '暂停'}
                          </button>
                          <button
                            className="btn btn--sm"
                            onClick={() => {
                              setEditing(detail.monitor);
                              setFormError(null);
                              setFormOpen(true);
                            }}
                            data-testid="edit-monitor"
                          >
                            <IconEdit /> 编辑
                          </button>
                          <button className="btn btn--sm btn--danger" onClick={remove} aria-label="删除监控">
                            <IconTrash />
                          </button>
                        </div>
                      </div>

                      <div style={{ padding: '12px 14px', display: 'grid', gap: 12 }}>
                        <div className="stat-grid">
                          <div className="stat">
                            <div className="stat-label">最近检查</div>
                            <div className="stat-value small">{formatTime(detail.monitor.lastCheckAt)}</div>
                            <div className="stat-sub">HTTP {detail.monitor.lastHttpStatus ?? '—'}</div>
                          </div>
                          <div className="stat">
                            <div className="stat-label">上次成功</div>
                            <div className="stat-value small">{formatTime(detail.monitor.lastSuccessAt)}</div>
                            <div className="stat-sub">{detail.monitor.consecutiveFailures > 0 ? `连续失败 ${detail.monitor.consecutiveFailures} 次` : '状态正常'}</div>
                          </div>
                          <div className="stat">
                            <div className="stat-label">下次检查</div>
                            <div className="stat-value small">{detail.monitor.paused ? '已暂停' : formatIn(detail.monitor.nextCheckAt)}</div>
                            <div className="stat-sub">{formatTime(detail.monitor.nextCheckAt)}</div>
                          </div>
                          <div className="stat">
                            <div className="stat-label">检查间隔</div>
                            <div className="stat-value small">{intervalLabel(detail.monitor.intervalMinutes)}</div>
                            <div className="stat-sub">{detail.monitor.extractRule ? `提取：${detail.monitor.extractRule}` : '提取：整页正文'}</div>
                          </div>
                        </div>

                        {detail.monitor.lastError && !detail.monitor.lastStatus?.startsWith('error') && (
                          <div className="alert alert--warn">
                            <IconAlert />
                            <div>
                              <div className="alert-title">最近一次检查有提示</div>
                              {detail.monitor.lastError}
                            </div>
                          </div>
                        )}

                        {detail.monitor.lastStatus === 'error' && (
                          <div className="alert alert--error" data-testid="last-error">
                            <IconAlert />
                            <div>
                              <div className="alert-title">最近一次检查失败</div>
                              {detail.monitor.lastError ?? '未知原因'}
                              {detail.monitor.consecutiveFailures > 1 && ` · 已连续失败 ${detail.monitor.consecutiveFailures} 次，下次检查已自动退避。`}
                            </div>
                          </div>
                        )}

                        {detail.monitor.paused && (
                          <div className="alert alert--warn">
                            <IconPause />
                            <div>
                              <div className="alert-title">该监控已暂停</div>
                              暂停后不会再自动抓取，已有的快照与差异仍然保留。
                            </div>
                          </div>
                        )}

                        {detail.quota.checksUsed >= detail.quota.checksLimit && (
                          <div className="alert alert--error">
                            <IconAlert />
                            <div>
                              <div className="alert-title">今日检查次数已用尽</div>
                              已用 {detail.quota.checksUsed} / {detail.quota.checksLimit} 次。次日 UTC 零点重置。
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="tab-row" role="tablist">
                        <button role="tab" aria-selected={tab === 'overview'} className={tab === 'overview' ? 'is-on' : ''} onClick={() => setTab('overview')}>
                          概览
                        </button>
                        <button role="tab" aria-selected={tab === 'diff'} className={tab === 'diff' ? 'is-on' : ''} onClick={() => setTab('diff')} data-testid="tab-diff">
                          差异查看器
                        </button>
                        <button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'is-on' : ''} onClick={() => setTab('history')}>
                          历史时间线
                        </button>
                      </div>

                      <div className="section-stack">
                        {tab === 'overview' && (
                          <>
                            <MonitorSummary m={detail.monitor} />
                            {detail.latest ? (
                              <div className="alert alert--ok">
                                <IconCheck />
                                <div>
                                  <div className="alert-title">当前快照</div>
                                  采集于 {formatTime(detail.latest.createdAt)} · {detail.latest.wordCount} 词 · 指纹 {detail.latest.contentHash.slice(0, 12)}…
                                </div>
                              </div>
                            ) : (
                              <div className="alert">
                                <IconClock />
                                <div>
                                  <div className="alert-title">还没有快照</div>
                                  点击「立即检查」建立第一份基线快照，或者等待定时任务执行（最多 {detail.monitor.intervalMinutes} 分钟）。
                                </div>
                              </div>
                            )}
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                              <a className="btn btn--sm" href={detail.monitor.url} target="_blank" rel="noreferrer noopener">
                                <IconLink /> 打开原网页
                              </a>
                              <button className="btn btn--sm" onClick={() => setTab('diff')}>
                                查看最近差异
                              </button>
                            </div>
                          </>
                        )}

                        {tab === 'diff' && (
                          <>
                            {!detail.diff ? (
                              <div className="empty">
                                <h3>{detail.latest ? '还没有差异' : '首次快照尚未建立'}</h3>
                                <p>
                                  {detail.latest
                                    ? '当前快照与上一份相同，或者这是第一份快照。等页面内容变化后这里会显示新增与删除的文本。'
                                    : '先执行一次检查，建立基线快照。'}
                                </p>
                              </div>
                            ) : (
                              <>
                                <div className="diff-toolbar">
                                  <div className="seg" role="group" aria-label="差异显示模式">
                                    <button className={diffMode === 'rich' ? 'is-on' : ''} onClick={() => setDiffMode('rich')}>
                                      彩色标记
                                    </button>
                                    <button className={diffMode === 'plain' ? 'is-on' : ''} onClick={() => setDiffMode('plain')} data-testid="diff-plain">
                                      纯文本
                                    </button>
                                  </div>
                                  <span style={{ fontSize: 12, color: 'var(--faint)' }}>
                                    对比 {formatTime(detail.diff.fromSnapshot === detail.diff.toSnapshot ? detail.diff.createdAt : detail.diff.createdAt)} 的快照
                                  </span>
                                </div>
                                <DiffView
                                  ops={detail.diff.ops}
                                  mode={diffMode}
                                  added={detail.diff.added}
                                  removed={detail.diff.removed}
                                />
                              </>
                            )}
                          </>
                        )}

                        {tab === 'history' && (
                          <>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <h4 style={{ fontSize: 13 }}>最近 {detail.history.length} 份快照与失败记录</h4>
                              <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--faint)' }}>
                                保留 {detail.monitor.retentionDays} 天
                              </span>
                            </div>
                            <Timeline items={timeline} />
                            {detail.runs.length > 0 && (
                              <details>
                                <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--muted)' }}>
                                  查看 {detail.runs.length} 条检查记录
                                </summary>
                                <div className="table-scroll" style={{ marginTop: 8 }}>
                                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                    <thead>
                                      <tr style={{ textAlign: 'left', color: 'var(--faint)' }}>
                                        <th style={{ padding: '6px 8px' }}>开始时间</th>
                                        <th style={{ padding: '6px 8px' }}>状态</th>
                                        <th style={{ padding: '6px 8px' }}>HTTP</th>
                                        <th style={{ padding: '6px 8px' }}>耗时</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {detail.runs.map((r) => (
                                        <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                                          <td style={{ padding: '6px 8px' }}>{formatTime(r.startedAt)}</td>
                                          <td style={{ padding: '6px 8px' }}>
                                            <span className={`badge ${r.status === 'changed' ? 'badge--changed' : r.status === 'nochange' || r.status === 'first' ? 'badge--ok' : 'badge--error'}`}>
                                              {r.status}
                                            </span>
                                          </td>
                                          <td style={{ padding: '6px 8px' }}>{r.httpStatus ?? '—'}</td>
                                          <td style={{ padding: '6px 8px' }}>{r.durationMs ? `${r.durationMs} ms` : '—'}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </details>
                            )}
                          </>
                        )}
                      </div>
                    </section>

                    <QuotaPanel quota={detail.quota} monitor={detail.monitor} />
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </main>

      <footer className="footer container">
        <span>PageRadar · 服务端定时网页变化监控</span>
        <span>·</span>
        <span>Cloudflare Workers · D1 · Cron Triggers</span>
        <span>·</span>
        <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
          源码与已知限制
        </a>
        <span>·</span>
        <a href={AUTHOR_X} target="_blank" rel="noreferrer noopener">
          作者 𝕏 @0xkillcoin
        </a>
        <span style={{ marginLeft: 'auto' }}>尊重 robots.txt · 不绕过访问控制</span>
      </footer>

      <MonitorFormModal
        open={formOpen}
        editing={editing}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
        onSubmit={submitForm}
        busy={formBusy}
        error={formError}
      />

      {toasts.length > 0 && (
        <div className="toast-stack" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div className="toast" key={t.id}>
              <span aria-hidden>{t.tone === 'error' ? '✕' : '✓'}</span>
              {t.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function QuotaChip({ quota }: { quota: Quota }) {
  const pct = Math.min(100, Math.round((quota.checksUsed / Math.max(1, quota.checksLimit)) * 100));
  return (
    <span
      className="badge badge--idle hide-sm"
      title={`今日检查 ${quota.checksUsed}/${quota.checksLimit} · 监控 ${quota.monitorsUsed}/${quota.monitorsLimit} · 快照 ${quota.snapshotsUsed}/${quota.snapshotsLimit}`}
    >
      检查 {quota.checksUsed}/{quota.checksLimit}
      <span style={{ width: 34, display: 'inline-block' }}>
        <span className={`quota-bar${pct >= 100 ? ' is-full' : pct >= 80 ? ' is-warn' : ''}`} style={{ marginTop: 0 }}>
          <span style={{ width: `${pct}%` }} />
        </span>
      </span>
    </span>
  );
}

function QuotaPanel({ quota, monitor }: { quota: Quota; monitor: Monitor }) {
  const rows: Array<{ label: string; used: number; limit: number; note: string }> = [
    { label: '今日检查次数', used: quota.checksUsed, limit: quota.checksLimit, note: `统计周期：${quota.period}（UTC）` },
    { label: '监控数量', used: quota.monitorsUsed, limit: quota.monitorsLimit, note: '删除监控可释放额度' },
    { label: '快照存储', used: quota.snapshotsUsed, limit: quota.snapshotsLimit, note: `保留 ${monitor.retentionDays} 天，过期自动清理` },
  ];
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>资源配额</h3>
        <span className="count">免费版</span>
      </div>
      <div className="panel-body" style={{ display: 'grid', gap: 12 }}>
        {rows.map((r) => {
          const pct = Math.min(100, Math.round((r.used / Math.max(1, r.limit)) * 100));
          return (
            <div key={r.label}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
                <span style={{ fontWeight: 600 }}>{r.label}</span>
                <span style={{ color: 'var(--faint)' }}>
                  {r.used} / {r.limit}
                </span>
              </div>
              <div className={`quota-bar${pct >= 100 ? ' is-full' : pct >= 80 ? ' is-warn' : ''}`}>
                <span style={{ width: `${pct}%` }} />
              </div>
              <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 3 }}>{r.note}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export { statusMeta };
