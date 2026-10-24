/**
 * PageRadar 演示 / 测试目标页（独立部署的 Worker）。
 *
 * 为什么单独部署：如果主 Worker 抓取自己域名下的路径，会形成 Worker 子请求递归，
 * Cloudflare 返回 522。因此测试目标必须是一个独立的脚本与独立域名。
 *
 * 提供的端点：
 *   GET /                 内容随 5 分钟槽位变化（用于验证真实变化检测）
 *   GET /robots.txt       显式允许抓取
 *   GET /redirect/N       N 跳 302 后回到 /
 *   GET /to-metadata      302 跳转到 169.254.169.254（验证 SSRF 防护能拦住恶意重定向）
 *   GET /to-localhost     302 跳转到 http://127.0.0.1/（同上）
 *   GET /slow?ms=3000     延迟响应（验证超时）
 *   GET /json             返回 application/json（验证 content-type 拒绝）
 *   GET /empty            返回空白正文（验证空正文处理）
 *   GET /403              返回 403
 *
 * 不收集任何信息，不含任何脚本。
 */

const PRICES = ['¥99', '¥89', '¥79', '¥69', '¥59'];
const STOCKS = ['现货充足', '库存紧张', '仅剩 3 件', '暂时缺货', '已补货'];
const NOTES = [
  '本周新增两个数据源。',
  '供应商调整了结算周期。',
  '库存同步出现 12 分钟延迟。',
  '暂时缺货，预计 48 小时内补货。',
  '已完成补货，价格维持不变。',
];

function page(now) {
  const minute = Math.floor(now / 60_000);
  const slot = minute % 5;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>PageRadar 演示页 · 每 5 分钟变化</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:system-ui,-apple-system,'Segoe UI','PingFang SC',sans-serif;max-width:660px;margin:36px auto;padding:0 18px;line-height:1.7;color:#16181d}
h1{font-size:22px;letter-spacing:-.02em}code{background:#f0f2f6;padding:1px 5px;border-radius:4px;font-size:.9em}
.muted{color:#5b616e;font-size:14px}.price{font-size:32px;font-weight:700;margin:10px 0;letter-spacing:-.02em}
.card{border:1px solid #e2e5ec;border-radius:12px;padding:14px 16px;margin:14px 0;background:#fbfcfd}
ul{padding-left:20px}li{margin:4px 0}
</style></head>
<body>
<main id="content">
  <h1>库存与价格看板</h1>
  <p class="muted">这一页的内容随 5 分钟槽位变化，用来验证 PageRadar 的定时抓取与差异检测。</p>
  <div class="card">
    <div class="price" id="price">当前价格：${PRICES[slot]}</div>
    <p>库存状态：<strong>${STOCKS[slot]}</strong></p>
    <p class="muted">${NOTES[slot]}</p>
  </div>
  <p>更新时间：<code>${new Date(now).toISOString()}</code></p>
  <p>槽位编号：<code>${slot}</code>（分钟 ${minute}）</p>
  <ul>
    <li>建议监控间隔：5 分钟</li>
    <li>内容提取规则：<code>#content</code></li>
    <li>关键词规则示例：<code>缺货</code></li>
  </ul>
</main>
</body></html>`;
}

const HTML = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const origin = url.origin;
    const path = url.pathname;

    if (path === '/robots.txt') {
      return new Response('User-agent: *\nAllow: /\n', {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    if (path === '/' || path === '/ticker' || path === '/demo/ticker') {
      return new Response(page(Date.now()), { headers: HTML });
    }

    // 每 30 秒翻转一次的页面：用于在几十秒内验证真实的「内容变化 → 快照 → 差异」链路
    if (path === '/alternating') {
      const bucket = Math.floor(Date.now() / 30_000);
      const on = bucket % 2 === 0;
      return new Response(
        `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>交替测试页</title></head>
<body><main id="content"><h1>交替内容测试</h1>
<p>状态：<strong>${on ? 'A · 已开启' : 'B · 已关闭'}</strong></p>
<p>标记行：${on ? 'alpha-alpha alpha-alpha' : 'beta'}</p>
<p>槽位：<code>${bucket}</code></p></main></body></html>`,
        { headers: HTML },
      );
    }

    // 静态正文：用于验证「内容未变化」与幂等（不写入新快照）
    if (path === '/static' || path === '/static/v1') {
      const body = String(url.searchParams.get('v') ?? '1');
      return new Response(
        `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>静态测试页 v${body}</title></head>
<body><main id="content"><h1>固定内容</h1><p>这一页的正文永远不会变化，用来验证 nochange 与幂等。</p>
<p>版本标记：<code>v${body}</code></p></main></body></html>`,
        { headers: HTML },
      );
    }

    const redirectMatch = path.match(/^\/redirect\/(\d+)$/);
    if (redirectMatch) {
      const n = Number(redirectMatch[1]);
      const next = n <= 1 ? `${origin}/` : `${origin}/redirect/${n - 1}`;
      return new Response(null, { status: 302, headers: { location: next, 'cache-control': 'no-store' } });
    }

    // 恶意重定向：指向云元数据地址 —— PageRadar 必须在第二跳拦下
    if (path === '/to-metadata') {
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/', 'cache-control': 'no-store' },
      });
    }
    if (path === '/to-localhost') {
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8080/admin', 'cache-control': 'no-store' } });
    }

    if (path === '/slow') {
      const ms = Math.min(60_000, Number(url.searchParams.get('ms') ?? '3000') || 3000);
      await new Promise((r) => setTimeout(r, ms));
      return new Response('<html><body><main id="content">slow response done</main></body></html>', { headers: HTML });
    }

    if (path === '/json') {
      return new Response(JSON.stringify({ hello: 'world' }), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    if (path === '/empty') {
      return new Response('<html><body><div id="content">   </div></body></html>', { headers: HTML });
    }

    if (path === '/403') {
      return new Response('Forbidden', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
};
