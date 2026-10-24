/**
 * 单次监控检查的核心流程（被 cron 与手动检查共用）。
 *
 * 幂等设计（这是本模块最容易被写错的地方）：
 *   1. 用 (monitor_id, scheduled_at) 唯一索引占位 → 同一时段只处理一次
 *   2. 先写入 run 记录（status=running），再抓取
 *   3. 快照内容哈希与上一次相同 → 不写新快照（避免无变化也堆快照）
 *   4. 通知用 (monitor_id, dedupe_key, channel) 唯一索引去重
 *   5. monitor 结果更新带 version 乐观锁
 */
import { contentHash, diffTexts } from '../diff/diff.ts';
import { extractContent, matchKeyword } from '../extract/html.ts';
import { DEFAULT_FETCH_LIMITS, fetchRobots, robotsAllows, safeFetch, type FetchOutcome } from '../fetch/fetcher.ts';
import {
  bumpCheckCounter,
  commitMonitorResult,
  countSnapshots,
  finishNotification,
  insertDiff,
  insertRun,
  insertSnapshot,
  latestSnapshots,
  pruneSnapshots,
  reserveNotification,
  snapshotsUsed,
  type MonitorRow,
  type SnapshotRow,
  type WorkspaceRow,
} from '../db/queries.ts';
import { sendWebhook } from '../notify/webhook.ts';
import type { CheckRun } from '../../shared/types.ts';

export interface CheckContext {
  db: D1Database;
  workspace: WorkspaceRow;
  monitor: MonitorRow;
  now: number;
  /** 手动检查时为 true；定时为 false。 */
  manual: boolean;
  userAgent: string;
  /** 强制忽略 robots.txt（仅测试环境使用，生产中始终 false）。 */
  ignoreRobots?: boolean;
}

export interface CheckResult {
  ok: boolean;
  status: 'first' | 'changed' | 'nochange' | 'error' | 'skipped';
  error?: string;
  httpStatus?: number;
  snapshotId?: string;
  diffAdded?: number;
  diffRemoved?: number;
  keywordHit?: boolean;
  notified?: 'sent' | 'failed' | 'skipped' | 'deduped';
  durationMs: number;
  quotaExceeded?: boolean;
}

/** 把检查间隔向上取整到调度槽位（分钟），确保同一槽位唯一。 */
export function slotFor(now: number, intervalMinutes: number): number {
  const bucket = Math.max(1, intervalMinutes) * 60_000;
  return Math.floor(now / bucket) * bucket;
}

export function nextCheckFrom(now: number, intervalMinutes: number): number {
  return now + Math.max(1, intervalMinutes) * 60_000;
}

export async function runCheck(ctx: CheckContext): Promise<CheckResult> {
  const started = performance.now();
  const { db, workspace, monitor, now } = ctx;

  // ---- 1) 占位（幂等） ----
  const scheduledAt = ctx.manual ? now : slotFor(now, monitor.interval_minutes);
  const runId = crypto.randomUUID();
  const runRow: CheckRun & { attempt?: number } = {
    id: runId,
    monitorId: monitor.id,
    scheduledAt,
    startedAt: now,
    finishedAt: null,
    status: 'running',
    httpStatus: null,
    error: null,
    durationMs: null,
    snapshotId: null,
    attempt: 1,
  };
  const reserved = await insertRun(db, runRow);
  if (!reserved) {
    return { ok: true, status: 'skipped', durationMs: Math.round(performance.now() - started), error: '该时间点的检查已执行过（防重复保护）。' };
  }

  const finishRun = async (patch: { status: string; httpStatus?: number | null; error?: string | null; snapshotId?: string | null }) => {
    await db
      .prepare('UPDATE check_runs SET status = ?, http_status = ?, error = ?, duration_ms = ?, snapshot_id = ?, finished_at = ? WHERE id = ?')
      .bind(patch.status, patch.httpStatus ?? null, patch.error ?? null, Math.round(performance.now() - started), patch.snapshotId ?? null, Date.now(), runId)
      .run();
  };

  // ---- 2) 配额 ----
  const used = await bumpCheckCounter(db, workspace.id, now);
  if (used > workspace.checks_per_day) {
    const msg = `今日检查次数已达上限（${workspace.checks_per_day} 次）。请等待次日重置或升级配额。`;
    await finishRun({ status: 'quota-exceeded', error: msg });
    await commitMonitorResult(db, monitor.id, monitor.version, {
      nextCheckAt: nextCheckFrom(now, monitor.interval_minutes),
      lastCheckAt: now,
      lastError: msg,
      lastStatus: 'error',
      consecutiveFailures: monitor.consecutive_failures + 1,
    });
    return { ok: false, status: 'error', error: msg, durationMs: Math.round(performance.now() - started), quotaExceeded: true };
  }

  const snapshotsNow = await snapshotsUsed(db, workspace.id);
  if (snapshotsNow >= workspace.snapshots_limit) {
    const msg = `快照存储已达上限（${workspace.snapshots_limit} 个）。请删除部分监控或清理历史。`;
    await finishRun({ status: 'quota-exceeded', error: msg });
    await commitMonitorResult(db, monitor.id, monitor.version, {
      nextCheckAt: nextCheckFrom(now, monitor.interval_minutes),
      lastCheckAt: now,
      lastError: msg,
      lastStatus: 'error',
      consecutiveFailures: monitor.consecutive_failures + 1,
    });
    return { ok: false, status: 'error', error: msg, durationMs: Math.round(performance.now() - started), quotaExceeded: true };
  }

  // ---- 3) robots.txt ----
  let robotsNote = '';
  if (!ctx.ignoreRobots) {
    try {
      const u = new URL(monitor.url);
      const rules = await fetchRobots(u.origin, ctx.userAgent);
      if (!robotsAllows(rules, u.pathname, u.search)) {
        const msg = `该页面被目标站点的 robots.txt 禁止抓取（${u.pathname}）。PageRadar 不会绕过 robots.txt。`;
        await finishRun({ status: 'blocked', httpStatus: null, error: msg });
        await commitMonitorResult(db, monitor.id, monitor.version, {
          nextCheckAt: nextCheckFrom(now, monitor.interval_minutes),
          lastCheckAt: now,
          lastError: msg,
          lastStatus: 'error',
          consecutiveFailures: monitor.consecutive_failures + 1,
        });
        return { ok: false, status: 'error', error: msg, durationMs: Math.round(performance.now() - started) };
      }
      if (rules.crawlDelay && rules.crawlDelay * 60_000 > monitor.interval_minutes * 60_000) {
        robotsNote = `站点要求 crawldelay=${rules.crawlDelay}s，已按较长间隔安排下一次检查。`;
      }
    } catch {
      robotsNote = '';
    }
  }

  // ---- 4) 抓取 ----
  const fetched: FetchOutcome = await safeFetch(monitor.url, DEFAULT_FETCH_LIMITS, {
    userAgent: ctx.userAgent,
  });

  if (!fetched.ok) {
    const failures = monitor.consecutive_failures + 1;
    await finishRun({ status: 'error', httpStatus: fetched.status || null, error: fetched.error ?? '未知错误' });
    // 连续失败时指数退避，最长退到 6 小时，避免无意义地打别人的服务器
    const backoffMinutes = Math.min(360, monitor.interval_minutes * Math.min(8, 2 ** Math.min(failures - 1, 4)));
    await commitMonitorResult(db, monitor.id, monitor.version, {
      nextCheckAt: nextCheckFrom(now, Math.max(monitor.interval_minutes, backoffMinutes)),
      lastCheckAt: now,
      lastError: fetched.error ?? '抓取失败',
      lastStatus: 'error',
      lastHttpStatus: fetched.status || null,
      consecutiveFailures: failures,
    });
    return { ok: false, status: 'error', error: fetched.error, httpStatus: fetched.status, durationMs: Math.round(performance.now() - started) };
  }

  // ---- 5) 正文提取 ----
  let extracted;
  try {
    extracted = extractContent(fetched.html, monitor.extract_rule || undefined);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishRun({ status: 'error', httpStatus: fetched.status, error: `内容提取规则无效：${msg}` });
    await commitMonitorResult(db, monitor.id, monitor.version, {
      nextCheckAt: nextCheckFrom(now, monitor.interval_minutes),
      lastCheckAt: now,
      lastError: `内容提取规则无效：${msg}`,
      lastStatus: 'error',
      lastHttpStatus: fetched.status,
      consecutiveFailures: monitor.consecutive_failures + 1,
    });
    return { ok: false, status: 'error', error: `内容提取规则无效：${msg}`, httpStatus: fetched.status, durationMs: Math.round(performance.now() - started) };
  }

  const text = extracted.text;
  if (!text.trim()) {
    const msg = extracted.selectorMissing
      ? `提取规则「${monitor.extract_rule}」在当前页面没有匹配到任何元素，且页面正文为空。可能页面结构已改变。`
      : '页面提取到的正文为空（可能是纯 JS 渲染，或内容被访问控制挡住）。';
    await finishRun({ status: 'error', httpStatus: fetched.status, error: msg });
    await commitMonitorResult(db, monitor.id, monitor.version, {
      nextCheckAt: nextCheckFrom(now, monitor.interval_minutes),
      lastCheckAt: now,
      lastError: msg,
      lastStatus: 'error',
      lastHttpStatus: fetched.status,
      consecutiveFailures: monitor.consecutive_failures + 1,
    });
    return { ok: false, status: 'error', error: msg, httpStatus: fetched.status, durationMs: Math.round(performance.now() - started) };
  }

  // ---- 6) 与上一次快照比较 ----
  const hash = contentHash(text);
  const [prev] = await latestSnapshots(db, monitor.id, 1);
  const isFirst = !prev;

  if (prev && prev.content_hash === hash) {
    await finishRun({ status: 'nochange', httpStatus: fetched.status });
    await commitMonitorResult(db, monitor.id, monitor.version, {
      nextCheckAt: nextCheckFrom(now, monitor.interval_minutes),
      lastCheckAt: now,
      lastSuccessAt: now,
      lastError: robotsNote || null,
      lastStatus: 'nochange',
      lastHttpStatus: fetched.status,
      consecutiveFailures: 0,
    });
    return { ok: true, status: 'nochange', httpStatus: fetched.status, durationMs: Math.round(performance.now() - started) };
  }

  // ---- 7) 写入新快照 ----
  const snapshotId = crypto.randomUUID();
  const snap: SnapshotRow = {
    id: snapshotId,
    monitor_id: monitor.id,
    created_at: now,
    content_hash: hash,
    text,
    word_count: extracted.wordCount,
    is_first: isFirst ? 1 : 0,
    changed: isFirst ? 0 : 1,
    http_status: fetched.status,
    final_url: fetched.finalUrl,
  };
  await insertSnapshot(db, snap);

  // ---- 8) 差异 ----
  let diffAdded = 0;
  let diffRemoved = 0;
  let diffId: string | null = null;
  if (prev) {
    const d = diffTexts(prev.text, text);
    diffAdded = d.added;
    diffRemoved = d.removed;
    diffId = crypto.randomUUID();
    await insertDiff(db, {
      id: diffId,
      monitor_id: monitor.id,
      from_snapshot: prev.id,
      to_snapshot: snapshotId,
      created_at: now,
      added_chars: d.added,
      removed_chars: d.removed,
      added_lines: d.addedLines,
      removed_lines: d.removedLines,
      ops_json: JSON.stringify(d.ops),
    });
  }

  // ---- 9) 关键词规则 ----
  let keywordHit = false;
  if (monitor.keyword && monitor.keyword.trim()) {
    const r = matchKeyword(text, monitor.keyword);
    keywordHit = r.hit;
  }

  await finishRun({ status: isFirst ? 'first' : 'changed', httpStatus: fetched.status, snapshotId });

  await commitMonitorResult(db, monitor.id, monitor.version, {
    nextCheckAt: nextCheckFrom(now, monitor.interval_minutes),
    lastCheckAt: now,
    lastSuccessAt: now,
    lastError: robotsNote || null,
    lastStatus: isFirst ? 'first' : 'changed',
    lastChangeAt: isFirst ? null : now,
    lastHttpStatus: fetched.status,
    consecutiveFailures: 0,
  });

  // ---- 10) 通知（只在实际变化时） ----
  let notified: CheckResult['notified'] = 'skipped';
  if (diffId && (monitor.notify_webhook || monitor.notify_email)) {
    notified = await notifyChange({
      db,
      monitor,
      diffId,
      added: diffAdded,
      removed: diffRemoved,
      keywordHit,
    });
  }

  // ---- 11) 保留期限清理 ----
  const retention = Math.min(monitor.retention_days, workspace.retention_days);
  const cutoff = now - retention * 24 * 60 * 60 * 1000;
  const total = await countSnapshots(db, monitor.id);
  if (total > 60 || cutoff > 0) {
    await pruneSnapshots(db, monitor.id, cutoff);
  }

  return {
    ok: true,
    status: isFirst ? 'first' : 'changed',
    httpStatus: fetched.status,
    snapshotId,
    diffAdded,
    diffRemoved,
    keywordHit,
    notified,
    durationMs: Math.round(performance.now() - started),
  };
}

async function notifyChange(args: {
  db: D1Database;
  monitor: MonitorRow;
  diffId: string;
  added: number;
  removed: number;
  keywordHit: boolean;
}): Promise<CheckResult['notified']> {
  const { db, monitor, diffId, added, removed, keywordHit } = args;
  let outcome: CheckResult['notified'] = 'skipped';

  if (monitor.notify_webhook) {
    const dedupe = `diff:${diffId}`;
    const reserved = await reserveNotification(db, monitor.id, dedupe, 'webhook');
    if (!reserved) {
      outcome = 'deduped';
    } else {
      const res = await sendWebhook(monitor.notify_webhook, {
        event: 'monitor.changed',
        monitor: { id: monitor.id, name: monitor.name, url: monitor.url },
        change: { addedChars: added, removedChars: removed, keywordHit },
        detectedAt: new Date().toISOString(),
        diffUrl: `${monitor.url}`,
      });
      await finishNotification(db, monitor.id, dedupe, 'webhook', res.ok ? 'sent' : 'failed', res.error ?? null);
      outcome = res.ok ? 'sent' : 'failed';
    }
  }

  if (monitor.notify_email === 1 && outcome === 'skipped') {
    // 邮件通道需要外部服务（Resend / 自建 SMTP），本项目默认不接入，
    // 因此这里明确记录「未配置」而不是假装发送成功。
    const dedupe = `diff:${diffId}`;
    await reserveNotification(db, monitor.id, dedupe, 'email');
    await finishNotification(db, monitor.id, dedupe, 'email', 'skipped', '未配置邮件服务（EMAIL_API_KEY），已跳过。');
    outcome = 'skipped';
  }

  return outcome;
}
