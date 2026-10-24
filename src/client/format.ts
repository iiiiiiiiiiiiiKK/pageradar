export function formatTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000 && diff >= 0) return '刚刚';
  if (diff < 3_600_000 && diff >= 0) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000 && diff >= 0) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatIn(ts: number | null | undefined): string {
  if (!ts) return '—';
  const diff = ts - Date.now();
  if (diff <= 0) return '即将执行';
  if (diff < 60_000) return `${Math.ceil(diff / 1000)} 秒后`;
  if (diff < 3_600_000) return `${Math.ceil(diff / 60_000)} 分钟后`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时后`;
  return `${Math.round(diff / 86_400_000)} 天后`;
}

export function intervalLabel(minutes: number): string {
  if (minutes < 60) return `每 ${minutes} 分钟`;
  const h = minutes / 60;
  return Number.isInteger(h) ? `每 ${h} 小时` : `每 ${minutes} 分钟`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return '';
  }
}
