import { describe, expect, it } from 'vitest';
import { nextCheckFrom, slotFor } from '../../src/worker/checks/runner.ts';
import { maskWebhook } from '../../src/worker/notify/webhook.ts';
import { countWords } from '../../src/worker/extract/html.ts';
import { generateToken, extractBearer, sha256Hex } from '../../src/worker/auth/auth.ts';

describe('调度槽位', () => {
  it('同一间隔内的多个时间点落在同一槽位', () => {
    const base = Date.UTC(2024, 0, 1, 12, 0, 0);
    const s1 = slotFor(base, 5);
    const s2 = slotFor(base + 90_000, 5); // +1.5 分钟
    const s3 = slotFor(base + 299_000, 5); // +4分59秒
    expect(s1).toBe(s2);
    expect(s1).toBe(s3);
  });

  it('跨越间隔边界后进入下一个槽位', () => {
    const base = Date.UTC(2024, 0, 1, 12, 0, 0);
    expect(slotFor(base + 300_000, 5)).toBe(slotFor(base, 5) + 300_000);
  });

  it('槽位对齐到整间隔', () => {
    const s = slotFor(Date.UTC(2024, 0, 1, 12, 7, 33), 15);
    expect(s % (15 * 60_000)).toBe(0);
  });

  it('下一次检查时间 = 现在 + 间隔', () => {
    const now = 1_700_000_000_000;
    expect(nextCheckFrom(now, 60)).toBe(now + 3_600_000);
    expect(nextCheckFrom(now, 5)).toBe(now + 300_000);
  });

  it('间隔为 0 或负数时按 1 分钟处理（不产生死循环排期）', () => {
    const now = 1_700_000_000_000;
    expect(nextCheckFrom(now, 0)).toBe(now + 60_000);
    expect(slotFor(now, 0)).toBe(slotFor(now, 1));
  });
});

describe('Webhook 脱敏', () => {
  it('保留主机名，隐藏路径细节', () => {
    const m = maskWebhook('https://hooks.example.com/services/T000/B000/XXXXSECRET');
    expect(m).toContain('hooks.example.com');
    expect(m).not.toContain('XXXXSECRET');
    expect(m?.endsWith('…')).toBe(true);
  });

  it('空值返回 null', () => {
    expect(maskWebhook(null)).toBeNull();
  });

  it('非法 URL 也做截断处理', () => {
    const m = maskWebhook('not-a-url-but-very-long-string');
    expect(m).toContain('…');
  });
});

describe('词数统计', () => {
  it('中文按字计', () => {
    expect(countWords('你好世界')).toBe(4);
  });

  it('英文按词计', () => {
    expect(countWords('hello world foo')).toBe(3);
  });

  it('中英混合', () => {
    expect(countWords('价格 99 元')).toBe(4);
  });

  it('空文本为 0', () => {
    expect(countWords('')).toBe(0);
  });
});

describe('令牌', () => {
  it('生成的令牌有前缀且足够长', () => {
    const { token, prefix } = generateToken();
    expect(token.startsWith('pr_')).toBe(true);
    expect(token.length).toBeGreaterThan(30);
    expect(prefix).toBe(token.slice(0, 12));
  });

  it('每次生成都不同', () => {
    const a = generateToken().token;
    const b = generateToken().token;
    expect(a).not.toBe(b);
  });

  it('哈希稳定且不可逆', async () => {
    const h1 = await sha256Hex('pr_abc');
    const h2 = await sha256Hex('pr_abc');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
    expect(h1).not.toContain('pr_abc');
  });

  it('从 Authorization 头提取令牌', () => {
    const { token } = generateToken();
    const req = new Request('https://x.test/', { headers: { authorization: `Bearer ${token}` } });
    expect(extractBearer(req)).toBe(token);
  });

  it('拒绝格式错误的 Authorization 头', () => {
    const cases = ['', 'Bearer', 'Basic abc', 'Bearer short', 'Bearer ' + 'x'.repeat(200)];
    for (const auth of cases) {
      const req = new Request('https://x.test/', { headers: auth ? { authorization: auth } : {} });
      expect(extractBearer(req), auth).toBeNull();
    }
  });
});
