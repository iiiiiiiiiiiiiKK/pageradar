import { describe, expect, it } from 'vitest';
import { contentHash, diffTexts, diffToPlainText, lcsMatches, splitLines } from '../../src/worker/diff/diff.ts';

describe('差异计算', () => {
  it('相同内容没有增删', () => {
    const d = diffTexts('a\nb\nc', 'a\nb\nc');
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
    expect(d.ops.every((o) => o.type === 'equal')).toBe(true);
  });

  it('识别新增行', () => {
    const d = diffTexts('a\nb', 'a\nb\nc');
    expect(d.added).toBe(1);
    expect(d.removed).toBe(0);
    expect(d.addedLines).toBe(1);
    expect(d.ops.some((o) => o.type === 'add' && o.text === 'c')).toBe(true);
  });

  it('识别删除行', () => {
    const d = diffTexts('a\nb\nc', 'a\nc');
    expect(d.removed).toBe(1);
    expect(d.removedLines).toBe(1);
    expect(d.ops.some((o) => o.type === 'del' && o.text === 'b')).toBe(true);
  });

  it('识别修改（删除 + 新增）', () => {
    const d = diffTexts('价格 99 元', '价格 88 元');
    expect(d.removed).toBeGreaterThan(0);
    expect(d.added).toBeGreaterThan(0);
    expect(d.ops.some((o) => o.type === 'del')).toBe(true);
    expect(d.ops.some((o) => o.type === 'add')).toBe(true);
  });

  it('中间插入时保持前后对齐（不整段替换）', () => {
    const before = 'line1\nline2\nline3\nline4\nline5';
    const after = 'line1\nline2\nINSERTED\nline3\nline4\nline5';
    const d = diffTexts(before, after);
    expect(d.addedLines).toBe(1);
    expect(d.removedLines).toBe(0);
    const equalCount = d.ops.filter((o) => o.type === 'equal').reduce((n, o) => n + o.text.split('\n').length, 0);
    expect(equalCount).toBe(5);
  });

  it('完全不同的内容', () => {
    const d = diffTexts('a\nb', 'x\ny');
    expect(d.removedLines).toBe(2);
    expect(d.addedLines).toBe(2);
  });

  it('空字符串边界', () => {
    expect(diffTexts('', '').ops.length).toBe(0);
    const d = diffTexts('', 'hello');
    expect(d.added).toBe(5);
    expect(d.removed).toBe(0);
  });

  it('纯文本模式带 +/- 前缀', () => {
    const d = diffTexts('a\nb', 'a\nc');
    const txt = diffToPlainText(d.ops);
    expect(txt).toContain('  a');
    expect(txt).toMatch(/- b/);
    expect(txt).toMatch(/\+ c/);
  });

  it('LCS 匹配对单调递增', () => {
    const m = lcsMatches(splitLines('a\nb\nc\nd'), splitLines('a\nc\nd\ne'));
    for (let i = 1; i < m.length; i++) {
      expect(m[i][0]).toBeGreaterThan(m[i - 1][0]);
      expect(m[i][1]).toBeGreaterThan(m[i - 1][1]);
    }
  });

  it('大文件不会爆内存（退化路径）', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n');
    const b = a.replace('line 1500', 'line 1500 changed');
    const start = Date.now();
    const d = diffTexts(a, b);
    const ms = Date.now() - start;
    expect(ms).toBeLessThan(5000);
    expect(d.added + d.removed).toBeGreaterThan(0);
  });
});

describe('内容指纹', () => {
  it('相同内容指纹相同', () => {
    expect(contentHash('abc')).toBe(contentHash('abc'));
  });

  it('不同内容指纹不同', () => {
    expect(contentHash('abc')).not.toBe(contentHash('abd'));
  });

  it('空白差异也会改变指纹', () => {
    expect(contentHash('a b')).not.toBe(contentHash('a  b'));
  });

  it('指纹包含长度信息', () => {
    expect(contentHash('hello')).toContain('5');
  });
});
