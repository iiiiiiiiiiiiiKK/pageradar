/**
 * 认证与授权。
 *
 * 设计：不使用邮箱+密码（避免密码泄露风险与邮件服务依赖），
 * 而是「工作区令牌」模式：
 *   1. 用户首次访问 → POST /api/workspace 创建一个工作区
 *   2. 服务端生成 32 字节随机令牌，只返回一次明文
 *   3. 数据库只存 SHA-256 哈希与 8 字符前缀（用于界面展示脱敏）
 *   4. 之后每个请求带 Authorization: Bearer <token>
 *
 * 令牌本身是高熵随机值，因此用 SHA-256 存哈希即可（不需要慢哈希；
 * 慢哈希是为了抵抗低熵口令的暴力破解，随机 256 位令牌没有这个问题）。
 */

export const TOKEN_PREFIX = 'pr_';

export function generateToken(): { token: string; prefix: string } {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const body = base64url(bytes);
  const token = TOKEN_PREFIX + body;
  return { token, prefix: token.slice(0, 12) };
}

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function extractBearer(req: Request): string | null {
  const auth = req.headers.get('authorization');
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  // 基本格式校验，避免把奇怪的东西送去查库
  if (!/^pr_[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  return token;
}

/** 简单的内存速率限制（同一 Worker isolate 内）。配合 D1 计数做真正的配额。 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private limit: number,
    private windowMs: number,
  ) {}

  check(key: string, now = Date.now()): { ok: boolean; remaining: number; retryAfter: number } {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.limit) {
      const retryAfter = Math.ceil((this.windowMs - (now - arr[0])) / 1000);
      this.hits.set(key, arr);
      return { ok: false, remaining: 0, retryAfter };
    }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 5000) {
      // 防止 map 无限增长
      for (const [k, v] of this.hits) {
        if (v.length === 0 || now - v[v.length - 1] > this.windowMs) this.hits.delete(k);
      }
    }
    return { ok: true, remaining: this.limit - arr.length, retryAfter: 0 };
  }
}

export const apiLimiter = new RateLimiter(120, 60_000);
export const createLimiter = new RateLimiter(10, 60_000);
/** 用已有令牌重新进入工作区的尝试次数（防令牌枚举）。 */
export const sessionLimiter = new RateLimiter(20, 60_000);
/** 加载演示数据的次数（演示数据本身也占真实配额）。 */
export const demoLimiter = new RateLimiter(6, 60_000);
