/**
 * 移动端布局专项验证（针对用户反馈的三个问题）。
 *  1. 总览栏按钮组必须排成一行，不换行
 *  2. 详情区网址必须单行截断、不被挤成左侧窄条
 *  3. 页脚必须分行对齐，不出现散落的「·」分隔符
 *
 * 用法： node scripts/verify-layout.mjs [baseUrl]
 */
import { chromium, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const BASE = (process.argv[2] ?? 'https://pageradar.852367856.dpdns.org').replace(/\/$/, '');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, 'docs', 'screenshots');
mkdirSync(shots, { recursive: true });

const results = [];
const record = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const DEVICES = [
  { label: 'iPhone SE 375', device: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  { label: 'iPhone 13 390', device: { ...devices['iPhone 13'] } },
  { label: 'iPhone Pro Max 430', device: { ...devices['Desktop Chrome'], viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } },
  { label: '小屏 320', device: { ...devices['Desktop Chrome'], viewport: { width: 320, height: 700 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
];

for (const { label, device } of DEVICES) {
  const ctx = await browser.newContext(device);
  const page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });

  // 创建工作区并加载演示数据（需要多行网址来验证详情区）
  await page.getByTestId('tab-create').click();
  await page.getByTestId('create-workspace').click();
  await page.getByTestId('new-token').waitFor({ timeout: 30000 });
  await page.getByTestId('token-saved').click();
  await page.waitForTimeout(1200);
  await page.getByTestId('load-demo').click();
  await page.getByTestId('demo-active').waitFor({ timeout: 30000 });
  await page.waitForTimeout(700);

  /* ---------- 1. 总览栏：按钮组单行 ---------- */
  const bar = await page.evaluate(() => {
    const inner = document.querySelector('.overview-bar-inner');
    const actions = document.querySelector('.overview-actions');
    if (!inner || !actions) return null;
    const kids = Array.from(actions.querySelectorAll('button'));
    const tops = kids.map((b) => Math.round(b.getBoundingClientRect().top));
    const bottoms = kids.map((b) => Math.round(b.getBoundingClientRect().bottom));
    return {
      barHeight: Math.round(inner.getBoundingClientRect().height),
      rows: new Set(tops).size,
      tops,
      actionWidth: Math.round(actions.getBoundingClientRect().width),
      innerWidth: Math.round(inner.getBoundingClientRect().width),
      tallest: Math.max(...bottoms) - Math.min(...tops),
      labels: kids.map((b) => (b.innerText || b.textContent).trim().replace(/\s+/g, ' ')),
    };
  });
  record(`[${label}] 总览栏按钮排成一行（不换行）`, bar?.rows === 1, `${bar?.rows} 行 · ${bar?.labels?.join(' | ')}`);
  record(
    `[${label}] 总览栏高度紧凑（单行）`,
    !!bar && bar.barHeight <= 44,
    `${bar?.barHeight}px（按钮跨度 ${bar?.tallest}px）`,
  );
  record(
    `[${label}] 总览栏未横向溢出`,
    !!bar && bar.actionWidth <= bar.innerWidth,
    `${bar?.actionWidth} <= ${bar?.innerWidth}`,
  );

  /* ---------- 2. 详情区网址：单行、撑满宽度、不挤在左边 ---------- */
  await page.getByTestId('monitor-item').last().click();
  await page.getByTestId('monitor-detail').waitFor({ timeout: 30000 });
  await page.locator('.detail-url').waitFor({ timeout: 30000 });
  await page.waitForTimeout(400);
  const url = await page.evaluate(() => {
    const link = document.querySelector('.detail-url');
    const main = document.querySelector('.detail-head-main');
    const head = document.querySelector('.detail-head');
    if (!link || !main || !head) return null;
    const lr = link.getBoundingClientRect();
    const mr = main.getBoundingClientRect();
    const hr = head.getBoundingClientRect();
    const host = link.querySelector('.detail-url-host');
    const path = link.querySelector('.detail-url-path');
    return {
      linkWidth: Math.round(lr.width),
      linkHeight: Math.round(lr.height),
      mainWidth: Math.round(mr.width),
      headWidth: Math.round(hr.width),
      hostPathSameLine: !!host && !!path && Math.abs(host.getBoundingClientRect().top - path.getBoundingClientRect().top) < 3,
      scrollW: Math.round(document.documentElement.scrollWidth),
      clientW: Math.round(document.documentElement.clientWidth),
    };
  });
  record(
    `[${label}] 网址区撑满可用宽度（不挤成左侧窄条）`,
    !!url && url.linkWidth >= url.mainWidth - 4,
    `${url?.linkWidth} / ${url?.mainWidth}`,
  );
  record(`[${label}] 网址单行显示（高度 ≤ 22px）`, !!url && url.linkHeight <= 22, `${url?.linkHeight}px`);
  record(`[${label}] 主机名与路径在同一行`, url?.hostPathSameLine === true);
  record(`[${label}] 详情区无横向溢出`, !!url && url.scrollW <= url.clientW + 1, `${url?.scrollW} <= ${url?.clientW}`);

  /* ---------- 3. 页脚：分行对齐 ---------- */
  const footer = await page.evaluate(() => {
    const f = document.querySelector('.footer-inner');
    if (!f) return null;
    const rows = Array.from(f.querySelectorAll('.footer-row'));
    const seps = Array.from(document.querySelectorAll('.footer-sep')).map((s) => {
      const r = s.getBoundingClientRect();
      return { top: Math.round(r.top), left: Math.round(r.left) };
    });
    return {
      rowCount: rows.length,
      rowTops: rows.map((r) => Math.round(r.getBoundingClientRect().top)),
      footerHeight: Math.round(f.getBoundingClientRect().height),
      seps,
      text: f.innerText.replace(/\n/g, ' ⏎ '),
      scrollW: Math.round(document.documentElement.scrollWidth),
      clientW: Math.round(document.documentElement.clientWidth),
    };
  });
  record(`[${label}] 页脚分成 3 个语义行`, footer?.rowCount === 3, `${footer?.rowCount} 行`);
  record(
    `[${label}] 页脚各行垂直分列（不是挤在一行里换行）`,
    !!footer && new Set(footer.rowTops).size === 3,
    footer?.rowTops?.join(' / '),
  );
  record(`[${label}] 页脚无横向溢出`, !!footer && footer.scrollW <= footer.clientW + 1, `${footer?.scrollW} <= ${footer?.clientW}`);
  record(`[${label}] 页脚内容完整`, !!footer && /PageRadar/.test(footer.text) && /Cloudflare Workers/.test(footer.text) && /0xkillcoin/.test(footer.text), footer?.text?.slice(0, 90));

  if (label.startsWith('iPhone 13')) {
    // 元素级截图：比整页截图更能说明这次修的是什么
    await page.locator('.overview-bar').screenshot({ path: join(shots, '22-mobile-overview-bar.png') });
    await page.getByTestId('monitor-item').last().click();
    await page.getByTestId('monitor-detail').waitFor({ timeout: 30000 });
    await page.locator('.detail-url').waitFor({ timeout: 30000 });
    await page.waitForTimeout(400);
    await page.locator('.detail-head').screenshot({ path: join(shots, '23-mobile-detail-url.png') });
    await page.locator('.footer').screenshot({ path: join(shots, '24-mobile-footer.png') });
  }

  await ctx.close();
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name} (${f.detail})`);
  process.exit(1);
}
