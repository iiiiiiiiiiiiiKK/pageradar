/**
 * 验证「令牌重新进入」与「演示数据」两条新链路的完整界面操作（线上真实环境）。
 * 用法： node scripts/verify-ui-session-demo.mjs [baseUrl]
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

/* ============ 桌面：创建 → 复制令牌 → 退出 → 用令牌重新进入 → 演示数据 ============ */
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 940 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });

  /* 1. 落地页默认展示「已有令牌」页签 */
  record('落地页默认展示「已有令牌，进入工作区」', await page.getByTestId('tab-restore').getAttribute('aria-selected') === 'true');
  record('落地页有令牌输入框', await page.getByTestId('token-input').isVisible());
  await page.screenshot({ path: join(shots, '14-restore-token.png') });

  /* 2. 切到创建页签并创建工作区 */
  await page.getByTestId('tab-create').click();
  await page.getByTestId('create-workspace').click();
  await page.getByTestId('new-token').waitFor({ timeout: 30000 });
  const token = (await page.getByTestId('new-token').innerText()).trim();
  record('创建工作区后展示令牌', token.startsWith('pr_') && token.length > 20, token.slice(0, 10) + '…');

  /* 3. 令牌面板有「复制」和「下载为 txt」两个出口 */
  record('令牌面板提供复制按钮', await page.getByTestId('copy-token').isVisible());
  record('令牌面板提供下载 txt 按钮', await page.getByTestId('download-token').isVisible());

  const dl = page.waitForEvent('download');
  await page.getByTestId('download-token').click();
  const download = await dl;
  record('令牌可以下载为 txt 备份', download.suggestedFilename().startsWith('pageradar-token-'), download.suggestedFilename());

  await page.screenshot({ path: join(shots, '15-token-actions.png') });
  await page.getByTestId('token-saved').click();
  await page.waitForTimeout(1200);

  /* 4. 进入后看到演示横幅 */
  record('进入工作区后可见演示数据引导横幅', await page.getByTestId('demo-banner').isVisible());

  /* 5. 加载演示数据 */
  await page.getByTestId('load-demo').click();
  await page.getByTestId('demo-active').waitFor({ timeout: 30000 });
  const count = await page.getByTestId('monitor-item').count();
  record('加载演示数据后列表出现 3 个监控', count === 3, `${count} 个`);
  record('列表里演示监控有「演示」标记', (await page.locator('.demo-chip').count()) === 3);
  await page.screenshot({ path: join(shots, '16-demo-loaded.png') });

  /* 6. 点第一个演示监控 → 立即检查 → 看到状态 */
  await page.getByTestId('monitor-item').first().click();
  await page.waitForTimeout(800);
  await page.getByTestId('check-now').click();
  await page.waitForTimeout(4000);
  const detailText = await page.getByTestId('monitor-detail').innerText();
  record('演示监控可以手动检查并立即出结果', /最近检查|首次|快照|无变化/.test(detailText), detailText.slice(0, 60).replace(/\n/g, ' '));
  await page.screenshot({ path: join(shots, '17-demo-checked.png') });

  /* 7. 退出工作区（会弹 confirm，自动接受） */
  page.once('dialog', (d) => d.accept());
  await page.getByTestId('leave-workspace').click();
  await page.waitForTimeout(900);
  record('退出后回到进入页并默认停在「已有令牌」', await page.getByTestId('tab-restore').getAttribute('aria-selected') === 'true');

  /* 8. 用令牌重新进入 —— 这是用户报的核心问题 */
  await page.getByTestId('token-input').fill(token);
  await page.getByTestId('restore-session').click();
  await page.getByTestId('demo-active').waitFor({ timeout: 30000 });
  const monitorsAfter = await page.getByTestId('monitor-item').count();
  record('粘令牌可以回到同一个工作区（数据都在）', monitorsAfter === 3, `${monitorsAfter} 个监控`);
  await page.screenshot({ path: join(shots, '18-restored-workspace.png') });

  /* 9. 错误令牌给出明确错误 */
  page.once('dialog', (d) => d.accept());
  await page.getByTestId('leave-workspace').click();
  await page.waitForTimeout(800);
  await page.getByTestId('token-input').fill('pr_' + 'B'.repeat(43));
  await page.getByTestId('restore-session').click();
  await page.getByTestId('token-error').waitFor({ timeout: 20000 });
  const err = await page.getByTestId('token-error').innerText();
  record('错误令牌显示可理解的错误提示', /不存在|复制完整/.test(err), err.slice(0, 50));
  await page.screenshot({ path: join(shots, '19-token-error.png') });

  /* 10. 正确令牌再次进入并清除演示数据 */
  await page.getByTestId('token-input').fill(token);
  await page.getByTestId('restore-session').click();
  await page.getByTestId('demo-active').waitFor({ timeout: 30000 });
  page.once('dialog', (d) => d.accept());
  await page.getByTestId('clear-demo').click();
  // 等「演示横幅」从 active 变回引导态，说明列表确实刷新了
  await page.getByTestId('demo-banner').waitFor({ timeout: 30000 });
  record(
    '清除演示数据后列表为空',
    (await page.getByTestId('monitor-item').count()) === 0,
    `${await page.getByTestId('monitor-item').count()} 个监控`,
  );

  await ctx.close();
}

/* ============ 移动端：同一流程的关键节点 ============ */
{
  const ctx = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 3 });
  const page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });

  const ov = await page.evaluate(() => ({
    s: document.documentElement.scrollWidth,
    c: document.documentElement.clientWidth,
  }));
  record('[移动] 进入页无横向溢出', ov.s <= ov.c + 1, `${ov.s} <= ${ov.c}`);

  record('[移动] 令牌输入框可见', await page.getByTestId('token-input').isVisible());
  const box = await page.getByTestId('token-input').boundingBox();
  record('[移动] 输入框宽度适配小屏', !!box && box.width <= 390, box ? `${Math.round(box.width)}px` : 'null');
  await page.screenshot({ path: join(shots, '20-mobile-restore.png') });

  // 创建工作区 → 加载演示 → 检查详情在手机上是否可读
  await page.getByTestId('tab-create').click();
  await page.getByTestId('create-workspace').click();
  await page.getByTestId('new-token').waitFor({ timeout: 30000 });
  await page.getByTestId('token-saved').click();
  await page.waitForTimeout(1200);
  await page.getByTestId('load-demo').click();
  await page.getByTestId('demo-active').waitFor({ timeout: 30000 });
  const ov2 = await page.evaluate(() => ({
    s: document.documentElement.scrollWidth,
    c: document.documentElement.clientWidth,
  }));
  record('[移动] 加载演示数据后仍无横向溢出', ov2.s <= ov2.c + 1, `${ov2.s} <= ${ov2.c}`);
  await page.screenshot({ path: join(shots, '21-mobile-demo.png') });

  await ctx.close();
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name} (${f.detail})`);
  process.exit(1);
}
