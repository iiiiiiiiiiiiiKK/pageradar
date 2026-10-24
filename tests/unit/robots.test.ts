import { describe, expect, it } from 'vitest';
import { parseRobots, robotsAllows } from '../../src/worker/fetch/fetcher.ts';

const ROBOTS = `
# 通用规则
User-agent: *
Disallow: /admin/
Disallow: /private
Allow: /private/public-page
Crawl-delay: 2

User-agent: PageRadarBot
Disallow: /no-radar/
`;

describe('robots.txt 解析', () => {
  it('解析 * 组', () => {
    const r = parseRobots(ROBOTS, 'SomeOtherBot');
    expect(r.disallow).toContain('/admin/');
    expect(r.disallow).toContain('/private');
    expect(r.allow).toContain('/private/public-page');
    expect(r.crawlDelay).toBe(2);
  });

  it('优先匹配具体 UA 组', () => {
    const r = parseRobots(ROBOTS, 'PageRadarBot/1.0');
    expect(r.disallow).toEqual(['/no-radar/']);
  });

  it('禁止路径判定', () => {
    const r = parseRobots(ROBOTS, 'OtherBot');
    expect(robotsAllows(r, '/admin/users')).toBe(false);
    expect(robotsAllows(r, '/about')).toBe(true);
    expect(robotsAllows(r, '/private/data')).toBe(false);
    // 更长的 Allow 规则优先
    expect(robotsAllows(r, '/private/public-page')).toBe(true);
  });

  it('拿不到 robots.txt 时视为允许', () => {
    const r = { disallow: [], allow: [], fetchedAt: Date.now(), unavailable: true };
    expect(robotsAllows(r, '/anything')).toBe(true);
  });

  it('空 Disallow 表示全站允许', () => {
    const r = parseRobots('User-agent: *\nDisallow:', 'bot');
    expect(robotsAllows(r, '/anything')).toBe(true);
  });

  it('通配符规则', () => {
    const r = parseRobots('User-agent: *\nDisallow: /*.pdf$', 'bot');
    expect(robotsAllows(r, '/files/doc.pdf')).toBe(false);
    expect(robotsAllows(r, '/files/doc.html')).toBe(true);
  });
});
