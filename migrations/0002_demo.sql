-- 演示数据标记
-- 用户点击「加载演示数据」时创建的监控会标记 is_demo=1，
-- 方便一键清除，也避免和用户自己的真实监控混淆。

ALTER TABLE monitors ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_monitors_demo ON monitors(workspace_id, is_demo);

-- 记录工作区是否已经看过入门引导（用于决定是否首次展示）
ALTER TABLE workspaces ADD COLUMN onboarded_at INTEGER;
