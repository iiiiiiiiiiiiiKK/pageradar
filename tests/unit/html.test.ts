import { describe, expect, it } from 'vitest';
import { decodeEntities, extractContent, matchKeyword, normalizeText, parseHtml, parseSelector } from '../../src/worker/extract/html.ts';

const PAGE = `<!doctype html>
<html><head><title>产品定价</title>
<style>.x{color:red}</style>
<script>const secret = "should-not-appear";</script>
</head>
<body>
  <nav>首页 关于</nav>
  <main id="content">
    <h1>专业版</h1>
    <p>价格：<strong>¥99</strong> / 月</p>
    <ul><li>无限项目</li><li>优先支持</li></ul>
  </main>
  <footer class="site-foot">© 2024 Example</footer>
</body></html>`;

describe('HTML 解析', () => {
  it('提取 title', () => {
    const p = parseHtml(PAGE);
    expect(p.title).toBe('产品定价');
  });

  // 回归测试：head 里的 <meta> / <link> 是空元素，旧实现把它们当成有闭合标签的
  // 块级元素，跳过时一路吃到文档末尾，导致整个页面被当成空正文。
  it('空元素（meta/link/br/hr）不会吞掉后续内容', () => {
    const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/a.css"><title>T</title></head>
<body><main id="content"><h1>标题</h1><p>正文<br>换行</p></main></body></html>`;
    const r = extractContent(html, '#content');
    expect(r.matchedSelector).toBe('#content');
    expect(r.text).toContain('标题');
    expect(r.text).toContain('正文');
    expect(r.text).toContain('换行');
    expect(r.text).not.toContain('/a.css');
  });

  it('没有 </head> 的畸形页面也能解析出正文', () => {
    const html = `<html><head><meta charset=utf-8><body><div id="c">内容在这里</div></body></html>`;
    const r = extractContent(html, '#c');
    expect(r.text).toContain('内容在这里');
  });

  it('跳过 script / style 内容', () => {
    const p = parseHtml(PAGE);
    let all = '';
    const walk = (n: { text: string; children: Array<{ text: string; children: unknown[] }> }) => {
      all += n.text;
      for (const c of n.children) walk(c as never);
    };
    walk(p.root as never);
    expect(all).not.toContain('should-not-appear');
    expect(all).not.toContain('color:red');
  });

  it('实体解码', () => {
    expect(decodeEntities('a &amp; b &lt;tag&gt; &#65; &#x42; &nbsp;').trim()).toBe('a & b <tag> A B');
  });

  it('嵌套标签的文本顺序正确', () => {
    const r = extractContent(PAGE, 'main');
    expect(r.text).toContain('专业版');
    expect(r.text).toContain('¥99');
    expect(r.text).toContain('无限项目');
    expect(r.text).not.toContain('首页');
  });

  it('按 #id 选择', () => {
    const r = extractContent(PAGE, '#content');
    expect(r.matchedSelector).toBe('#content');
    expect(r.text).toContain('专业版');
  });

  it('按 .class 选择', () => {
    const r = extractContent(PAGE, '.site-foot');
    expect(r.text).toContain('© 2024 Example');
  });

  it('支持后代组合选择器', () => {
    const r = extractContent(PAGE, 'main li');
    expect(r.text).toContain('无限项目');
    expect(r.text).toContain('优先支持');
    expect(r.text).not.toContain('专业版');
  });

  it('选择器不匹配时回退到全文并标记 selectorMissing', () => {
    const r = extractContent(PAGE, '#does-not-exist');
    expect(r.selectorMissing).toBe(true);
    expect(r.text).toContain('专业版');
    expect(r.candidates.length).toBeGreaterThan(0);
  });

  it('拒绝不支持的复杂选择器并给出清晰错误', () => {
    expect(() => parseSelector('div > p')).toThrow(/不支持/);
    expect(() => parseSelector('a[href]')).toThrow(/不支持/);
    expect(() => parseSelector('li:first-child')).toThrow(/不支持/);
  });
});

describe('文本规范化', () => {
  it('合并空白与空行', () => {
    const r = normalizeText('  a  \n\n\n  b\t\tc  \n');
    expect(r.text).toBe('a\nb c');
  });

  it('超长文本被截断并标记', () => {
    const r = normalizeText('x'.repeat(100), 10);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(10);
  });
});

describe('关键词规则', () => {
  it('包含匹配', () => {
    expect(matchKeyword('价格降到了 99 元', '降价 99').hit).toBe(true);
  });

  it('排除词优先', () => {
    expect(matchKeyword('降价 但已售罄', '降价 -售罄').hit).toBe(false);
  });

  it('空规则不命中', () => {
    expect(matchKeyword('任意文本', '').hit).toBe(false);
  });

  it('大小写不敏感', () => {
    expect(matchKeyword('IN STOCK now', 'in stock').hit).toBe(true);
  });
});

describe('解析资源限制', () => {
  it('超过 maxDepth 时截断而不是崩溃', () => {
    const deep = '<div>'.repeat(300) + 'x' + '</div>'.repeat(300);
    const p = parseHtml(deep, { maxDepth: 10 });
    expect(p.truncated).toBe(true);
  });

  it('超过 maxNodes 时截断', () => {
    const many = '<p>a</p>'.repeat(5000);
    const p = parseHtml(many, { maxNodes: 100 });
    expect(p.truncated).toBe(true);
    expect(p.nodeCount).toBeLessThanOrEqual(110);
  });
});
