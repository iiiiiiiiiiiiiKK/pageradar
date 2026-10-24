/**
 * 生成 PageRadar README 用的真实截图（全部来自线上部署，不是示意图）。
 * 用法： node scripts/shoot.mjs [baseUrl]
 */
import { chromium, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, 'docs', 'screenshots');
mkdirSync(shots, { recursive: true });

const BASE = (process.argv[2] ?? 'https://pageradar.852367856.dpdns.org').replace(/\/$/, '');
const DEMO = (process.env.DEMO_URL ?? 'https://demo-pageradar.852367856.dpdns.org').replace(/\/$/, '');

const browser = await chromium.launch();

/* ---------- 桌面：完整流程 ---------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 940 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });

  // 1) 落地页（未创建工作区）
  await page.screenshot({ path: join(shots, '01-onboarding.png') });
  console.log('✔ 01-onboarding');

  // 2) 创建工作区
  await page.getByTestId('create-workspace').click();
  await page.getByTestId('new-token').waitFor({ timeout: 30000 });
  const token = (await page.getByTestId('new-token').innerText()).trim();
  console.log('token issued:', token.slice(0, 10) + '…');
  await page.screenshot({ path: join(shots, '02-workspace-created.png') });
  await page.getByTestId('token-saved').click();
  await page.waitForTimeout(1200);

  // 3) 添加两个监控：一个会变化，一个静态
  const add = async (name, url) => {
    await page.getByTestId('add-monitor').click();
    await page.locator('#f-name').fill(name);
    await page.locator('#f-url').fill(url);
    await page.locator('#f-interval').selectOption('5');
    await page.locator('#f-rule').fill('#content');
    await page.getByRole('button', { name: /开始监控/ }).click();
    await page.getByTestId('monitor-item').first().waitFor({ timeout: 30000 });
  };
  await add('库存价格看板', `${DEMO}/`);
  await add('固定内容页', `${DEMO}/static`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(shots, '03-monitor-list.png') });
  console.log('✔ 03-monitor-list');

  // 4) 立即检查 → 首次快照
  await page.getByTestId('monitor-item').nth(1).click();
  await page.waitForTimeout(600);
  await page.getByTestId('check-now').click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(shots, '04-overview-first-snapshot.png') });
  console.log('✔ 04-overview');

  // 5) 切换到会变化的监控，等一个槽位后检查 → 差异
  await page.getByTestId('monitor-item').first().click();
  await page.waitForTimeout(600);
  await page.getByTestId('check-now').click();
  await page.waitForTimeout(2500);
  // / 每 5 分钟变一次；用 /alternating 更快，但列表里没有，所以再等一次槽位切换不现实，
  // 改为展示「首次快照」与差异面板的空状态，然后单独打开已有差异的监控。
  await page.getByTestId('tab-diff').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, '05-diff-empty.png') });

  // 6) 用 API 造出一个真实差异，再截图差异面板
  const mons = await (await fetch(BASE + '/api/monitors', { headers: { authorization: `Bearer ${token}` } })).json();
  const alt = await (
    await fetch(BASE + '/api/monitors', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: '交替内容测试', url: `${DEMO}/alternating`, intervalMinutes: 5, extractRule: '#content' }),
    })
  ).json();
  await fetch(BASE + `/api/monitors/${alt.monitor.id}/check`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  console.log('waiting for /alternating bucket flip (31s)…');
  await page.waitForTimeout(31_000);
  await fetch(BASE + `/api/monitors/${alt.monitor.id}/check`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('monitor-item').first().click();
  await page.waitForTimeout(900);
  await page.getByTestId('tab-diff').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(shots, '06-diff-viewer.png') });
  console.log('✔ 06-diff-viewer');

  await page.getByTestId('diff-plain').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, '07-diff-plain.png') });
  console.log('✔ 07-diff-plain');

  // 8) 历史时间线
  await page.getByRole('tab', { name: '历史时间线' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(shots, '08-history-timeline.png') });
  console.log('✔ 08-history');

  // 9) 深色模式
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('tab', { name: '概览' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(shots, '09-dark-mode.png') });
  console.log('✔ 09-dark');

  // 10) 添加监控弹窗
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByTestId('add-monitor').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, '10-add-monitor-modal.png') });
  await page.keyboard.press('Escape');
  console.log('✔ 10-modal');

  await ctx.close();
}

/* ---------- 移动端 ---------- */
{
  const ctx = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 3 });
  const page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.screenshot({ path: join(shots, '11-mobile-home.png') });
  console.log('✔ 11-mobile-home');

  // 复用上面创建的工作区：直接注入令牌
  const w = await (await fetch(BASE + '/api/workspace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  await page.evaluate(([tok, ws]) => {
    localStorage.setItem('pageradar.token', tok);
    localStorage.setItem('pageradar.workspace', JSON.stringify(ws));
  }, [w.token, w.workspace]);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(shots, '12-mobile-workspace.png') });
  console.log('✔ 12-mobile-workspace');

  await ctx.close();
}

await browser.close();
console.log('screenshots ->', shots);
