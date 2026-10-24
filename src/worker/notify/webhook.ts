/**
 * Webhook 通知。安全要点：
 *  - 拒绝指向私网的 URL（防止用 webhook 做 SSRF 探测）
 *  - 超时 8 秒，失败不重试（避免对方服务被重试打爆；下个周期会重新判断）
 *  - 响应体只读取前 512 字节用于错误提示
 */
import { checkUrl } from '../security/url-guard.ts';

export interface WebhookPayload {
  event: string;
  monitor: { id: string; name: string; url: string };
  change: { addedChars: number; removedChars: number; keywordHit: boolean };
  detectedAt: string;
  diffUrl: string;
}

export interface WebhookResult {
  ok: boolean;
  status: number;
  error?: string;
}

export async function sendWebhook(rawUrl: string, payload: WebhookPayload): Promise<WebhookResult> {
  const check = checkUrl(rawUrl);
  if (!check.ok) {
    return { ok: false, status: 0, error: `Webhook 地址被安全策略拒绝：${check.message}` };
  }

  // 拼接一个签名头部，方便接收方校验来源（密钥来自环境变量）
  const body = JSON.stringify(payload);
  try {
    const res = await fetch(rawUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'PageRadarBot/1.0 (webhook)',
        'x-pageradar-event': payload.event,
      },
      body,
      signal: AbortSignal.timeout(8000),
      redirect: 'manual',
    });
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
    let detail = '';
    try {
      const txt = await res.text();
      detail = txt.slice(0, 512);
    } catch {
      /* ignore */
    }
    return { ok: false, status: res.status, error: `Webhook 返回 HTTP ${res.status}${detail ? `：${detail}` : ''}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, error: /timeout|abort/i.test(msg) ? 'Webhook 请求超时（8 秒）' : `Webhook 请求失败：${msg}` };
  }
}

/** 界面展示时脱敏：只保留协议+主机+路径前若干字符，其余一律替换为省略号。 */
export function maskWebhook(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const head = u.pathname.length > 6 ? u.pathname.slice(0, 6) : u.pathname;
    return `${u.protocol}//${u.host}${head}…`;
  } catch {
    return url.slice(0, 18) + '…';
  }
}
