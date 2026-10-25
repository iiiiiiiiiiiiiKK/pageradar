/**
 * Worker 入口：路由 + 认证 + 输入校验。
 *
 * 安全边界：
 *  - 除 /api/health、/api/workspace (POST)、/api/demo 之外全部要求 Bearer 令牌
 *  - 每个 handler 都从认证上下文拿 workspaceId，绝不从请求体读取
 *  - 所有输入都过 validate 函数，长度与枚举值都限死
 */
import { apiLimiter, createLimiter, demoLimiter, sessionLimiter, extractBearer, generateToken, sha256Hex } from './auth/auth.ts';
import {
  acquireLease,
  buildQuota,
  countDemoMonitors,
  countMonitors,
  deleteDemoMonitors,
  deleteMonitor,
  dueMonitors,
  findMonitorByUrl,
  getMonitor,
  getSnapshot,
  getWorkspaceByTokenHash,
  insertMonitor,
  insertWorkspace,
  latestDiff,
  latestSnapshots,
  listDiffs,
  listMonitors,
  listRuns,
  listSnapshots,
  markOnboarded,
  releaseLease,
  toDiff,
  toMonitor,
  toSnapshot,
  touchWorkspace,
  updateMonitor,
  type MonitorRow,
  type WorkspaceRow,
} from './db/queries.ts';
import { runCheck } from './checks/runner.ts';
import { checkUrl } from './security/url-guard.ts';
import { maskWebhook } from './notify/webhook.ts';
import { DEMO_MONITORS, demoBaseUrl } from './demo/seed.ts';
import type { Monitor, MonitorDetail } from '../shared/types.ts';

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  ENVIRONMENT?: string;
  /** 演示页的根地址（独立部署的 demo-worker 域名）。可选，未配置时按规则推导。 */
  DEMO_BASE_URL?: string;
  EMAIL_API_KEY?: string;
  USER_AGENT?: string;
}

const USER_AGENT =
  'PageRadarBot/1.0 (+https://github.com/iiiiiiiiiiiiiKK/pageradar; change detection; respects robots.txt)';

const ALLOWED_INTERVALS = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440];

/* ---------------- 工具 ---------------- */

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...extra,
    },
  });
}

function err(message: string, status = 400, code = 'bad-request', detail?: string): Response {
  return json({ error: message, code, ...(detail ? { detail } : {}) }, status);
}

class ValidationError extends Error {}

function requireString(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== 'string') throw new ValidationError(`${field} 必须是字符串。`);
  const s = v.trim();
  if (s.length < min) throw new ValidationError(`${field} 至少需要 ${min} 个字符。`);
  if (s.length > max) throw new ValidationError(`${field} 不能超过 ${max} 个字符。`);
  return s;
}

function optionalString(v: unknown, field: string, max: number): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') throw new ValidationError(`${field} 必须是字符串。`);
  const s = v.trim();
  if (s.length > max) throw new ValidationError(`${field} 不能超过 ${max} 个字符。`);
  return s === '' ? null : s;
}

function normalizeUrlForDedup(url: URL): string {
  const u = new URL(url.href);
  u.hash = '';
  // 去掉常见追踪参数，避免同一页面因 utm 参数被当成两个监控
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid']) {
    u.searchParams.delete(k);
  }
  return u.href;
}

/* ---------------- 认证 ---------------- */

interface AuthContext {
  workspace: WorkspaceRow;
}

async function authenticate(req: Request, env: Env): Promise<AuthContext | Response> {
  const token = extractBearer(req);
  if (!token) return err('缺少或格式错误的访问令牌。请在请求头中带上 Authorization: Bearer <token>。', 401, 'unauthorized');
  const hash = await sha256Hex(token);
  const ws = await getWorkspaceByTokenHash(env.DB, hash);
  if (!ws) return err('访问令牌无效。', 401, 'invalid-token');
  return { workspace: ws };
}

/* ---------------- 主体 ---------------- */

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // CORS：仅允许同源（前端与 Worker 同域部署）；预检直接放行同源检查
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': url.origin,
          'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
          'access-control-allow-headers': 'authorization,content-type',
          'access-control-max-age': '86400',
        },
      });
    }

    if (path.startsWith('/api/')) {
      const clientIp = req.headers.get('cf-connecting-ip') ?? 'unknown';
      const limited = apiLimiter.check(`api:${clientIp}`);
      if (!limited.ok) {
        return err(`请求过于频繁，请在 ${limited.retryAfter} 秒后重试。`, 429, 'rate-limited');
      }
      try {
        return await handleApi(req, env, ctx, path, url);
      } catch (e) {
        if (e instanceof ValidationError) return err(e.message, 422, 'validation');
        const msg = e instanceof Error ? e.message : String(e);
        console.error('unhandled', msg);
        return err('服务器内部错误。', 500, 'internal', msg.slice(0, 300));
      }
    }

    // 静态资源交给 Assets 绑定
    if (path === '/demo/ticker') return demoTicker(url);
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response('Not Found', { status: 404 });
  },

  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runCron(env, event.scheduledTime ?? Date.now());
  },
};

async function handleApi(req: Request, env: Env, ctx: ExecutionContext, path: string, _url: URL): Promise<Response> {
  /* ---- 公开端点 ---- */
  if (path === '/api/health' && req.method === 'GET') {
    const t = Date.now();
    const row = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    return json({
      ok: row?.ok === 1,
      now: new Date(t).toISOString(),
      version: '1.0.0',
      db: row?.ok === 1 ? 'connected' : 'error',
    });
  }

  if (path === '/api/workspace' && req.method === 'POST') {
    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
    const limited = createLimiter.check(`create:${ip}`);
    if (!limited.ok) return err(`创建工作区过于频繁，请 ${limited.retryAfter} 秒后再试。`, 429, 'rate-limited');

    const { token, prefix } = generateToken();
    const hash = await sha256Hex(token);
    const id = crypto.randomUUID();
    const name = `工作区 ${id.slice(0, 6)}`;
    await insertWorkspace(env.DB, { id, name, tokenHash: hash, tokenPrefix: prefix, createdAt: Date.now() });
    // 令牌只在这里返回一次，之后无法再查看明文
    return json(
      { token, workspace: { id, name, tokenPrefix: prefix, createdAt: Date.now(), onboarded: false } },
      201,
    );
  }

  /**
   * 用已有令牌「重新进入」工作区。
   *
   * 为什么需要这个端点：数据库只存令牌的 SHA-256 哈希，前端无法自己校验令牌是否有效，
   * 必须让服务端确认一次。同一个令牌就是同一个工作区，不存在「换取新令牌」这回事。
   * 单独限流，防止被用来暴力枚举令牌。
   */
  if (path === '/api/workspace/session' && req.method === 'POST') {
    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
    const limited = sessionLimiter.check(`session:${ip}`);
    if (!limited.ok) return err(`尝试次数过多，请在 ${limited.retryAfter} 秒后再试。`, 429, 'rate-limited');

    const body = (await safeJson(req)) as Record<string, unknown>;
    const raw = typeof body.token === 'string' ? body.token.trim() : '';
    if (!/^pr_[A-Za-z0-9_-]{20,64}$/.test(raw)) {
      return err('令牌格式不正确。它应该以 pr_ 开头，后面是一串随机字符。', 422, 'bad-token-format');
    }
    const hash = await sha256Hex(raw);
    const ws = await getWorkspaceByTokenHash(env.DB, hash);
    if (!ws) {
      return err('这个令牌不存在或已被删除。请检查是否复制完整（包括开头的 pr_）。', 401, 'invalid-token');
    }
    await touchWorkspace(env.DB, ws.id, Date.now());
    return json({
      workspace: {
        id: ws.id,
        name: ws.name,
        tokenPrefix: ws.token_prefix,
        createdAt: ws.created_at,
        onboarded: !!ws.onboarded_at,
      },
    });
  }

  /* ---- 需要认证 ---- */
  const auth = await authenticate(req, env);
  if (auth instanceof Response) return auth;
  const ws = auth.workspace;
  ctx.waitUntil(touchWorkspace(env.DB, ws.id, Date.now()));

  if (path === '/api/quota' && req.method === 'GET') {
    return json(await buildQuota(env.DB, ws, Date.now()));
  }

  if (path === '/api/monitors' && req.method === 'GET') {
    const rows = await listMonitors(env.DB, ws.id);
    const quota = await buildQuota(env.DB, ws, Date.now());
    return json({ monitors: rows.map((r) => sanitizeMonitor(toMonitor(r))), quota });
  }

  /* ---- 演示数据：一次点击创建 3 个带说明的可删监控 ---- */

  if (path === '/api/demo/sample' && req.method === 'GET') {
    // 让前端可以展示「演示会创建什么」，不需要真的创建
    return json({
      demos: DEMO_MONITORS.map((d) => ({
        name: d.name,
        url: demoBaseUrl(req.url, env.DEMO_BASE_URL) + d.path,
        intervalMinutes: d.intervalMinutes,
        extractRule: d.extractRule,
        keyword: d.keyword,
        teaches: d.teaches,
      })),
      existing: await countDemoMonitors(env.DB, ws.id),
    });
  }

  if (path === '/api/demo/sample' && req.method === 'POST') {
    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
    const limited = demoLimiter.check(`demo:${ip}`);
    if (!limited.ok) return err(`操作过于频繁，请 ${limited.retryAfter} 秒后再试。`, 429, 'rate-limited');

    const existing = await countDemoMonitors(env.DB, ws.id);
    if (existing > 0) {
      return err(`你已经加载过演示数据了（当前 ${existing} 个）。如需重来，请先点「清除演示数据」。`, 409, 'demo-exists');
    }

    const total = await countMonitors(env.DB, ws.id);
    const seeds = DEMO_MONITORS.slice(0, Math.max(0, ws.monitors_limit - total));
    if (seeds.length === 0) {
      return err(`监控数量已达上限（${ws.monitors_limit} 个），无法再添加演示数据。请先删除一些监控。`, 409, 'quota-monitors');
    }

    const base = demoBaseUrl(req.url, env.DEMO_BASE_URL);
    const now = Date.now();
    const created: string[] = [];

    for (const seed of seeds) {
      const target = base + seed.path;
      const check = checkUrl(target);
      if (!check.ok || !check.url) {
        // 演示地址本身也应该过一遍安全校验：如果配置错了要立刻暴露，而不是静默创建
        return err(`演示数据地址不合法（${target}）：${check.message}`, 500, 'demo-misconfigured');
      }
      const normalized = normalizeUrlForDedup(check.url);
      if (await findMonitorByUrl(env.DB, ws.id, normalized)) continue;

      const id = crypto.randomUUID();
      await insertMonitor(env.DB, {
        id,
        workspace_id: ws.id,
        name: seed.name,
        url: check.url.href,
        url_normalized: normalized,
        interval_minutes: seed.intervalMinutes,
        extract_rule: seed.extractRule,
        keyword: seed.keyword,
        notify_webhook: null,
        notify_email: 0,
        paused: 0,
        created_at: now,
        updated_at: now,
        // 不立刻排期：让用户自己去点「立即检查」，避免一进来就消耗配额
        next_check_at: now + seed.intervalMinutes * 60_000,
        last_check_at: null,
        last_success_at: null,
        last_error: null,
        last_status: null,
        last_change_at: null,
        last_http_status: null,
        consecutive_failures: 0,
        version: 0,
        retention_days: ws.retention_days,
        is_demo: 1,
      });
      created.push(id);
    }

    await markOnboarded(env.DB, ws.id, now);
    return json({ created: created.length, ids: created, demoBase: base }, 201);
  }

  if (path === '/api/demo/sample' && req.method === 'DELETE') {
    // 先数再删：D1 的 meta.changes 会把外键级联删除的子行（快照/运行记录）也算进去，
    // 直接返回 changes 会得到「删了 5 个监控」这种让用户困惑的数字。
    const before = await countDemoMonitors(env.DB, ws.id);
    await deleteDemoMonitors(env.DB, ws.id);
    return json({ removed: before });
  }

  if (path === '/api/onboarded' && req.method === 'POST') {
    await markOnboarded(env.DB, ws.id, Date.now());
    return json({ ok: true });
  }

  if (path === '/api/monitors' && req.method === 'POST') {
    const body = (await safeJson(req)) as Record<string, unknown>;

    const name = requireString(body.name, '监控名称', 1, 80);
    const rawUrl = requireString(body.url, '网址', 8, 2048);
    const check = checkUrl(rawUrl);
    if (!check.ok || !check.url) return err(check.message ?? '网址不合法。', 422, 'invalid-url');

    const interval = Number(body.intervalMinutes ?? 60);
    if (!ALLOWED_INTERVALS.includes(interval)) {
      return err(`检查间隔必须是 ${ALLOWED_INTERVALS.join(' / ')} 分钟之一。`, 422, 'invalid-interval');
    }
    const extractRule = optionalString(body.extractRule, '提取规则', 200) ?? '';
    const keyword = optionalString(body.keyword, '关键词规则', 200);
    const webhook = optionalString(body.notifyWebhook, 'Webhook 地址', 500);
    if (webhook) {
      const wc = checkUrl(webhook);
      if (!wc.ok) return err(`Webhook 地址不合法：${wc.message}`, 422, 'invalid-webhook');
    }

    const count = await countMonitors(env.DB, ws.id);
    if (count >= ws.monitors_limit) {
      return err(`监控数量已达上限（${ws.monitors_limit} 个）。请删除部分监控后再添加。`, 409, 'quota-monitors');
    }

    const normalized = normalizeUrlForDedup(check.url);
    const existing = await findMonitorByUrl(env.DB, ws.id, normalized);
    if (existing) return err('这个网址已经在你的监控列表里了。', 409, 'duplicate-url');

    const now = Date.now();
    const id = crypto.randomUUID();
    await insertMonitor(env.DB, {
      id,
      workspace_id: ws.id,
      name,
      url: check.url.href,
      url_normalized: normalized,
      interval_minutes: interval,
      extract_rule: extractRule,
      keyword,
      notify_webhook: webhook,
      notify_email: body.notifyEmail === true ? 1 : 0,
      paused: 0,
      created_at: now,
      updated_at: now,
      // 立刻排一次检查，用户不用等一整个周期
      next_check_at: now,
      last_check_at: null,
      last_success_at: null,
      last_error: null,
      last_status: null,
      last_change_at: null,
      last_http_status: null,
      consecutive_failures: 0,
      version: 0,
      retention_days: ws.retention_days,
    });

    const row = await getMonitor(env.DB, ws.id, id);
    if (!row) return err('创建后读取失败。', 500, 'internal');
    return json({ monitor: sanitizeMonitor(toMonitor(row)) }, 201);
  }

  const monitorMatch = path.match(/^\/api\/monitors\/([0-9a-f-]{36})(\/.*)?$/);
  if (monitorMatch) {
    const monitorId = monitorMatch[1];
    const sub = monitorMatch[2] ?? '';
    const monitor = await getMonitor(env.DB, ws.id, monitorId);
    if (!monitor) return err('监控不存在，或不属于当前工作区。', 404, 'not-found');

    if (sub === '' && req.method === 'GET') {
      return json(await buildDetail(env.DB, ws, monitor));
    }
    if (sub === '' && req.method === 'PATCH') {
      const body = (await safeJson(req)) as Record<string, unknown>;
      const patch: Parameters<typeof updateMonitor>[3] = {};
      if (body.name !== undefined) patch.name = requireString(body.name, '监控名称', 1, 80);
      if (body.intervalMinutes !== undefined) {
        const iv = Number(body.intervalMinutes);
        if (!ALLOWED_INTERVALS.includes(iv)) return err(`检查间隔必须是 ${ALLOWED_INTERVALS.join(' / ')} 分钟之一。`, 422, 'invalid-interval');
        patch.intervalMinutes = iv;
        patch.nextCheckAt = Date.now() + iv * 60_000;
      }
      if (body.extractRule !== undefined) patch.extractRule = optionalString(body.extractRule, '提取规则', 200) ?? '';
      if (body.keyword !== undefined) patch.keyword = optionalString(body.keyword, '关键词规则', 200);
      if (body.notifyWebhook !== undefined) {
        const wh = optionalString(body.notifyWebhook, 'Webhook 地址', 500);
        if (wh) {
          const wc = checkUrl(wh);
          if (!wc.ok) return err(`Webhook 地址不合法：${wc.message}`, 422, 'invalid-webhook');
        }
        patch.notifyWebhook = wh;
      }
      if (body.notifyEmail !== undefined) patch.notifyEmail = body.notifyEmail === true;
      if (body.paused !== undefined) {
        patch.paused = body.paused === true;
        if (!patch.paused) patch.nextCheckAt = Date.now();
      }
      const ok = await updateMonitor(env.DB, ws.id, monitorId, patch);
      if (!ok) return err('更新失败。', 500, 'internal');
      const row = await getMonitor(env.DB, ws.id, monitorId);
      return json({ monitor: sanitizeMonitor(toMonitor(row!)) });
    }
    if (sub === '' && req.method === 'DELETE') {
      const ok = await deleteMonitor(env.DB, ws.id, monitorId);
      if (!ok) return err('删除失败。', 500, 'internal');
      return json({ ok: true });
    }
    if (sub === '/check' && req.method === 'POST') {
      const result = await runCheck({
        db: env.DB,
        workspace: ws,
        monitor,
        now: Date.now(),
        manual: true,
        userAgent: env.USER_AGENT ?? USER_AGENT,
        ignoreRobots: false,
      });
      const fresh = await getMonitor(env.DB, ws.id, monitorId);
      return json({ result, monitor: fresh ? sanitizeMonitor(toMonitor(fresh)) : null });
    }
    if (sub === '/snapshots' && req.method === 'GET') {
      const rows = await listSnapshots(env.DB, monitorId, 30);
      return json({ snapshots: rows.map((r) => ({ ...toSnapshot(r), text: r.text.slice(0, 4000) })) });
    }
    if (sub === '/diffs' && req.method === 'GET') {
      const rows = await listDiffs(env.DB, monitorId, 20);
      return json({ diffs: rows.map(toDiff) });
    }
    const snapMatch = sub.match(/^\/snapshots\/([0-9a-f-]{36})$/);
    if (snapMatch && req.method === 'GET') {
      const s = await getSnapshot(env.DB, monitorId, snapMatch[1]);
      if (!s) return err('快照不存在。', 404, 'not-found');
      return json({ snapshot: toSnapshot(s) });
    }
  }

  return err('接口不存在。', 404, 'not-found');
}

async function safeJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > 20_000) throw new ValidationError('请求体过大。');
  if (!text) return {};
  try {
    const v = JSON.parse(text) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ValidationError('请求体必须是 JSON 对象。');
    return v;
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    throw new ValidationError('请求体不是合法的 JSON。');
  }
}

/** 输出给前端前，把 webhook 脱敏（绝不回传明文密钥）。 */
function sanitizeMonitor(m: Monitor): Monitor {
  return {
    ...m,
    notifyWebhook: m.notifyWebhook ? maskWebhook(m.notifyWebhook) : null,
  };
}

/**
 * 自托管的演示页面：内容随 5 分钟槽位变化。
 * 用途：让用户和验收者能在完全可控的页面上确认「定时任务真的在跑、差异真的能检测」。
 * 它不是营销页面，也不收集任何信息。
 */
function demoTicker(_url: URL): Response {
  const now = Date.now();
  const minute = Math.floor(now / 60_000);
  const slot = minute % 5;
  const prices = ['¥99', '¥89', '¥79', '¥69', '¥59'];
  const stocks = ['现货充足', '库存紧张', '仅剩 3 件', '暂时缺货', '已补货'];
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>PageRadar 演示页 · 定时变化</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,-apple-system,'Segoe UI','PingFang SC',sans-serif;max-width:640px;margin:40px auto;padding:0 18px;line-height:1.7;color:#16181d}
code{background:#f0f2f6;padding:1px 5px;border-radius:4px}h1{font-size:22px}.k{color:#5b616e;font-size:14px}
.p{font-size:30px;font-weight:700;margin:8px 0}</style></head>
<body>
<main id="content">
  <h1>PageRadar 演示页</h1>
  <p class="k">这一页的内容随 5 分钟槽位自动变化，用来验证定时抓取与差异检测确实在工作。</p>
  <div class="p" id="price">当前价格：${prices[slot]}</div>
  <p>库存状态：${stocks[slot]}</p>
  <p>更新时间戳：<code>${new Date(now).toISOString()}</code></p>
  <p>分钟槽位：<code>${minute}</code></p>
  <ul>
    <li>把这一页加为监控，间隔 5 分钟，几分钟内就能看到差异。</li>
    <li>内容提取规则可以填 <code>#content</code>。</li>
    <li>关键词规则可以填 <code>缺货</code>，只在缺货时提醒你。</li>
  </ul>
</main>
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function buildDetail(db: D1Database, ws: WorkspaceRow, monitor: MonitorRow): Promise<MonitorDetail> {
  const [snaps, diff, hist, runs, quota] = await Promise.all([
    latestSnapshots(db, monitor.id, 2),
    latestDiff(db, monitor.id),
    listSnapshots(db, monitor.id, 20),
    listRuns(db, monitor.id, 15),
    buildQuota(db, ws, Date.now()),
  ]);
  return {
    monitor: sanitizeMonitor(toMonitor(monitor, hist.length)),
    latest: snaps[0] ? toSnapshot(snaps[0]) : null,
    previous: snaps[1] ? toSnapshot(snaps[1]) : null,
    diff: diff ? toDiff(diff) : null,
    history: hist.map(toSnapshot),
    runs,
    quota,
  };
}

/* ---------------- Cron ---------------- */

const CRON_BATCH = 8;

export async function runCron(env: Env, now: number): Promise<{ processed: number; results: Array<{ id: string; status: string }> }> {
  const holder = crypto.randomUUID();
  const gotLease = await acquireLease(env.DB, 'cron', holder, 55_000, now);
  if (!gotLease) {
    return { processed: 0, results: [] };
  }

  const results: Array<{ id: string; status: string }> = [];
  try {
    const due = await dueMonitors(env.DB, now, CRON_BATCH);
    // 批次内并发，但总量受 CRON_BATCH 限制
    await Promise.all(
      due.map(async (m) => {
        const ws = await env.DB.prepare('SELECT * FROM workspaces WHERE id = ?').bind(m.workspace_id).first<WorkspaceRow>();
        if (!ws) return;
        const r = await runCheck({
          db: env.DB,
          workspace: ws,
          monitor: m,
          now,
          manual: false,
          userAgent: env.USER_AGENT ?? USER_AGENT,
        });
        results.push({ id: m.id, status: r.status });
      }),
    );
  } finally {
    await releaseLease(env.DB, 'cron', holder);
  }
  return { processed: results.length, results };
}
