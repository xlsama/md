import { describe, expect, test } from 'bun:test';
import { extractToc, sameToc } from '../src/lib/toc.ts';

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

describe('sameToc', () => {
  test('compares level and text only', () => {
    expect(sameToc(extractToc('# A'), extractToc('# A'))).toBe(true);
    expect(sameToc(extractToc('# A'), extractToc('## A'))).toBe(false);
    expect(sameToc(extractToc('# A'), extractToc('# A\n# B'))).toBe(false);
  });
});
