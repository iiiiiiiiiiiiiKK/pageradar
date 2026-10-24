-- PageRadar D1 schema
-- 设计要点：
--   * 所有用户数据都带 workspace_id，查询必须显式过滤，避免越权读别人的数据
--   * token 只存 SHA-256 哈希，明文只在创建时返回一次
--   * 快照正文与指纹分开存储，指纹用于快速判变
--   * 唯一索引保证「同一任务同一时间点」不会被重复创建（幂等）

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspaces (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  token_prefix  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  plan          TEXT NOT NULL DEFAULT 'free',
  -- 配额（可在后台按工作区调整，不需要改代码）
  monitors_limit INTEGER NOT NULL DEFAULT 5,
  checks_per_day INTEGER NOT NULL DEFAULT 200,
  snapshots_limit INTEGER NOT NULL DEFAULT 500,
  retention_days INTEGER NOT NULL DEFAULT 30
);

CREATE TABLE IF NOT EXISTS monitors (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  url             TEXT NOT NULL,
  url_normalized  TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL,
  extract_rule    TEXT NOT NULL DEFAULT '',
  keyword         TEXT,
  notify_webhook  TEXT,
  notify_email    INTEGER NOT NULL DEFAULT 0,
  paused          INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  next_check_at   INTEGER NOT NULL,
  last_check_at   INTEGER,
  last_success_at INTEGER,
  last_error      TEXT,
  last_status     TEXT,
  last_change_at  INTEGER,
  last_http_status INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  -- 乐观锁：定时任务与手动检查并发时用它避免双写
  version         INTEGER NOT NULL DEFAULT 0,
  retention_days  INTEGER NOT NULL DEFAULT 30
);

CREATE INDEX IF NOT EXISTS idx_monitors_due ON monitors(paused, next_check_at);
CREATE INDEX IF NOT EXISTS idx_monitors_workspace ON monitors(workspace_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_monitors_unique_url ON monitors(workspace_id, url_normalized);

CREATE TABLE IF NOT EXISTS snapshots (
  id           TEXT PRIMARY KEY,
  monitor_id   TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  text         TEXT NOT NULL,
  word_count   INTEGER NOT NULL DEFAULT 0,
  is_first     INTEGER NOT NULL DEFAULT 0,
  changed      INTEGER NOT NULL DEFAULT 0,
  http_status  INTEGER,
  final_url    TEXT
);

CREATE INDEX IF NOT EXISTS idx_snapshots_monitor ON snapshots(monitor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS check_runs (
  id            TEXT PRIMARY KEY,
  monitor_id    TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  -- 调度槽位（分钟对齐的时间戳）：唯一索引保证同一槽位只成功一次
  scheduled_at  INTEGER NOT NULL,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  status        TEXT NOT NULL,
  http_status   INTEGER,
  error         TEXT,
  duration_ms   INTEGER,
  snapshot_id   TEXT,
  attempt       INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_slot ON check_runs(monitor_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_runs_monitor ON check_runs(monitor_id, started_at DESC);

CREATE TABLE IF NOT EXISTS diffs (
  id             TEXT PRIMARY KEY,
  monitor_id     TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  from_snapshot  TEXT NOT NULL,
  to_snapshot    TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  added_chars    INTEGER NOT NULL DEFAULT 0,
  removed_chars  INTEGER NOT NULL DEFAULT 0,
  added_lines    INTEGER NOT NULL DEFAULT 0,
  removed_lines  INTEGER NOT NULL DEFAULT 0,
  ops_json       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_diffs_monitor ON diffs(monitor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  monitor_id  TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  channel     TEXT NOT NULL,
  status      TEXT NOT NULL,
  error       TEXT,
  -- 去重键：同一个 diff 只通知一次
  dedupe_key  TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_dedupe ON notifications(monitor_id, dedupe_key, channel);

CREATE TABLE IF NOT EXISTS check_counter (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day          TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day)
);

CREATE TABLE IF NOT EXISTS cron_leases (
  name       TEXT PRIMARY KEY,
  holder     TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
