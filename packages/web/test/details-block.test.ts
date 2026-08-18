import { describe, expect, test } from 'bun:test';
import { docToMarkdown, markdownToDoc } from '@meowdown/core';
import { detectDetailsMarker, pairDetails, type DetailsMarker } from '../src/lib/details-block.ts';

describe('detectDetailsMarker', () => {
  test('reads the opening tag and its summary', () => {
    expect(detectDetailsMarker('<details>\n<summary>标题</summary>')).toEqual({
      kind: 'open',
      open: false,
      summary: '标题',
    });
    expect(detectDetailsMarker('<details><summary>标题</summary>')).toEqual({
      kind: 'open',
      open: false,
      summary: '标题',
    });
    expect(detectDetailsMarker('<details>')).toEqual({
      kind: 'open',
      open: false,
      summary: null,
    });
  });

  test('honours the open attribute in every spelling', () => {
    for (const tag of ['<details open>', '<details open="">', '<details OPEN="open">']) {
      expect(detectDetailsMarker(tag)).toEqual({ kind: 'open', open: true, summary: null });
    }
    // `openable` is not `open`; the boundary matters or any attribute starting
    // with those letters would expand the block.
    expect(detectDetailsMarker('<details data-openable="1">')).toEqual({
      kind: 'open',
      open: false,
      summary: null,
    });
  });

  test('reduces summary markup to the label a header shows', () => {
    expect(detectDetailsMarker('<details>\n<summary><b>粗</b></summary>')).toMatchObject({
      summary: '粗',
    });
    expect(
      detectDetailsMarker('<details>\n<summary><b>v0.4</b> 相对 <code>v0.3</code></summary>')
    ).toMatchObject({ summary: 'v0.4 相对 v0.3' });
    expect(detectDetailsMarker('<details>\n<summary>a &amp; b &lt;c&gt;</summary>')).toMatchObject({
      summary: 'a & b <c>',
    });
    expect(detectDetailsMarker('<details>\n<summary>&#65;&#x42;</summary>')).toMatchObject({
      summary: 'AB',
    });
    // Markup that leaves no text behind is no label at all.
    expect(detectDetailsMarker('<details>\n<summary><br></summary>')).toMatchObject({
      summary: null,
    });
  });

  test('reads the closing tag', () => {
    expect(detectDetailsMarker('</details>')).toEqual({ kind: 'close' });
    expect(detectDetailsMarker('  </details >  ')).toEqual({ kind: 'close' });
  });

  test('refuses the shapes it cannot fold without hiding the reader’s text', () => {
    for (const text of [
      '',
      '   ',
      '正文',
      // Body on the same line as the tags: hiding the paragraph hides the body.
      '<details><summary>标题</summary>内容</details>',
      '<details>\n<summary>标题</summary>\n内容',
      '<details>内容',
      // Not a details block at all.
      '<summary>标题</summary>',
      '<div>',
      '</div>',
      '</details> 之后还有别的',
      '前面有字 <details>',
      '<detailsx>',
    ]) {
      expect(`${text} -> ${JSON.stringify(detectDetailsMarker(text))}`).toBe(`${text} -> null`);
    }
  });
});

describe('pairDetails', () => {
  const open = (summary: string | null, isOpen = false): DetailsMarker => ({
    kind: 'open',
    open: isOpen,
    summary,
  });
  const close: DetailsMarker = { kind: 'close' };

  test('pairs one block', () => {
    expect(pairDetails([null, open('甲'), null, close, null])).toEqual([
      { key: '0:甲', openIndex: 1, closeIndex: 3, depth: 0, open: false, summary: '甲' },
    ]);
  });

  test('nests, and reports the depth the indent needs', () => {
    expect(pairDetails([open('外'), open('内'), null, close, close])).toEqual([
      { key: '0:外', openIndex: 0, closeIndex: 4, depth: 0, open: false, summary: '外' },
      { key: '1:内', openIndex: 1, closeIndex: 3, depth: 1, open: false, summary: '内' },
    ]);
  });

  test('numbers keys by opening order, so siblings keep their identity', () => {
    expect(pairDetails([open('甲'), close, open('乙'), close]).map((r) => r.key)).toEqual([
      '0:甲',
      '1:乙',
    ]);
    // Same summary twice is still two distinct blocks.
    expect(pairDetails([open('同'), close, open('同'), close]).map((r) => r.key)).toEqual([
      '0:同',
      '1:同',
    ]);
  });

  test('drops unbalanced markers instead of guessing', () => {
    expect(pairDetails([open('甲'), null])).toEqual([]);
    expect(pairDetails([close, null])).toEqual([]);
    // The outer opener is unclosed; the inner pair is still sound.
    expect(pairDetails([open('外'), open('内'), close])).toEqual([
      { key: '0:内', openIndex: 1, closeIndex: 2, depth: 1, open: false, summary: '内' },
    ]);
  });

  test('carries the open attribute through', () => {
    expect(pairDetails([open('甲', true), close])[0]?.open).toBe(true);
  });
});

/**
 * The same contract link blocks are held to: the rendering is a decoration over
 * paragraphs meowdown already produced, so the markdown on disk never changes
 * and folding can never cost anyone their text on save.
 */
const roundTrip = (markdown: string): string => docToMarkdown(markdownToDoc(markdown));

const regionsOf = (markdown: string) => {
  const markers: (DetailsMarker | null)[] = [];
  markdownToDoc(markdown).forEach((node) => {
    markers.push(node.type.name === 'paragraph' ? detectDetailsMarker(node.textContent) : null);
  });
  return pairDetails(markers);
};

describe('round trip', () => {
  const SAMPLE = [
    '# 标题',
    '',
    '第四章之后的内容多数收在折叠块内。',
    '',
    '<details>',
    '<summary><b>v0.4 相对 v0.3 的修改</b></summary>',
    '',
    '依据 2026-08-18 项目讨论，本次修改五处：',
    '',
    '| # | 修改 |',
    '| --- | --- |',
    '| 1 | 新增 |',
    '',
    '</details>',
    '',
    '<details open>',
    '<summary>默认展开</summary>',
    '',
    '正文。',
    '',
    '</details>',
    '',
  ].join('\n');

  test('markdown survives parse and serialize unchanged', () => {
    expect(roundTrip(SAMPLE)).toBe(SAMPLE);
  });

  test('and stays unchanged however many times it goes around', () => {
    const once = roundTrip(SAMPLE);
    expect(roundTrip(once)).toBe(once);
    expect(roundTrip(roundTrip(once))).toBe(once);
  });

  test('the blocks are found, with the markdown’s own open state', () => {
    const regions = regionsOf(SAMPLE);
    expect(regions).toEqual([
      {
        key: '0:v0.4 相对 v0.3 的修改',
        openIndex: 2,
        closeIndex: 5,
        depth: 0,
        open: false,
        summary: 'v0.4 相对 v0.3 的修改',
      },
      {
        key: '1:默认展开',
        openIndex: 6,
        closeIndex: 8,
        depth: 0,
        open: true,
        summary: '默认展开',
      },
    ]);
    expect(regionsOf(roundTrip(SAMPLE))).toEqual(regions);
  });

  test('a nested block folds inside its parent', () => {
    const nested = [
      '<details>',
      '<summary>外</summary>',
      '',
      '<details>',
      '<summary>内</summary>',
      '',
      '里',
      '',
      '</details>',
      '',
      '</details>',
      '',
    ].join('\n');
    expect(roundTrip(nested)).toBe(nested);
    expect(regionsOf(nested).map((r) => [r.key, r.depth, r.openIndex, r.closeIndex])).toEqual([
      ['0:外', 0, 0, 4],
      ['1:内', 1, 1, 3],
    ]);
  });

  test('the shape the formatter leaves behind still parses to the same blocks', () => {
    // `oxfmt` puts a blank line either side of an HTML block; the write-back
    // after a save hands the editor exactly this, and the fold must survive it.
    const formatted = ['<details>', '<summary>标题</summary>', '', '内容', '', '</details>', ''].join(
      '\n'
    );
    expect(regionsOf(formatted).map((r) => r.key)).toEqual(['0:标题']);
    expect(roundTrip(formatted)).toBe(formatted);
  });
});
