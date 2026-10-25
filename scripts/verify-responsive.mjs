/**
 * PageRadar 自适应验证（跑线上部署）。
 * 用法： node scripts/verify-responsive.mjs [baseUrl]
 */
import { chromium, devices } from '@playwright/test';

const BASE = (process.argv[2] ?? 'https://pageradar.852367856.dpdns.org').replace(/\/$/, '');
const results = [];
const record = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();

/* ---------- 多宽度无横向溢出 ---------- */
for (const width of [320, 375, 390, 414, 768, 1024, 1366]) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });

  const ov = await page.evaluate(() => ({
    s: document.documentElement.scrollWidth,
    c: document.documentElement.clientWidth,
  }));
  record(`落地页 @${width}px 无横向溢出`, ov.s <= ov.c + 1, `${ov.s} <= ${ov.c}`);

  const x = page.getByTestId('x-link');
  const visible = await x.isVisible();
  const box = await x.boundingBox();
  record(
    `落地页 @${width}px 𝕏 入口可见且可点`,
    visible && !!box && box.width >= 30 && box.height >= 30,
    box ? `${Math.round(box.width)}×${Math.round(box.height)}` : 'null',
  );
  await ctx.close();
}

/* ---------- 工作区内部布局 ---------- */
{
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });

  // 创建工作区（落地页现在默认停在「已有令牌」页签，需先切到创建页签）
  await page.getByTestId('tab-create').click();
  await page.getByTestId('create-workspace').click();
  await page.getByTestId('new-token').waitFor({ timeout: 30000 });
  await page.getByTestId('token-saved').click();
  await page.waitForTimeout(1500);

  const ov = await page.evaluate(() => ({
    s: document.documentElement.scrollWidth,
    c: document.documentElement.clientWidth,
  }));
  record('iPhone 视口工作区无横向溢出', ov.s <= ov.c + 1, `${ov.s} <= ${ov.c}`);

  // 添加弹窗在小屏上可用
  await page.getByTestId('add-monitor').click();
  await page.waitForTimeout(500);
  const modal = page.locator('.modal');
  record('iPhone 视口添加弹窗可见', await modal.isVisible());
  const modalBox = await modal.boundingBox();
  record('弹窗宽度不超出视口', !!modalBox && modalBox.width <= 390, modalBox ? `${Math.round(modalBox.width)}px` : 'null');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  record('Esc 可以关闭弹窗', !(await modal.isVisible().catch(() => false)));

  await page.screenshot({ path: new URL('../docs/screenshots/13-mobile-responsive.png', import.meta.url).pathname.replace(/^\//, '') });
  await ctx.close();
}

/* ---------- 深色模式 ---------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await ctx.newPage();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  const colors = await page.evaluate(() => {
    const b = getComputedStyle(document.body);
    const h1 = document.querySelector('h1');
    return { bg: b.backgroundColor, fg: h1 ? getComputedStyle(h1).color : '' };
  });
  const rgb = colors.bg.match(/\d+/g).map(Number);
  const luma = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  record('深色模式背景确实变暗', luma < 0.3, `luma=${luma.toFixed(3)} bg=${colors.bg}`);
  record('深色模式文字颜色已设置', colors.fg !== '', colors.fg);
  await ctx.close();
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name} (${f.detail})`);
  process.exit(1);
}
