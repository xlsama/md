import { describe, expect, test } from 'bun:test';
import { docToMarkdown, markdownToDoc, matchEmbed } from '@meowdown/core';
import { detectLinkBlock, linkDomain } from '../src/lib/link-block.ts';

describe('detectLinkBlock', () => {
  test('accepts a paragraph that is nothing but a URL', () => {
    expect(detectLinkBlock('https://example.com')).toEqual({
      url: 'https://example.com',
      syntax: 'bare',
    });
    expect(detectLinkBlock('  http://example.com/a/b?c=1  ')).toEqual({
      url: 'http://example.com/a/b?c=1',
      syntax: 'bare',
    });
  });

  test('accepts the autolink spelling and unwraps it', () => {
    expect(detectLinkBlock('<https://example.com/a>')).toEqual({
      url: 'https://example.com/a',
      syntax: 'autolink',
    });
  });

  test('leaves everything else to the ordinary inline rendering', () => {
    for (const text of [
      '',
      '   ',
      'see https://example.com for details',
      'https://example.com https://other.com',
      '[label](https://example.com)',
      '![alt](https://example.com/a.png)',
      'www.example.com',
      'ftp://example.com/file',
      'mailto:a@b.com',
      'https://',
      '<https://example.com> and more',
      '`https://example.com`',
    ]) {
      expect(`${text} -> ${JSON.stringify(detectLinkBlock(text))}`).toBe(`${text} -> null`);
    }
  });
});

describe('linkDomain', () => {
  test('drops the www prefix and survives junk', () => {
    expect(linkDomain('https://www.example.com/a')).toBe('example.com');
    expect(linkDomain('https://sub.example.co.uk')).toBe('sub.example.co.uk');
    expect(linkDomain('nonsense')).toBe('nonsense');
  });
});

describe('embed routing', () => {
  test('YouTube and X links reach meowdown’s own embed matcher', () => {
    const youtube = matchEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(youtube?.kind).toBe('youtube');
    expect(youtube?.src).toStartWith('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(matchEmbed('https://youtu.be/dQw4w9WgXcQ')?.kind).toBe('youtube');
  });

  test('a plain site is not an embed, so it falls through to the card', () => {
    expect(matchEmbed('https://example.com')).toBeUndefined();
    expect(matchEmbed('https://github.com/xlsama/md')).toBeUndefined();
    // A profile is not a status: only permalinked posts embed.
    expect(matchEmbed('https://x.com/someone')).toBeUndefined();
  });
});

/**
 * The whole reason link blocks are decorations rather than document nodes: the
 * markdown never changes, so the round trip is an identity and the rendering
 * cannot cost anyone their URL on save.
 */
const roundTrip = (markdown: string): string => docToMarkdown(markdownToDoc(markdown));

const blocksOf = (markdown: string): (string | null)[] => {
  const found: (string | null)[] = [];
  markdownToDoc(markdown).forEach((node) => {
    if (node.type.name !== 'paragraph') return;
    found.push(detectLinkBlock(node.textContent)?.url ?? null);
  });
  return found;
};

describe('round trip', () => {
  const SAMPLE = [
    '# 标题',
    '',
    '正文里有一个 [行内链接](https://example.com/inline)，不受影响。',
    '',
    'https://example.com/card',
    '',
    '<https://www.youtube.com/watch?v=dQw4w9WgXcQ>',
    '',
    'https://x.com/xlsama/status/1234567890123456789',
    '',
    '- 列表里的 https://example.com/in-list 保持行内',
    '',
    '> https://example.com/in-quote',
    '',
    '```',
    'https://example.com/in-code',
    '```',
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

  test('the same paragraphs are recognised before and after a round trip', () => {
    const before = blocksOf(SAMPLE);
    expect(before).toEqual([
      null,
      'https://example.com/card',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://x.com/xlsama/status/1234567890123456789',
    ]);
    expect(blocksOf(roundTrip(SAMPLE))).toEqual(before);
  });

  test('the shape the formatter leaves behind still parses to the same blocks', () => {
    // `oxfmt` normalises a bare-URL paragraph by putting a blank line either
    // side of it and stripping trailing spaces — the write-back after a save
    // hands the editor exactly this, and it must not change what is rendered.
    const formatted = ['https://example.com/card', '', '<https://youtu.be/dQw4w9WgXcQ>', ''].join('\n');
    const parsed: string[] = [];
    markdownToDoc(formatted).forEach((node) => {
      const block = detectLinkBlock(node.textContent);
      if (block !== null) parsed.push(block.url);
    });
    expect(parsed).toEqual(['https://example.com/card', 'https://youtu.be/dQw4w9WgXcQ']);
    expect(roundTrip(formatted)).toBe(formatted);
  });
});
