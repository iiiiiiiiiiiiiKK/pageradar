/**
 * 数据访问层：所有 SQL 都在这里，且强制带 workspace_id 过滤。
 *
 * 安全约定（非常重要）：
 *  - 任何按 id 查 monitor 的函数都必须同时传 workspaceId，防止 ID 猜测越权
 *  - 所有写操作使用参数绑定，不拼字符串
 */
import type { CheckRun, DiffRecord, Monitor, Quota, Snapshot } from '../../shared/types.ts';
import type { DiffOp } from '../../shared/types.ts';

export interface WorkspaceRow {
  id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  created_at: number;
  last_seen_at: number | null;
  plan: string;
  monitors_limit: number;
  checks_per_day: number;
  snapshots_limit: number;
  retention_days: number;
}

export interface MonitorRow {
  id: string;
  workspace_id: string;
  name: string;
  url: string;
  url_normalized: string;
  interval_minutes: number;
  extract_rule: string;
  keyword: string | null;
  notify_webhook: string | null;
  notify_email: number;
  paused: number;
  created_at: number;
  updated_at: number;
  next_check_at: number;
  last_check_at: number | null;
  last_success_at: number | null;
  last_error: string | null;
  last_status: string | null;
  last_change_at: number | null;
  last_http_status: number | null;
  consecutive_failures: number;
  version: number;
  retention_days: number;
}

export interface SnapshotRow {
  id: string;
  monitor_id: string;
  created_at: number;
  content_hash: string;
  text: string;
  word_count: number;
  is_first: number;
  changed: number;
  http_status: number | null;
  final_url: string | null;
}

export interface DiffRow {
  id: string;
  monitor_id: string;
  from_snapshot: string;
  to_snapshot: string;
  created_at: number;
  added_chars: number;
  removed_chars: number;
  added_lines: number;
  removed_lines: number;
  ops_json: string;
}

export function toMonitor(row: MonitorRow, snapshotCount?: number): Monitor {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    intervalMinutes: row.interval_minutes,
    extractRule: row.extract_rule,
    keyword: row.keyword,
    notifyWebhook: row.notify_webhook,
    notifyEmail: row.notify_email === 1,
    paused: row.paused === 1,
    createdAt: row.created_at,
    nextCheckAt: row.next_check_at,
    lastCheckAt: row.last_check_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    lastStatus: (row.last_status as Monitor['lastStatus']) ?? null,
    lastChangeAt: row.last_change_at,
    consecutiveFailures: row.consecutive_failures,
    retentionDays: row.retention_days,
    lastHttpStatus: row.last_http_status,
    ...(snapshotCount !== undefined ? { snapshotCount } : {}),
  };
}

export function toSnapshot(row: SnapshotRow): Snapshot {
  return {
    id: row.id,
    monitorId: row.monitor_id,
    createdAt: row.created_at,
    contentHash: row.content_hash,
    text: row.text,
    wordCount: row.word_count,
    isFirst: row.is_first === 1,
    changed: row.changed === 1,
  };
}

export function toDiff(row: DiffRow): DiffRecord {
  let ops: DiffOp[] = [];
  try {
    ops = JSON.parse(row.ops_json) as DiffOp[];
  } catch {
    ops = [];
  }
  return {
    id: row.id,
    monitorId: row.monitor_id,
    fromSnapshot: row.from_snapshot,
    toSnapshot: row.to_snapshot,
    createdAt: row.created_at,
    added: row.added_chars,
    removed: row.removed_chars,
    ops,
  };
}

export function toRun(row: Record<string, unknown>): CheckRun {
  return {
    id: String(row.id),
    monitorId: String(row.monitor_id),
    scheduledAt: Number(row.scheduled_at),
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    status: String(row.status),
    httpStatus: row.http_status === null ? null : Number(row.http_status),
    error: row.error === null ? null : String(row.error),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    snapshotId: row.snapshot_id === null ? null : String(row.snapshot_id),
  };
}

/* ---------------- workspaces ---------------- */

export async function insertWorkspace(
  db: D1Database,
  w: { id: string; name: string; tokenHash: string; tokenPrefix: string; createdAt: number },
): Promise<void> {
  await db
    .prepare('INSERT INTO workspaces (id, name, token_hash, token_prefix, created_at, plan, monitors_limit, checks_per_day, snapshots_limit, retention_days) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(w.id, w.name, w.tokenHash, w.tokenPrefix, w.createdAt, 'free', 5, 200, 500, 30)
    .run();
}

export async function getWorkspaceByTokenHash(db: D1Database, hash: string): Promise<WorkspaceRow | null> {
  return db.prepare('SELECT * FROM workspaces WHERE token_hash = ?').bind(hash).first<WorkspaceRow>();
}

export async function getWorkspaceById(db: D1Database, id: string): Promise<WorkspaceRow | null> {
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').bind(id).first<WorkspaceRow>();
}

export async function touchWorkspace(db: D1Database, id: string, now: number): Promise<void> {
  await db.prepare('UPDATE workspaces SET last_seen_at = ? WHERE id = ?').bind(now, id).run();
}

/* ---------------- monitors ---------------- */

export async function listMonitors(db: D1Database, workspaceId: string): Promise<MonitorRow[]> {
  const r = await db
    .prepare('SELECT * FROM monitors WHERE workspace_id = ? ORDER BY created_at DESC')
    .bind(workspaceId)
    .all<MonitorRow>();
  return r.results ?? [];
}

export async function countMonitors(db: D1Database, workspaceId: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM monitors WHERE workspace_id = ?').bind(workspaceId).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function getMonitor(db: D1Database, workspaceId: string, id: string): Promise<MonitorRow | null> {
  return db.prepare('SELECT * FROM monitors WHERE id = ? AND workspace_id = ?').bind(id, workspaceId).first<MonitorRow>();
}

export async function findMonitorByUrl(db: D1Database, workspaceId: string, urlNormalized: string): Promise<MonitorRow | null> {
  return db.prepare('SELECT * FROM monitors WHERE workspace_id = ? AND url_normalized = ?').bind(workspaceId, urlNormalized).first<MonitorRow>();
}

export async function insertMonitor(db: D1Database, m: MonitorRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO monitors (id, workspace_id, name, url, url_normalized, interval_minutes, extract_rule, keyword, notify_webhook, notify_email,
        paused, created_at, updated_at, next_check_at, retention_days, version)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
    )
    .bind(
      m.id,
      m.workspace_id,
      m.name,
      m.url,
      m.url_normalized,
      m.interval_minutes,
      m.extract_rule,
      m.keyword,
      m.notify_webhook,
      m.notify_email,
      m.paused,
      m.created_at,
      m.updated_at,
      m.next_check_at,
      m.retention_days,
    )
    .run();
}

export async function updateMonitor(
  db: D1Database,
  workspaceId: string,
  id: string,
  patch: {
    name?: string;
    intervalMinutes?: number;
    extractRule?: string;
    keyword?: string | null;
    notifyWebhook?: string | null;
    notifyEmail?: boolean;
    paused?: boolean;
    nextCheckAt?: number;
  },
): Promise<boolean> {
  const sets: string[] = ['updated_at = ?'];
  const vals: unknown[] = [Date.now()];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    vals.push(patch.name);
  }
  if (patch.intervalMinutes !== undefined) {
    sets.push('interval_minutes = ?');
    vals.push(patch.intervalMinutes);
  }
  if (patch.extractRule !== undefined) {
    sets.push('extract_rule = ?');
    vals.push(patch.extractRule);
  }
  if (patch.keyword !== undefined) {
    sets.push('keyword = ?');
    vals.push(patch.keyword);
  }
  if (patch.notifyWebhook !== undefined) {
    sets.push('notify_webhook = ?');
    vals.push(patch.notifyWebhook);
  }
  if (patch.notifyEmail !== undefined) {
    sets.push('notify_email = ?');
    vals.push(patch.notifyEmail ? 1 : 0);
  }
  if (patch.paused !== undefined) {
    sets.push('paused = ?');
    vals.push(patch.paused ? 1 : 0);
  }
  if (patch.nextCheckAt !== undefined) {
    sets.push('next_check_at = ?');
    vals.push(patch.nextCheckAt);
  }
  vals.push(id, workspaceId);
  const res = await db.prepare(`UPDATE monitors SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`).bind(...vals).run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function deleteMonitor(db: D1Database, workspaceId: string, id: string): Promise<boolean> {
  const res = await db.prepare('DELETE FROM monitors WHERE id = ? AND workspace_id = ?').bind(id, workspaceId).run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function dueMonitors(db: D1Database, now: number, limit: number): Promise<MonitorRow[]> {
  const r = await db
    .prepare('SELECT * FROM monitors WHERE paused = 0 AND next_check_at <= ? ORDER BY next_check_at ASC LIMIT ?')
    .bind(now, limit)
    .all<MonitorRow>();
  return r.results ?? [];
}

/** 乐观锁：只有 version 未变时才写入结果，避免定时与手动双写。 */
export async function commitMonitorResult(
  db: D1Database,
  monitorId: string,
  expectedVersion: number,
  patch: {
    nextCheckAt: number;
    lastCheckAt: number;
    lastSuccessAt?: number | null;
    lastError: string | null;
    lastStatus: string;
    lastChangeAt?: number | null;
    lastHttpStatus?: number | null;
    consecutiveFailures: number;
  },
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE monitors SET next_check_at = ?, last_check_at = ?, last_success_at = COALESCE(?, last_success_at),
        last_error = ?, last_status = ?, last_change_at = COALESCE(?, last_change_at), last_http_status = ?,
        consecutive_failures = ?, version = version + 1
       WHERE id = ? AND version = ?`,
    )
    .bind(
      patch.nextCheckAt,
      patch.lastCheckAt,
      patch.lastSuccessAt ?? null,
      patch.lastError,
      patch.lastStatus,
      patch.lastChangeAt ?? null,
      patch.lastHttpStatus ?? null,
      patch.consecutiveFailures,
      monitorId,
      expectedVersion,
    )
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/* ---------------- snapshots ---------------- */

export async function latestSnapshots(db: D1Database, monitorId: string, limit = 2): Promise<SnapshotRow[]> {
  const r = await db
    .prepare('SELECT * FROM snapshots WHERE monitor_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .bind(monitorId, limit)
    .all<SnapshotRow>();
  return r.results ?? [];
}

export async function listSnapshots(db: D1Database, monitorId: string, limit = 30): Promise<SnapshotRow[]> {
  const r = await db
    .prepare('SELECT id, monitor_id, created_at, content_hash, word_count, is_first, changed, http_status, final_url, substr(text,1,4000) AS text FROM snapshots WHERE monitor_id = ? ORDER BY created_at DESC LIMIT ?')
    .bind(monitorId, limit)
    .all<SnapshotRow>();
  return r.results ?? [];
}

export async function getSnapshot(db: D1Database, monitorId: string, id: string): Promise<SnapshotRow | null> {
  return db.prepare('SELECT * FROM snapshots WHERE id = ? AND monitor_id = ?').bind(id, monitorId).first<SnapshotRow>();
}

export async function insertSnapshot(db: D1Database, s: SnapshotRow): Promise<void> {
  await db
    .prepare(
      'INSERT INTO snapshots (id, monitor_id, created_at, content_hash, text, word_count, is_first, changed, http_status, final_url) VALUES (?,?,?,?,?,?,?,?,?,?)',
    )
    .bind(s.id, s.monitor_id, s.created_at, s.content_hash, s.text, s.word_count, s.is_first, s.changed, s.http_status, s.final_url)
    .run();
}

export async function countSnapshots(db: D1Database, monitorId: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE monitor_id = ?').bind(monitorId).first<{ n: number }>();
  return row?.n ?? 0;
}

/** 保留期限清理：删掉过期的快照（连带 diff 由外键级联）。 */
export async function pruneSnapshots(db: D1Database, monitorId: string, before: number): Promise<number> {
  const res = await db.prepare('DELETE FROM snapshots WHERE monitor_id = ? AND created_at < ?').bind(monitorId, before).run();
  return res.meta?.changes ?? 0;
}

/* ---------------- diffs ---------------- */

export async function insertDiff(db: D1Database, d: DiffRow): Promise<void> {
  await db
    .prepare(
      'INSERT INTO diffs (id, monitor_id, from_snapshot, to_snapshot, created_at, added_chars, removed_chars, added_lines, removed_lines, ops_json) VALUES (?,?,?,?,?,?,?,?,?,?)',
    )
    .bind(d.id, d.monitor_id, d.from_snapshot, d.to_snapshot, d.created_at, d.added_chars, d.removed_chars, d.added_lines, d.removed_lines, d.ops_json)
    .run();
}

export async function latestDiff(db: D1Database, monitorId: string): Promise<DiffRow | null> {
  return db.prepare('SELECT * FROM diffs WHERE monitor_id = ? ORDER BY created_at DESC LIMIT 1').bind(monitorId).first<DiffRow>();
}

export async function listDiffs(db: D1Database, monitorId: string, limit = 20): Promise<DiffRow[]> {
  const r = await db
    .prepare('SELECT * FROM diffs WHERE monitor_id = ? ORDER BY created_at DESC LIMIT ?')
    .bind(monitorId, limit)
    .all<DiffRow>();
  return r.results ?? [];
}

/* ---------------- runs ---------------- */

export async function insertRun(db: D1Database, run: CheckRun & { attempt?: number }): Promise<boolean> {
  try {
    await db
      .prepare(
        'INSERT INTO check_runs (id, monitor_id, scheduled_at, started_at, finished_at, status, http_status, error, duration_ms, snapshot_id, attempt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        run.id,
        run.monitorId,
        run.scheduledAt,
        run.startedAt,
        run.finishedAt,
        run.status,
        run.httpStatus,
        run.error,
        run.durationMs,
        run.snapshotId,
        run.attempt ?? 1,
      )
      .run();
    return true;
  } catch (e) {
    // 唯一索引冲突 = 同一时段已经跑过，属于正常的幂等保护
    if (/UNIQUE|constraint/i.test(String(e))) return false;
    throw e;
  }
}

export async function listRuns(db: D1Database, monitorId: string, limit = 20): Promise<CheckRun[]> {
  const r = await db
    .prepare('SELECT * FROM check_runs WHERE monitor_id = ? ORDER BY started_at DESC LIMIT ?')
    .bind(monitorId, limit)
    .all<Record<string, unknown>>();
  return (r.results ?? []).map(toRun);
}

/* ---------------- quota ---------------- */

function todayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export async function checksUsedToday(db: D1Database, workspaceId: string, now: number): Promise<number> {
  const row = await db
    .prepare('SELECT count FROM check_counter WHERE workspace_id = ? AND day = ?')
    .bind(workspaceId, todayKey(now))
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function bumpCheckCounter(db: D1Database, workspaceId: string, now: number): Promise<number> {
  const day = todayKey(now);
  await db
    .prepare('INSERT INTO check_counter (workspace_id, day, count) VALUES (?,?,1) ON CONFLICT(workspace_id, day) DO UPDATE SET count = count + 1')
    .bind(workspaceId, day)
    .run();
  return checksUsedToday(db, workspaceId, now);
}

export async function snapshotsUsed(db: D1Database, workspaceId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM snapshots s JOIN monitors m ON m.id = s.monitor_id WHERE m.workspace_id = ?')
    .bind(workspaceId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function buildQuota(db: D1Database, ws: WorkspaceRow, now: number): Promise<Quota> {
  const [checks, monitors, snaps] = await Promise.all([
    checksUsedToday(db, ws.id, now),
    countMonitors(db, ws.id),
    snapshotsUsed(db, ws.id),
  ]);
  return {
    plan: ws.plan,
    checksUsed: checks,
    checksLimit: ws.checks_per_day,
    period: todayKey(now),
    monitorsUsed: monitors,
    monitorsLimit: ws.monitors_limit,
    snapshotsUsed: snaps,
    snapshotsLimit: ws.snapshots_limit,
    retentionMaxDays: ws.retention_days,
  };
}

/* ---------------- notifications ---------------- */

export async function reserveNotification(db: D1Database, monitorId: string, dedupeKey: string, channel: string): Promise<boolean> {
  try {
    await db
      .prepare('INSERT INTO notifications (id, monitor_id, created_at, channel, status, dedupe_key) VALUES (?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), monitorId, Date.now(), channel, 'pending', dedupeKey)
      .run();
    return true;
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e))) return false;
    throw e;
  }
}

export async function finishNotification(
  db: D1Database,
  monitorId: string,
  dedupeKey: string,
  channel: string,
  status: string,
  error: string | null,
): Promise<void> {
  await db
    .prepare('UPDATE notifications SET status = ?, error = ? WHERE monitor_id = ? AND dedupe_key = ? AND channel = ?')
    .bind(status, error, monitorId, dedupeKey, channel)
    .run();
}

/* ---------------- cron lease ---------------- */

/** 用租约避免两个 cron 实例同时处理同一批任务。 */
export async function acquireLease(db: D1Database, name: string, holder: string, ttlMs: number, now: number): Promise<boolean> {
  try {
    await db
      .prepare('INSERT INTO cron_leases (name, holder, expires_at) VALUES (?,?,?)')
      .bind(name, holder, now + ttlMs)
      .run();
    return true;
  } catch (e) {
    if (!/UNIQUE|constraint/i.test(String(e))) throw e;
  }
  const res = await db
    .prepare('UPDATE cron_leases SET holder = ?, expires_at = ? WHERE name = ? AND expires_at < ?')
    .bind(holder, now + ttlMs, name, now)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function releaseLease(db: D1Database, name: string, holder: string): Promise<void> {
  await db.prepare('UPDATE cron_leases SET expires_at = 0 WHERE name = ? AND holder = ?').bind(name, holder).run();
}
