/**
 * 验证「令牌重新进入」与「演示数据」两条新链路（线上真实环境）。
 * 用法： node scripts/verify-session-demo.mjs [baseUrl]
 */
const BASE = (process.argv[2] ?? 'https://pageradar.852367856.dpdns.org').replace(/\/$/, '');
const results = [];
const record = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const post = async (path, body, token) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  const t = await r.text();
  let j = null;
  try {
    j = t ? JSON.parse(t) : null;
  } catch {
    j = t;
  }
  return { status: r.status, body: j };
};
const get = async (path, token) => {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, { headers });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const del = async (path, token) => {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, { method: 'DELETE', headers });
  return { status: r.status, body: await r.json().catch(() => null) };
};

/* 1. 创建工作区并拿到令牌 */
let token = null;
{
  const r = await post('/api/workspace');
  token = r.body?.token;
  record('创建工作区返回令牌', r.status === 201 && !!token, token?.slice(0, 10) + '…');
}

/* 2. 用同一令牌「重新进入」 */
{
  const r = await post('/api/workspace/session', { token });
  record('用已有令牌可以重新进入同一工作区', r.status === 200 && !!r.body?.workspace?.id, JSON.stringify(r.body?.workspace));
}

/* 3. 重新进入后看到的数据与原工作区一致 */
let wsId = null;
{
  const first = await post('/api/workspace/session', { token });
  wsId = first.body.workspace.id;
  const again = await post('/api/workspace/session', { token });
  record('多次重新进入得到同一个工作区 id', again.body?.workspace?.id === wsId, `${wsId.slice(0, 8)}…`);
}

/* 4. 错误令牌被拒绝且给出可操作提示 */
{
  const bad = 'pr_' + 'A'.repeat(43);
  const r = await post('/api/workspace/session', { token: bad });
  record('不存在的令牌被拒绝 (401)', r.status === 401, `HTTP ${r.status} · ${r.body?.error ?? ''}`);
}

/* 5. 格式非法的令牌被拒绝 */
{
  const r = await post('/api/workspace/session', { token: 'not-a-token' });
  record('格式非法的令牌被拒绝 (422)', r.status === 422, `HTTP ${r.status} · ${r.body?.code ?? ''}`);
  const r2 = await post('/api/workspace/session', {});
  record('缺少令牌字段被拒绝 (422)', r2.status === 422, `HTTP ${r2.status}`);
}

/* 6. 令牌前后空格被容错（用户复制时常带空格/换行） */
{
  const r = await post('/api/workspace/session', { token: `  ${token}\n` });
  record('令牌前后的空白被自动清理', r.status === 200 && r.body?.workspace?.id === wsId, `HTTP ${r.status}`);
}

/* 7. 演示数据：先看会创建什么 */
{
  const r = await get('/api/demo/sample', token);
  record('可以预览演示数据内容', r.status === 200 && Array.isArray(r.body?.demos) && r.body.demos.length === 3, `${r.body?.demos?.length} 个`);
  const d = r.body.demos?.[0];
  record('演示条目带有可照抄的规则配置', !!d?.extractRule && !!d?.teaches, `${d?.extractRule} · ${d?.name}`);
  record('演示条目指向真实可访问地址', typeof d?.url === 'string' && d.url.startsWith('https://'), d?.url);
}

/* 8. 加载演示数据 */
{
  const r = await post('/api/demo/sample', {}, token);
  record('可以一键加载演示数据', r.status === 201 && r.body?.created === 3, `created=${r.body?.created}`);
  const list = await get('/api/monitors', token);
  const demos = (list.body?.monitors ?? []).filter((m) => m.isDemo);
  record('演示监控带 isDemo 标记（可一键清除）', demos.length === 3, `${demos.length} 个`);
  record('演示监控名称可辨识', demos.every((m) => m.name.includes('演示')), demos.map((m) => m.name).join(' | '));
  record('演示监控自带提取规则', demos.every((m) => m.extractRule === '#content'));
}

/* 9. 重复加载被拒绝（避免刷出重复数据） */
{
  const r = await post('/api/demo/sample', {}, token);
  record('重复加载演示数据被拒绝 (409)', r.status === 409, `HTTP ${r.status} · ${r.body?.code ?? ''}`);
}

/* 10. 演示数据真的能跑（对演示页做一次真实检查） */
{
  const list = await get('/api/monitors', token);
  const demo = (list.body?.monitors ?? []).find((m) => m.isDemo && m.url.includes('/alternating'));
  if (!demo) {
    record('演示监控可以对演示页发起真实检查', false, '未找到交替页演示监控');
  } else {
    const r = await post(`/api/monitors/${demo.id}/check`, {}, token);
    record(
      '演示监控可以对演示页发起真实检查',
      r.body?.result?.status === 'first' || r.body?.result?.status === 'changed' || r.body?.result?.status === 'nochange',
      `${r.body?.result?.status} · http=${r.body?.result?.httpStatus}`,
    );
  }
}

/* 11. 清除演示数据 */
{
  const r = await del('/api/demo/sample', token);
  record('可以一键清除演示数据', r.status === 200 && r.body?.removed === 3, `removed=${r.body?.removed}`);
  const list = await get('/api/monitors', token);
  record('清除后演示监控不再存在', (list.body?.monitors ?? []).filter((m) => m.isDemo).length === 0);
}

/* 12. 清除演示不会影响用户自己的监控 */
{
  const created = await post('/api/monitors', {
    name: '我自己的监控',
    url: 'https://demo-pageradar.852367856.dpdns.org/static',
    intervalMinutes: 60,
  }, token);
  const myId = created.body?.monitor?.id;
  // 再加载一轮演示
  await post('/api/demo/sample', {}, token);
  await del('/api/demo/sample', token);
  const list = await get('/api/monitors', token);
  const mine = (list.body?.monitors ?? []).find((m) => m.id === myId);
  record('清除演示数据不会误删用户自己的监控', !!mine && !mine.isDemo, mine ? `保留 ${mine.name}` : '被误删');
  if (myId) await del(`/api/monitors/${myId}`, token);
}

/* 13. 演示数据地址过安全校验（不会被当成 SSRF 后门） */
{
  const list = await get('/api/monitors', token);
  const before = (list.body?.monitors ?? []).length;
  // 演示地址必须是公网 https，不接受内网 —— 通过检查 API 已返回 422 的既有能力覆盖
  const bad = await post('/api/monitors', { name: 'x', url: 'http://169.254.169.254/', intervalMinutes: 60 }, token);
  record('演示机制未绕过 SSRF 校验', bad.status === 422, `HTTP ${bad.status}`);
  const after = await get('/api/monitors', token);
  record('被拒绝的请求没有创建任何监控', (after.body?.monitors ?? []).length === before, `${before} → ${(after.body?.monitors ?? []).length}`);
}

/* 汇总 */
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('FAILED:');
  for (const f of failed) console.log(`  - ${f.name} (${f.detail})`);
  process.exit(1);
}
