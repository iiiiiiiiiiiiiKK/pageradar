/**
 * 文本差异计算：按行做 Myers-ish 的 LCS，再输出 add / del / equal 操作序列。
 *
 * 为什么按行：网页正文变化绝大多数是整段增删；按字符 diff 会产出大量
 * 噪声碎片，人类根本读不了。按行 + 单行内二次分割（长行）是更好的折中。
 *
 * 复杂度保护：行数超过阈值时退化成「首尾对齐 + 中间整块增删」，
 * 避免 O(n*m) 的 DP 表把 Worker 内存打爆。
 */

import type { DiffOp } from '../../shared/types.ts';

const MAX_DP_LINES = 2000; // DP 表上限（2000 x 2000 = 4M 格，约 32MB）
const MAX_OPS = 4000;

export function splitLines(text: string): string[] {
  if (!text) return [];
  return text.split('\n');
}

/**
 * 计算两组行之间的 LCS 匹配对。
 * 返回 [[aIndex, bIndex], ...]，按坐标升序。
 */
export function lcsMatches(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];

  // 先剥掉公共前缀与后缀，能显著缩小 DP 规模（网页改动通常很局部）
  let start = 0;
  while (start < n && start < m && a[start] === b[start]) start++;
  let endA = n;
  let endB = m;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const matches: Array<[number, number]> = [];
  for (let i = 0; i < start; i++) matches.push([i, i]);

  const sA = a.slice(start, endA);
  const sB = b.slice(start, endB);

  if (sA.length > 0 && sB.length > 0) {
    if (sA.length * sB.length <= MAX_DP_LINES * MAX_DP_LINES) {
      const table = buildLcsTable(sA, sB);
      let i = 0;
      let j = 0;
      while (i < sA.length && j < sB.length) {
        if (sA[i] === sB[j]) {
          matches.push([start + i, start + j]);
          i++;
          j++;
        } else if (table[(i + 1) * (sB.length + 1) + j] >= table[i * (sB.length + 1) + (j + 1)]) {
          i++;
        } else {
          j++;
        }
      }
    } else {
      // 太大：退化为「中间整块替换」
      // 仍尝试用哈希指纹找几个锚点，避免完全失去对齐信息。
      matches.push(...hashAnchors(sA, sB, start));
    }
  }

  for (let k = 0; endA + k < n; k++) matches.push([endA + k, endB + k]);
  return matches.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

function buildLcsTable(a: string[], b: string[]): Int32Array {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j] ? table[(i + 1) * width + (j + 1)] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }
  return table;
}

function hashAnchors(a: string[], b: string[], offset: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const indexB = new Map<string, number>();
  for (let j = 0; j < b.length; j++) if (!indexB.has(b[j])) indexB.set(b[j], j);

  let lastJ = -1;
  for (let i = 0; i < a.length; i++) {
    const line = a[i];
    if (line.length < 12) continue;
    const j = indexB.get(line);
    if (j !== undefined && j > lastJ) {
      out.push([offset + i, offset + j]);
      lastJ = j;
      if (out.length >= 200) break;
    }
  }
  return out;
}

export interface DiffSummary {
  ops: DiffOp[];
  added: number;
  removed: number;
  /** 新增 / 删除的行数（与 added/removed 的字符数区分）。 */
  addedLines: number;
  removedLines: number;
  truncated: boolean;
}

export function diffTexts(oldText: string, newText: string): DiffSummary {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const matches = lcsMatches(a, b);

  const ops: DiffOp[] = [];
  let ai = 0;
  let bi = 0;
  let added = 0;
  let removed = 0;
  let addedLines = 0;
  let removedLines = 0;
  let truncated = false;

  const pushOp = (type: DiffOp['type'], text: string) => {
    if (ops.length >= MAX_OPS) {
      truncated = true;
      return;
    }
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += '\n' + text;
    else ops.push({ type, text });
  };

  for (const [ma, mb] of matches) {
    while (ai < ma) {
      const line = a[ai++];
      removed += line.length;
      removedLines++;
      pushOp('del', line);
    }
    while (bi < mb) {
      const line = b[bi++];
      added += line.length;
      addedLines++;
      pushOp('add', line);
    }
    pushOp('equal', a[ma]);
    ai = ma + 1;
    bi = mb + 1;
  }
  while (ai < a.length) {
    const line = a[ai++];
    removed += line.length;
    removedLines++;
    pushOp('del', line);
  }
  while (bi < b.length) {
    const line = b[bi++];
    added += line.length;
    addedLines++;
    pushOp('add', line);
  }

  return { ops, added, removed, addedLines, removedLines, truncated };
}

/** 纯文本模式：把 diff 转成人类可读的滚动文本。 */
export function diffToPlainText(ops: DiffOp[]): string {
  const lines: string[] = [];
  for (const op of ops) {
    const prefix = op.type === 'add' ? '+ ' : op.type === 'del' ? '- ' : '  ';
    for (const line of op.text.split('\n')) lines.push(prefix + line);
  }
  return lines.join('\n');
}

/** 内容指纹：用于判断「有没有变」，比全文比对快得多。 */
export function contentHash(text: string): string {
  // FNV-1a 64 位（用两个 32 位累加，兼容 Worker 的 BigInt 开销）
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return hex(h1) + hex(h2) + '-' + text.length.toString(16);
}
