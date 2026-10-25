/**
 * API 客户端。令牌存在 localStorage（用户明确要求的工作区凭据），
 * 所有请求都带 Bearer 头；不做任何第三方埋点。
 */
import type { Monitor, MonitorDetail, Quota, ApiError } from '../shared/types.ts';

const TOKEN_KEY = 'pageradar.token';
const WS_KEY = 'pageradar.workspace';

export interface StoredWorkspace {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt?: number;
  onboarded?: boolean;
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getWorkspace(): StoredWorkspace | null {
  try {
    const raw = localStorage.getItem(WS_KEY);
    return raw ? (JSON.parse(raw) as StoredWorkspace) : null;
  } catch {
    return null;
  }
}

export function saveSession(token: string, ws: StoredWorkspace): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(WS_KEY, JSON.stringify(ws));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(WS_KEY);
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers as Record<string, string>) };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const e = (body ?? {}) as ApiError;
    throw new ApiRequestError(e.error ?? `请求失败（HTTP ${res.status}）`, res.status, e.code);
  }
  return body as T;
}

export interface MonitorWithQuota {
  monitors: Monitor[];
  quota: Quota;
}

export const api = {
  async createWorkspace(): Promise<{ token: string; workspace: StoredWorkspace }> {
    return request('/api/workspace', { method: 'POST', body: '{}' });
  },
  /**
   * 用已有令牌「重新进入」工作区。
   *
   * 为什么必须有这个：数据库只存令牌的 SHA-256 哈希，前端无法自证令牌有效，
   * 必须让服务端确认一次。同一个令牌 = 同一个工作区，不存在「换新令牌」。
   */
  async restoreSession(token: string): Promise<{ workspace: StoredWorkspace }> {
    const res = await fetch('/api/workspace/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const e = (body ?? {}) as ApiError;
      throw new ApiRequestError(e.error ?? `请求失败（HTTP ${res.status}）`, res.status, e.code);
    }
    return body as { workspace: StoredWorkspace };
  },
  async loadDemoData(): Promise<{ created: number; ids: string[]; demoBase: string }> {
    return request('/api/demo/sample', { method: 'POST', body: '{}' });
  },
  async clearDemoData(): Promise<{ removed: number }> {
    return request('/api/demo/sample', { method: 'DELETE' });
  },
  async markOnboarded(): Promise<{ ok: boolean }> {
    return request('/api/onboarded', { method: 'POST', body: '{}' });
  },
  async ping(): Promise<{ ok: boolean; db: string; version: string }> {
    return request('/api/health');
  },
  async listMonitors(): Promise<MonitorWithQuota> {
    return request('/api/monitors');
  },
  async getMonitor(id: string): Promise<MonitorDetail> {
    return request(`/api/monitors/${id}`);
  },
  async createMonitor(input: {
    name: string;
    url: string;
    intervalMinutes: number;
    extractRule?: string;
    keyword?: string;
    notifyWebhook?: string;
    notifyEmail?: boolean;
  }): Promise<{ monitor: Monitor }> {
    return request('/api/monitors', { method: 'POST', body: JSON.stringify(input) });
  },
  async updateMonitor(id: string, patch: Record<string, unknown>): Promise<{ monitor: Monitor }> {
    return request(`/api/monitors/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  },
  async deleteMonitor(id: string): Promise<{ ok: boolean }> {
    return request(`/api/monitors/${id}`, { method: 'DELETE' });
  },
  async checkNow(id: string): Promise<{ result: { ok: boolean; status: string; error?: string }; monitor: Monitor | null }> {
    return request(`/api/monitors/${id}/check`, { method: 'POST', body: '{}' });
  },
  async snapshots(id: string): Promise<{ snapshots: Array<{ id: string; createdAt: number; wordCount: number; changed: boolean; isFirst: boolean; text: string }> }> {
    return request(`/api/monitors/${id}/snapshots`);
  },
};
