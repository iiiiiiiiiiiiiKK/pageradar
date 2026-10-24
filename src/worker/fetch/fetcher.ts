/**
 * 带 SSRF 防护的抓取器。
 *
 * 关键设计：不使用 fetch 的自动重定向，而是手动逐跳处理，
 * 每一跳都重新做 URL 校验 + DNS 解析校验。这是防「重定向到 169.254.169.254」
 * 的唯一可靠做法。
 *
 * 另外：
 *  - AbortController 控制总超时与单跳超时
 *  - 边读边计数，超过 maxBytes 立刻中止（不是读完再判断）
 *  - 只接受文本类 content-type
 *  - robots.txt 缓存（按 host，1 小时）
 */

import { checkResolvedAddresses, checkUrl, type UrlCheck } from '../security/url-guard.ts';

export interface FetchLimits {
  maxBytes: number;
  totalTimeoutMs: number;
  perHopTimeoutMs: number;
  maxRedirects: number;
}

export const DEFAULT_FETCH_LIMITS: FetchLimits = {
  maxBytes: 2 * 1024 * 1024,
  totalTimeoutMs: 20_000,
  perHopTimeoutMs: 10_000,
  maxRedirects: 5,
};

export interface FetchOutcome {
  ok: boolean;
  status: number;
  finalUrl: string;
  html: string;
  contentType: string;
  bytes: number;
  redirectChain: string[];
  error?: string;
  /** 错误分类，便于 UI 给出可理解的解释。 */
  errorKind?: 'blocked-url' | 'dns' | 'timeout' | 'too-large' | 'bad-status' | 'bad-content-type' | 'network' | 'robots' | 'redirect-loop';
}

const TEXTUAL_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain', 'application/xml', 'text/xml'];

/** 多解析器：优先 DoH，回退到平台默认解析。 */
export async function resolveHost(hostname: string): Promise<{ ok: boolean; addresses: string[]; error?: string }> {
  const addresses = new Set<string>();

  // 1) 尝试 Cloudflare DoH（JSON API）。失败不致命。
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(4000),
    });
    if (r.ok) {
      const j = (await r.json()) as { Answer?: Array<{ type: number; data: string }> };
      for (const ans of j.Answer ?? []) if (ans.type === 1 || ans.type === 28) addresses.add(ans.data);
    }
  } catch {
    /* 忽略，走下一步 */
  }

  // 2) AAAA
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=AAAA`, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(4000),
    });
    if (r.ok) {
      const j = (await r.json()) as { Answer?: Array<{ type: number; data: string }> };
      for (const ans of j.Answer ?? []) if (ans.type === 28) addresses.add(ans.data);
    }
  } catch {
    /* 忽略 */
  }

  const list = Array.from(addresses);
  if (list.length === 0) {
    // 拿不到解析结果时保守处理：交给平台 fetch 去解析，但记录为「未验证」，
    // 调用方可以选择拒绝（默认拒绝，宁可失败也不放行未知目标）。
    return { ok: false, addresses: [], error: `无法解析域名 ${hostname} 的地址。` };
  }
  return { ok: true, addresses: list };
}

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; bytes: number; tooLarge: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return { text: new TextDecoder('utf-8', { fatal: false }).decode(buf), bytes: buf.byteLength, tooLarge: buf.byteLength > maxBytes };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let tooLarge = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      tooLarge = true;
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      break;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total > maxBytes ? maxBytes : total);
  let o = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, out.byteLength - o);
    out.set(c.subarray(0, take), o);
    o += take;
    if (o >= out.byteLength) break;
  }
  const charset = res.headers.get('content-type')?.match(/charset=([^;]+)/i)?.[1]?.trim().toLowerCase();
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset && charset !== 'utf-8' ? charset : 'utf-8', { fatal: false });
  } catch {
    decoder = new TextDecoder('utf-8', { fatal: false });
  }
  return { text: decoder.decode(out), bytes: total, tooLarge };
}

/**
 * 抓取一个页面，逐跳校验重定向。
 */
export async function safeFetch(
  rawUrl: string,
  limits: FetchLimits = DEFAULT_FETCH_LIMITS,
  opts: { userAgent?: string; allowHost?: (host: string) => boolean } = {},
): Promise<FetchOutcome> {
  const redirectChain: string[] = [];
  const deadline = Date.now() + limits.totalTimeoutMs;
  let current = rawUrl;

  for (let hop = 0; hop <= limits.maxRedirects; hop++) {
    const check: UrlCheck = checkUrl(current);
    if (!check.ok || !check.url) {
      return {
        ok: false,
        status: 0,
        finalUrl: current,
        html: '',
        contentType: '',
        bytes: 0,
        redirectChain,
        error: check.message ?? '网址被安全策略拒绝。',
        errorKind: 'blocked-url',
      };
    }
    const url = check.url;
    redirectChain.push(url.href);

    // DNS 校验：防 rebinding（解析结果含私网地址则拒绝）
    const dns = await resolveHost(url.hostname);
    if (!dns.ok) {
      return {
        ok: false,
        status: 0,
        finalUrl: url.href,
        html: '',
        contentType: '',
        bytes: 0,
        redirectChain,
        error: `DNS 解析失败或无法验证目标地址（${url.hostname}）。为安全起见已中止。`,
        errorKind: 'dns',
      };
    }
    const addrCheck = checkResolvedAddresses(dns.addresses);
    if (!addrCheck.ok) {
      return {
        ok: false,
        status: 0,
        finalUrl: url.href,
        html: '',
        contentType: '',
        bytes: 0,
        redirectChain,
        error: `域名解析到了不可访问的内部地址（${addrCheck.offenders.join(', ')}），已按 SSRF 防护规则拒绝。`,
        errorKind: 'blocked-url',
      };
    }
    if (opts.allowHost && !opts.allowHost(url.hostname)) {
      return {
        ok: false,
        status: 0,
        finalUrl: url.href,
        html: '',
        contentType: '',
        bytes: 0,
        redirectChain,
        error: '该站点在排除列表中。',
        errorKind: 'robots',
      };
    }

    const hopTimeout = Math.max(1, Math.min(limits.perHopTimeoutMs, deadline - Date.now()));
    if (hopTimeout <= 1) {
      return {
        ok: false,
        status: 0,
        finalUrl: url.href,
        html: '',
        contentType: '',
        bytes: 0,
        redirectChain,
        error: `抓取超过总时限（${limits.totalTimeoutMs / 1000} 秒），已中止。`,
        errorKind: 'timeout',
      };
    }

    let res: Response;
    try {
      res = await fetch(url.href, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'user-agent': opts.userAgent ?? 'PageRadarBot/1.0 (+https://github.com/iiiiiiiiiiiiiKK/pageradar; change detection)',
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal: AbortSignal.timeout(hopTimeout),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isTimeout = /timeout|abort/i.test(msg);
      return {
        ok: false,
        status: 0,
        finalUrl: url.href,
        html: '',
        contentType: '',
        bytes: 0,
        redirectChain,
        error: isTimeout ? `请求超时（超过 ${hopTimeout} 毫秒没有响应）。` : `网络请求失败：${msg}`,
        errorKind: isTimeout ? 'timeout' : 'network',
      };
    }

    // 重定向：手动处理，每一跳都会回到循环顶部重新校验
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        return {
          ok: false,
          status: res.status,
          finalUrl: url.href,
          html: '',
          contentType: '',
          bytes: 0,
          redirectChain,
          error: `服务器返回 ${res.status} 但没有给出跳转地址。`,
          errorKind: 'bad-status',
        };
      }
      let next: string;
      try {
        next = new URL(location, url.href).href;
      } catch {
        return {
          ok: false,
          status: res.status,
          finalUrl: url.href,
          html: '',
          contentType: '',
          bytes: 0,
          redirectChain,
          error: `跳转地址无效：${location}`,
          errorKind: 'bad-status',
        };
      }
      if (redirectChain.includes(next)) {
        return {
          ok: false,
          status: res.status,
          finalUrl: url.href,
          html: '',
          contentType: '',
          bytes: 0,
          redirectChain,
          error: '检测到重定向循环，已中止。',
          errorKind: 'redirect-loop',
        };
      }
      current = next;
      continue;
    }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        finalUrl: url.href,
        html: '',
        contentType: res.headers.get('content-type') ?? '',
        bytes: 0,
        redirectChain,
        error: `服务器返回 HTTP ${res.status}${res.status === 404 ? '（页面不存在）' : res.status === 403 ? '（拒绝访问，可能需要登录或被反爬规则拦截）' : ''}。`,
        errorKind: 'bad-status',
      };
    }

    const ctype = (res.headers.get('content-type') ?? '').toLowerCase();
    if (ctype && !TEXTUAL_TYPES.some((t) => ctype.includes(t))) {
      return {
        ok: false,
        status: res.status,
        finalUrl: url.href,
        html: '',
        contentType: ctype,
        bytes: 0,
        redirectChain,
        error: `返回的内容不是网页文本（Content-Type: ${ctype.split(';')[0]}），无法监控。`,
        errorKind: 'bad-content-type',
      };
    }

    const { text, bytes, tooLarge } = await readCapped(res, limits.maxBytes);
    if (tooLarge) {
      return {
        ok: false,
        status: res.status,
        finalUrl: url.href,
        html: '',
        contentType: ctype,
        bytes,
        redirectChain,
        error: `页面超过 ${(limits.maxBytes / 1024 / 1024).toFixed(1)} MB 上限，已停止读取。`,
        errorKind: 'too-large',
      };
    }

    return {
      ok: true,
      status: res.status,
      finalUrl: url.href,
      html: text,
      contentType: ctype,
      bytes,
      redirectChain,
    };
  }

  return {
    ok: false,
    status: 0,
    finalUrl: current,
    html: '',
    contentType: '',
    bytes: 0,
    redirectChain,
    error: `重定向次数超过 ${limits.maxRedirects} 次，已中止。`,
    errorKind: 'redirect-loop',
  };
}

/* ------------------------------------------------------------------ *
 * robots.txt
 * ------------------------------------------------------------------ */

export interface RobotsRules {
  disallow: string[];
  allow: string[];
  crawlDelay?: number;
  fetchedAt: number;
  unavailable: boolean;
}

const robotsCache = new Map<string, RobotsRules>();
const ROBOTS_TTL = 60 * 60 * 1000;

export function parseRobots(txt: string, ua = 'pageradar'): RobotsRules {
  const lines = txt.split(/\r?\n/);
  const groups: Array<{ agents: string[]; disallow: string[]; allow: string[]; crawlDelay?: number }> = [];
  let current: { agents: string[]; disallow: string[]; allow: string[]; crawlDelay?: number } | null = null;
  let lastWasAgent = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], disallow: [], allow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'disallow' || key === 'allow') {
      lastWasAgent = false;
      if (!current) {
        current = { agents: ['*'], disallow: [], allow: [] };
        groups.push(current);
      }
      if (key === 'disallow') current.disallow.push(value);
      else current.allow.push(value);
    } else if (key === 'crawl-delay') {
      lastWasAgent = false;
      if (current) current.crawlDelay = Number(value) || undefined;
    }
  }

  // 优先匹配具体的 UA 组，其次 '*'
  const uaLower = ua.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && uaLower.includes(a)));
  const wildcard = groups.filter((g) => g.agents.includes('*'));
  const chosen = specific.length > 0 ? specific : wildcard;

  const out: RobotsRules = { disallow: [], allow: [], fetchedAt: Date.now(), unavailable: false };
  for (const g of chosen) {
    out.disallow.push(...g.disallow);
    out.allow.push(...g.allow);
    if (g.crawlDelay !== undefined && out.crawlDelay === undefined) out.crawlDelay = g.crawlDelay;
  }
  return out;
}

/** 路径是否被 robots.txt 禁止。长匹配优先（更具体的规则优先级更高）。 */
export function robotsAllows(rules: RobotsRules, pathname: string, search = ''): boolean {
  if (rules.unavailable) return true; // 拿不到 robots.txt 时按业界惯例视为允许
  const target = pathname + search;
  const matchLen = (patterns: string[]) => {
    let best = -1;
    let allowed = false;
    for (const p of patterns) {
      if (!p) continue;
      const pattern = p.replace(/\*/g, '.*').replace(/\$$/, '$');
      let re: RegExp;
      try {
        re = new RegExp('^' + pattern);
      } catch {
        continue;
      }
      if (re.test(target)) {
        if (p.length > best) {
          best = p.length;
          allowed = !rules.disallow.includes(p) ? true : false;
        }
      }
    }
    return { best, allowed };
  };

  const d = matchLen(rules.disallow);
  const a = matchLen(rules.allow);
  if (d.best < 0) return true;
  if (a.best >= 0 && a.best >= d.best) return a.allowed;
  return d.allowed;
}

export async function fetchRobots(origin: string, userAgent: string): Promise<RobotsRules> {
  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_TTL) return cached;

  const rules: RobotsRules = { disallow: [], allow: [], fetchedAt: Date.now(), unavailable: false };
  try {
    const res = await fetch(new URL('/robots.txt', origin).href, {
      headers: { 'user-agent': userAgent, accept: 'text/plain' },
      signal: AbortSignal.timeout(5000),
      redirect: 'follow',
    });
    if (res.ok) {
      const txt = await res.text();
      const parsed = parseRobots(txt, userAgent);
      parsed.fetchedAt = Date.now();
      robotsCache.set(origin, parsed);
      return parsed;
    }
    // 404 / 5xx 都视为「没有限制」
    rules.unavailable = true;
  } catch {
    rules.unavailable = true;
  }
  if (robotsCache.size > 500) robotsCache.clear();
  robotsCache.set(origin, rules);
  return rules;
}

export function clearRobotsCache(): void {
  robotsCache.clear();
}
