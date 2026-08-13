import { describe, expect, test } from 'bun:test';
import { markdownToDoc } from '@meowdown/core';
import { findTextRanges } from '../src/lib/replace-text.ts';

const URL = 'https://cdn.example/pic.png?code=abc&x=1';

describe('findTextRanges', () => {
  test('locates a pasted image URL inside a real document', () => {
    const doc = markdownToDoc(`# Title\n\n前文。\n\n![shot](${URL})\n\n后文。\n`);
    const ranges = findTextRanges(doc, URL);
    expect(ranges).toHaveLength(1);
    const { from, to } = ranges[0]!;
    expect(to - from).toBe(URL.length);
    expect(doc.textBetween(from, to)).toBe(URL);
  });

  test('finds every occurrence, in document order', () => {
    const doc = markdownToDoc(`![](${URL})\n\n![](${URL})\n`);
    const ranges = findTextRanges(doc, URL);
    expect(ranges).toHaveLength(2);
    expect(ranges[0]!.from).toBeLessThan(ranges[1]!.from);
  });

  test('a URL the document does not contain matches nothing', () => {
    const doc = markdownToDoc('# just text\n');
    expect(findTextRanges(doc, URL)).toEqual([]);
    expect(findTextRanges(doc, '')).toEqual([]);
  });

  test('ranges never overlap, so back-to-front replacement is safe', () => {
    const doc = markdownToDoc(`![](${URL})\n\n![](${URL})\n\n![](${URL})\n`);
    const ranges = findTextRanges(doc, URL);
    expect(ranges).toHaveLength(3);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]!.from).toBeGreaterThanOrEqual(ranges[i - 1]!.to);
    }
  });
});
