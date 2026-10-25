// 共享类型定义（前后端共用，纯类型无运行时依赖）

export interface Monitor {
  id: string;
  name: string;
  url: string;
  intervalMinutes: number;
  extractRule: string;
  keyword: string | null;
  notifyWebhook: string | null;
  notifyEmail: boolean;
  paused: boolean;
  createdAt: number;
  nextCheckAt: number;
  lastCheckAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastStatus: LastStatus | null;
  lastChangeAt: number | null;
  consecutiveFailures: number;
  retentionDays: number;
  snapshotCount?: number;
  lastHttpStatus?: number | null;
  /** 是否为「演示数据」创建的监控（可一键清除，且界面上有明确标记）。 */
  isDemo?: boolean;
}

export type LastStatus = 'ok' | 'changed' | 'nochange' | 'first' | 'error' | 'paused';

export interface Snapshot {
  id: string;
  monitorId: string;
  createdAt: number;
  contentHash: string;
  text: string;
  wordCount: number;
  isFirst: boolean;
  changed: boolean;
}

export interface CheckRun {
  id: string;
  monitorId: string;
  scheduledAt: number;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  httpStatus: number | null;
  error: string | null;
  durationMs: number | null;
  snapshotId: string | null;
}

export interface DiffOp {
  type: 'equal' | 'add' | 'del';
  text: string;
}

export interface DiffRecord {
  id: string;
  monitorId: string;
  fromSnapshot: string;
  toSnapshot: string;
  createdAt: number;
  added: number;
  removed: number;
  ops: DiffOp[];
}

export interface Quota {
  plan: string;
  checksUsed: number;
  checksLimit: number;
  period: string;
  monitorsUsed: number;
  monitorsLimit: number;
  snapshotsUsed: number;
  snapshotsLimit: number;
  retentionMaxDays: number;
}

export interface ApiError {
  error: string;
  code?: string;
  detail?: string;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: number;
  onboarded: boolean;
}

export interface MonitorDetail {
  monitor: Monitor;
  latest: Snapshot | null;
  previous: Snapshot | null;
  diff: DiffRecord | null;
  history: Snapshot[];
  runs: CheckRun[];
  quota: Quota;
}
