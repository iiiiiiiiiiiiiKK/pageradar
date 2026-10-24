/**
 * HTML 正文提取。
 *
 * Worker 环境没有 DOM，所以这里实现一个够用的小型解析器：
 *  1. 词法扫描出标签 / 文本 / 注释
 *  2. 建立一棵轻量节点树（带标签、属性、父子关系）
 *  3. 用「简单选择器」定位用户指定的内容区域
 *  4. 把目标节点下的可见文本规范化
 *
 * 明确不支持：CSS 伪类、属性选择器、复杂组合、JS 渲染后的内容。
 * 这些限制会写进 README，而不是假装支持。
 */

export interface HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
  text: string;
  parent: HtmlNode | null;
}

export interface ParseLimits {
  maxNodes: number;
  maxDepth: number;
  maxTextLength: number;
}

const DEFAULT_LIMITS: ParseLimits = { maxNodes: 200_000, maxDepth: 128, maxTextLength: 2_000_000 };

/** 内容不含语义的标签，直接跳过整棵子树。 */
const SKIP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'embed',
  'meta',
  'link',
]);

/** 自身闭合、没有子节点的标签。 */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'aside',
  'header',
  'footer',
  'nav',
  'li',
  'tr',
  'br',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'table',
  'ul',
  'ol',
  'dl',
  'dt',
  'dd',
  'pre',
  'blockquote',
  'form',
  'figure',
  'figcaption',
  'address',
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
  bull: '•',
  deg: '°',
  euro: '€',
  pound: '£',
  yen: '¥',
  times: '×',
  divide: '÷',
  plusmn: '±',
  frac12: '½',
  frac14: '¼',
  sup2: '²',
  sup3: '³',
  gt2: '≥',
  lt2: '≤',
  ne: '≠',
};

export function decodeEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const cp = parseInt(body.slice(2), 16);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(cp);
      } catch {
        return whole;
      }
    }
    if (body.startsWith('#')) {
      const cp = parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(cp);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body];
    return named ?? whole;
  });
}

export interface ParsedHtml {
  root: HtmlNode;
  nodeCount: number;
  truncated: boolean;
  title: string;
}

export function parseHtml(html: string, limits: Partial<ParseLimits> = {}): ParsedHtml {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const root: HtmlNode = { tag: '#document', attrs: {}, children: [], text: '', parent: null };
  let current = root;
  let nodeCount = 1;
  let truncated = false;
  let title = '';
  let i = 0;
  const len = html.length;

  while (i < len) {
    if (nodeCount > lim.maxNodes) {
      truncated = true;
      break;
    }
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      appendText(current, html.slice(i));
      break;
    }
    if (lt > i) appendText(current, html.slice(i, lt));

    // 注释 / CDATA / DOCTYPE
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? len : end + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', lt)) {
      const end = html.indexOf(']]>', lt + 9);
      i = end < 0 ? len : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      i = end < 0 ? len : end + 1;
      continue;
    }

    const tagEnd = findTagEnd(html, lt + 1);
    if (tagEnd < 0) {
      appendText(current, html.slice(lt));
      break;
    }
    const rawTag = html.slice(lt + 1, tagEnd);
    i = tagEnd + 1;

    if (rawTag.startsWith('/')) {
      const name = rawTag.slice(1).trim().toLowerCase();
      // 向上找到匹配的开标签；找不到就忽略这个闭标签。
      let node: HtmlNode | null = current;
      while (node && node.tag !== name) node = node.parent;
      if (node && node.parent) current = node.parent;
      continue;
    }

    const selfClosing = rawTag.endsWith('/');
    const inner = selfClosing ? rawTag.slice(0, -1) : rawTag;
    const spaceIdx = inner.search(/[\s/]/);
    const tag = (spaceIdx < 0 ? inner : inner.slice(0, spaceIdx)).toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(tag)) continue;

    const attrs = parseAttrs(spaceIdx < 0 ? '' : inner.slice(spaceIdx));

    if (SKIP_TAGS.has(tag)) {
      // 自闭合 / 空元素（如 <meta>、<link>）：只需要跳过这个标签本身。
      if (selfClosing || VOID_TAGS.has(tag)) continue;
      // 整段跳过（script/style 里的文本不属于正文，也可能是陷阱）
      const close = html.toLowerCase().indexOf(`</${tag}`, i);
      if (close < 0) {
        i = len;
        continue;
      }
      const gt = html.indexOf('>', close);
      i = gt < 0 ? len : gt + 1;
      continue;
    }

    let depth = 0;
    for (let p: HtmlNode | null = current; p; p = p.parent) depth++;
    if (depth > lim.maxDepth) {
      truncated = true;
      continue;
    }

    const node: HtmlNode = { tag, attrs, children: [], text: '', parent: current };
    current.children.push(node);
    nodeCount++;

    if (!selfClosing && !VOID_TAGS.has(tag)) current = node;
  }

  // <title> 现在是一个普通节点，解析完成后再取它的文本。
  const titleNode = findByTagShallow(root, 'title');
  if (titleNode) title = normalizeInline(titleNode.text).slice(0, 300);

  return { root, nodeCount, truncated, title };
}

/** 只保留单行文本，用于 title。 */
function normalizeInline(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function findByTagShallow(node: HtmlNode, tag: string): HtmlNode | null {
  if (node.tag === tag) return node;
  for (const c of node.children) {
    const r = findByTagShallow(c, tag);
    if (r) return r;
  }
  return null;
}

function findTagEnd(html: string, from: number): number {
  let i = from;
  let quote: string | null = null;
  while (i < html.length) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
    i++;
  }
  return -1;
}

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (attrs[name] === undefined) attrs[name] = decodeEntities(value);
  }
  return attrs;
}

function appendText(node: HtmlNode, text: string): void {
  if (!text) return;
  const decoded = decodeEntities(text);
  node.text += decoded;
}

/* ------------------------------------------------------------------ *
 * 选择器
 * ------------------------------------------------------------------ */

export interface SimpleSelector {
  tag?: string;
  id?: string;
  classes: string[];
}

export interface SelectorChain {
  /** 从祖先到目标的选择器序列（后代关系）。 */
  parts: SimpleSelector[];
  raw: string;
}

/**
 * 解析简单选择器。支持：
 *   `main`、`#content`、`.article`、`article.post`、`div#main .body`
 * 不支持：`>` `+` `~` 组合、伪类、属性选择器。遇到就抛错并提示用户。
 */
export function parseSelector(input: string): SelectorChain {
  const raw = input.trim();
  if (!raw) throw new Error('选择器不能为空。');
  if (/[>+~\[\]:*]/.test(raw)) {
    throw new Error('选择器只支持标签名、#id 和 .class（可用空格表示后代），不支持 ">", "+", "~", "[]", ":" 等语法。');
  }
  const parts = raw.split(/\s+/).map((p) => {
    const m = p.match(/^([a-zA-Z][a-zA-Z0-9-]*)?((?:[.#][-a-zA-Z0-9_]+)*)$/);
    if (!m || (!m[1] && !m[2])) throw new Error(`无法解析选择器片段「${p}」。`);
    const sel: SimpleSelector = { classes: [] };
    if (m[1]) sel.tag = m[1].toLowerCase();
    const rest = m[2];
    const tokenRe = /([.#])([-a-zA-Z0-9_]+)/g;
    let t: RegExpExecArray | null;
    while ((t = tokenRe.exec(rest)) !== null) {
      if (t[1] === '#') {
        if (sel.id) throw new Error('一个片段里只能有一个 #id。');
        sel.id = t[2];
      } else {
        sel.classes.push(t[2]);
      }
    }
    return sel;
  });
  return { parts, raw };
}

function matchesSimple(node: HtmlNode, sel: SimpleSelector): boolean {
  if (sel.tag && node.tag !== sel.tag) return false;
  if (sel.id && node.attrs.id !== sel.id) return false;
  if (sel.classes.length > 0) {
    const cls = (node.attrs.class ?? '').split(/\s+/).filter(Boolean);
    for (const c of sel.classes) if (!cls.includes(c)) return false;
  }
  return true;
}

export function selectNodes(root: HtmlNode, chain: SelectorChain): HtmlNode[] {
  let frontier: HtmlNode[] = [root];
  for (const sel of chain.parts) {
    const next: HtmlNode[] = [];
    for (const node of frontier) {
      collectDescendants(node, sel, next);
    }
    frontier = next;
    if (frontier.length === 0) return [];
  }
  return frontier;
}

function collectDescendants(node: HtmlNode, sel: SimpleSelector, out: HtmlNode[]): void {
  for (const child of node.children) {
    if (matchesSimple(child, sel)) out.push(child);
    collectDescendants(child, sel, out);
  }
}

/* ------------------------------------------------------------------ *
 * 文本抽取
 * ------------------------------------------------------------------ */

function collectText(node: HtmlNode, out: string[], depth = 0): void {
  if (depth > 200) return;
  if (node.text) {
    const t = node.text.replace(/[\t\f\v\u00a0]+/g, ' ');
    if (t.trim()) out.push(t);
  }
  for (const child of node.children) {
    if (BLOCK_TAGS.has(child.tag)) out.push('\n');
    collectText(child, out, depth + 1);
    if (BLOCK_TAGS.has(child.tag)) out.push('\n');
  }
}

/** 规范化文本：合并空白、去掉空行、裁剪长度。 */
export function normalizeText(raw: string, maxLen = 200_000): { text: string; truncated: boolean } {
  const cleaned = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n');
  if (cleaned.length <= maxLen) return { text: cleaned, truncated: false };
  return { text: cleaned.slice(0, maxLen), truncated: true };
}

export interface ExtractResult {
  text: string;
  wordCount: number;
  matchedSelector: string | null;
  selectorMissing: boolean;
  candidates: string[];
  truncated: boolean;
  title: string;
}

/**
 * 从 HTML 中抽取待比较的文本。
 * @param selector 用户给定的提取规则；为空则使用整个 body。
 */
export function extractContent(
  html: string,
  selector?: string,
  limits: Partial<ParseLimits> = {},
): ExtractResult {
  const parsed = parseHtml(html, limits);
  const body = findByTag(parsed.root, 'body') ?? parsed.root;

  let matchedSelector: string | null = null;
  let selectorMissing = false;
  const candidates: string[] = [];

  if (selector && selector.trim()) {
    const chain = parseSelector(selector);
    const nodes = selectNodes(parsed.root, chain);
    if (nodes.length > 0) {
      matchedSelector = selector.trim();
      // 合并所有匹配节点的文本
      const out: string[] = [];
      for (const n of nodes) collectText(n, out);
      const { text, truncated } = normalizeText(out.join(''), limits.maxTextLength ?? 200_000);
      return {
        text,
        wordCount: countWords(text),
        matchedSelector,
        selectorMissing: false,
        candidates: [],
        truncated: truncated || parsed.truncated,
        title: parsed.title,
      };
    }
    selectorMissing = true;
    // 给出候选 id / class，帮助用户修正规则
    for (const n of topLevelCandidates(body, 40)) {
      if (n.attrs.id) candidates.push(`#${n.attrs.id}`);
      for (const c of (n.attrs.class ?? '').split(/\s+/).filter(Boolean).slice(0, 3)) candidates.push(`.${c}`);
    }
  }

  const out: string[] = [];
  collectText(body, out);
  const { text, truncated } = normalizeText(out.join(''), limits.maxTextLength ?? 200_000);
  return {
    text,
    wordCount: countWords(text),
    matchedSelector,
    selectorMissing,
    candidates: Array.from(new Set(candidates)).slice(0, 24),
    truncated: truncated || parsed.truncated,
    title: parsed.title,
  };
}

function findByTag(node: HtmlNode, tag: string): HtmlNode | null {
  if (node.tag === tag) return node;
  for (const c of node.children) {
    const r = findByTag(c, tag);
    if (r) return r;
  }
  return null;
}

function topLevelCandidates(body: HtmlNode, limit: number): HtmlNode[] {
  const out: HtmlNode[] = [];
  const walk = (n: HtmlNode, depth: number) => {
    if (out.length >= limit || depth > 4) return;
    if (n.attrs.id || n.attrs.class) out.push(n);
    for (const c of n.children) walk(c, depth + 1);
  };
  for (const c of body.children) walk(c, 0);
  return out;
}

export function countWords(text: string): number {
  if (!text) return 0;
  // 中英混合：CJK 按字计，其余按空白分词
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const latin = text
    .replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return cjk + latin;
}

/** 关键词规则：命中返回 true。支持 `-词` 表示排除。 */
export function matchKeyword(text: string, rule: string): { hit: boolean; mode: string } {
  const trimmed = rule.trim();
  if (!trimmed) return { hit: false, mode: 'none' };

  const includes: string[] = [];
  const excludes: string[] = [];
  for (const part of trimmed.split(/\s+/)) {
    if (part.startsWith('-') && part.length > 1) excludes.push(part.slice(1).toLowerCase());
    else includes.push(part.toLowerCase());
  }

  const hay = text.toLowerCase();
  if (excludes.some((e) => hay.includes(e))) return { hit: false, mode: 'excluded' };
  if (includes.length === 0) return { hit: false, mode: 'none' };
  const hit = includes.some((k) => hay.includes(k));
  return { hit, mode: hit ? 'matched' : 'not-matched' };
}
