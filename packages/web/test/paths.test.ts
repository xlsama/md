import { describe, expect, test } from 'bun:test';
import {
  basename,
  dirname,
  isMarkdownPath,
  join,
  normalize,
  resolveImageUrl,
  stripExtension,
} from '../src/lib/paths.ts';

describe('path helpers', () => {
  test('dirname / basename', () => {
    expect(dirname('a/b/c.md')).toBe('a/b');
    expect(dirname('c.md')).toBe('');
    expect(dirname('a/b/')).toBe('a');
    expect(basename('a/b/c.md')).toBe('c.md');
    expect(basename('c.md')).toBe('c.md');
    expect(basename('a/b/')).toBe('b');
  });

  test('stripExtension keeps dotfiles intact', () => {
    expect(stripExtension('a/b/c.md')).toBe('c');
    expect(stripExtension('notes.tar.gz')).toBe('notes.tar');
    expect(stripExtension('.gitignore')).toBe('.gitignore');
  });

  test('isMarkdownPath', () => {
    expect(isMarkdownPath('a.md')).toBe(true);
    expect(isMarkdownPath('a.MARKDOWN')).toBe(true);
    expect(isMarkdownPath('a.txt')).toBe(false);
    expect(isMarkdownPath('dir')).toBe(false);
  });

  test('normalize collapses . and ..', () => {
    expect(normalize('a/./b')).toBe('a/b');
    expect(normalize('a/b/../c')).toBe('a/c');
    expect(normalize('a//b')).toBe('a/b');
    expect(normalize('../../a')).toBe('a');
  });

  test('join', () => {
    expect(join('a/b', 'c.md')).toBe('a/b/c.md');
    expect(join('', 'c.md')).toBe('c.md');
    expect(join('a/b', '../c.md')).toBe('a/c.md');
  });
});

describe('resolveImageUrl', () => {
  test('relative paths resolve against the document directory', () => {
    expect(resolveImageUrl('assets/a.png', 'notes/day.md')).toBe('/raw/notes/assets/a.png');
    expect(resolveImageUrl('a.png', 'day.md')).toBe('/raw/a.png');
  });

  test('parent traversal is normalized', () => {
    expect(resolveImageUrl('../img/a.png', 'notes/deep/day.md')).toBe('/raw/notes/img/a.png');
    expect(resolveImageUrl('../../../a.png', 'notes/day.md')).toBe('/raw/a.png');
  });

  test('absolute urls pass through', () => {
    expect(resolveImageUrl('https://x.dev/a.png', 'a.md')).toBe('https://x.dev/a.png');
    expect(resolveImageUrl('data:image/png;base64,AAA', 'a.md')).toBe('data:image/png;base64,AAA');
    expect(resolveImageUrl('//cdn.dev/a.png', 'a.md')).toBe('//cdn.dev/a.png');
  });

  test('already-resolved and empty sources', () => {
    expect(resolveImageUrl('/raw/a/b.png', 'a.md')).toBe('/raw/a/b.png');
    expect(resolveImageUrl('   ', 'a.md')).toBeUndefined();
  });

  test('query and hash suffixes survive, path segments are encoded', () => {
    expect(resolveImageUrl('assets/a b.png', 'notes/day.md')).toBe('/raw/notes/assets/a%20b.png');
    expect(resolveImageUrl('a.png?v=2', 'day.md')).toBe('/raw/a.png?v=2');
  });

  test('no document open: resolve against the workspace root', () => {
    expect(resolveImageUrl('assets/a.png', null)).toBe('/raw/assets/a.png');
  });
});
