/**
 * 演示数据种子。
 *
 * 用户第一次进来往往不知道「内容提取规则」「关键词规则」该怎么填，
 * 也不知道差异长什么样。所以提供一组真实可用的演示监控：
 * 目标是我们自己托管的演示页（内容会自然变化），每个都带有可直接模仿的规则配置。
 *
 * 设计约束：
 *  - 演示监控打上 is_demo = 1，可一键清除，不与真实监控混淆
 *  - 只创建 3 个，并且不自动执行检查（避免一次点击就吃掉 3 次配额）
 *  - URL 从当前请求的 origin 推导，这样本地开发、预览、生产都能用
 */

export interface DemoSeed {
  name: string;
  /** 相对路径，拼到 demo 根地址上。 */
  path: string;
  intervalMinutes: number;
  extractRule: string;
  keyword: string | null;
  /** 给用户看的说明：这个演示在教什么。 */
  teaches: string;
}

export const DEMO_MONITORS: DemoSeed[] = [
  {
    name: '演示 · 库存价格看板（会自然变化）',
    path: '/',
    intervalMinutes: 5,
    extractRule: '#content',
    keyword: '缺货',
    teaches: '最典型的用法：盯一个会变的页面。间隔 5 分钟，只比对 #content 区域，关键词规则让它在「缺货」时才算命中。',
  },
  {
    name: '演示 · 交替内容页（30 秒翻转）',
    path: '/alternating',
    intervalMinutes: 5,
    extractRule: '#content',
    keyword: null,
    teaches: '想看差异长什么样？这个页面每 30 秒翻转一次内容，等一个检查周期就能看到真实的新增/删除高亮。',
  },
  {
    name: '演示 · 固定内容页（不会变化）',
    path: '/static',
    intervalMinutes: 60,
    extractRule: '#content',
    keyword: null,
    teaches: '对照组：这一页永远不变。用来观察「无变化」状态、以及重复检查不会产生多余快照。',
  },
];

/**
 * 演示页的根地址。
 *
 * 生产环境的演示页部署在独立域名（demo-worker），因为主 Worker 抓自己的域名
 * 会形成子请求递归被 Cloudflare 拒绝（522）。
 * 优先用环境变量 DEMO_BASE_URL；没配置时退回「按 pageradar.* → demo-pageradar.* 推导」，
 * 再不行就用当前 origin（本地开发）。
 */
export function demoBaseUrl(requestUrl: string, envDemoBase?: string): string {
  if (envDemoBase && envDemoBase.trim()) return envDemoBase.trim().replace(/\/+$/, '');
  const u = new URL(requestUrl);
  if (u.hostname.startsWith('pageradar.')) return `${u.protocol}//demo-${u.hostname}`;
  return u.origin;
}
