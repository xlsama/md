import { describe, expect, test } from 'bun:test';
import { activeHeading, extractToc, sameToc } from '../src/lib/toc.ts';

describe('extractToc', () => {
  test('collects ATX headings with levels and document order', () => {
    const toc = extractToc('# One\n\ntext\n\n### Three\n\n## Two\n');
    expect(toc).toEqual([
      { level: 1, text: 'One', index: 0 },
      { level: 3, text: 'Three', index: 1 },
      { level: 2, text: 'Two', index: 2 },
    ]);
  });

  test('skips headings inside fenced code blocks', () => {
    const md = ['# Real', '', '```sh', '# not a heading', '```', '', '## Also real'].join('\n');
    expect(extractToc(md).map((entry) => entry.text)).toEqual(['Real', 'Also real']);
  });

  test('handles tilde fences and nested backtick fences', () => {
    const md = ['~~~', '# hidden', '~~~', '# shown', '````', '```', '# still hidden', '````'].join(
      '\n'
    );
    expect(extractToc(md).map((entry) => entry.text)).toEqual(['shown']);
  });

  test('skips frontmatter', () => {
    const md = ['---', 'title: # nope', '---', '# Yes'].join('\n');
    expect(extractToc(md).map((entry) => entry.text)).toEqual(['Yes']);
  });

  test('strips inline markdown from heading text', () => {
    const md = [
      '# **Bold** and `code`',
      '## A [link](https://x.dev)',
      '### A [[wiki|Label]]',
      '#### Closed ATX ###',
    ].join('\n');
    expect(extractToc(md).map((entry) => entry.text)).toEqual([
      'Bold and code',
      'A link',
      'A Label',
      'Closed ATX',
    ]);
  });

  test('ignores non-headings and empty headings', () => {
    expect(extractToc('#no-space\n#\n####### seven\ntext')).toEqual([]);
  });

  test('setext headings are not supported (meowdown emits ATX)', () => {
    expect(extractToc('Title\n=====\n')).toEqual([]);
  });
});

const box = (scrollTop: number, scrollHeight = 2000, clientHeight = 500) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

describe('activeHeading', () => {
  test('a document without headings has nothing to mark', () => {
    expect(activeHeading([], box(0))).toBe(-1);
  });

  test('the last heading past the reading line wins', () => {
    const tops = [100, 600, 1200];
    expect(activeHeading(tops, box(80))).toBe(0);
    expect(activeHeading(tops, box(560))).toBe(0);
    expect(activeHeading(tops, box(580))).toBe(1);
    expect(activeHeading(tops, box(1180))).toBe(2);
  });

  test('the first heading holds the mark above itself', () => {
    expect(activeHeading([300, 900], box(0))).toBe(0);
  });

  test('the reading line sits just below where a jump parks a heading', () => {
    // `scrollToHeading` leaves the heading `JUMP_GUTTER` below the top edge,
    // so the entry that was clicked has to be the one that lights up.
    expect(activeHeading([0, 700], box(700 - 16))).toBe(1);
  });

  test('the end of the document belongs to the last heading', () => {
    // The final section is shorter than the viewport: its heading never
    // reaches the reading line on its own.
    expect(activeHeading([100, 1490], box(1500))).toBe(1);
  });

  test('a document that does not scroll is not treated as scrolled to its end', () => {
    expect(activeHeading([0, 200], box(0, 500, 500))).toBe(0);
  });
});

describe('sameToc', () => {
  test('compares level and text only', () => {
    expect(sameToc(extractToc('# A'), extractToc('# A'))).toBe(true);
    expect(sameToc(extractToc('# A'), extractToc('## A'))).toBe(false);
    expect(sameToc(extractToc('# A'), extractToc('# A\n# B'))).toBe(false);
  });
});
