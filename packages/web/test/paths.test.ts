import { describe, expect, test } from 'bun:test';
import {
  basename,
  dirname,
  isMarkdown,
  join,
  normalize,
  resolveRawUrl,
  stripExtension,
  withMarkdownExtension,
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

  test('isMarkdown', () => {
    expect(isMarkdown('a.md')).toBe(true);
    expect(isMarkdown('a.MARKDOWN')).toBe(true);
    expect(isMarkdown('a.txt')).toBe(false);
    expect(isMarkdown('dir')).toBe(false);
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

describe('resolveRawUrl', () => {
  test('relative paths resolve against the document directory', () => {
    expect(resolveRawUrl('assets/a.png', 'notes/day.md')).toBe('/raw/notes/assets/a.png');
    expect(resolveRawUrl('a.png', 'day.md')).toBe('/raw/a.png');
  });

  test('parent traversal is normalized', () => {
    expect(resolveRawUrl('../img/a.png', 'notes/deep/day.md')).toBe('/raw/notes/img/a.png');
    expect(resolveRawUrl('../../../a.png', 'notes/day.md')).toBe('/raw/a.png');
  });

  test('absolute urls pass through', () => {
    expect(resolveRawUrl('https://x.dev/a.png', 'a.md')).toBe('https://x.dev/a.png');
    expect(resolveRawUrl('data:image/png;base64,AAA', 'a.md')).toBe('data:image/png;base64,AAA');
    expect(resolveRawUrl('//cdn.dev/a.png', 'a.md')).toBe('//cdn.dev/a.png');
  });

  test('already-resolved and empty sources', () => {
    expect(resolveRawUrl('/raw/a/b.png', 'a.md')).toBe('/raw/a/b.png');
    expect(resolveRawUrl('   ', 'a.md')).toBeUndefined();
  });

  test('a reference with no path of its own names no file', () => {
    expect(resolveRawUrl('#heading', 'notes/day.md')).toBeUndefined();
    expect(resolveRawUrl('?v=2', 'notes/day.md')).toBeUndefined();
  });

  test('non-image files resolve the same way', () => {
    expect(resolveRawUrl('./assets/flow.html', 'docs/day.md')).toBe('/raw/docs/assets/flow.html');
  });

  test('query and hash suffixes survive, path segments are encoded', () => {
    expect(resolveRawUrl('assets/a b.png', 'notes/day.md')).toBe('/raw/notes/assets/a%20b.png');
    expect(resolveRawUrl('a.png?v=2', 'day.md')).toBe('/raw/a.png?v=2');
  });

  test('no document open: resolve against the workspace root', () => {
    expect(resolveRawUrl('assets/a.png', null)).toBe('/raw/assets/a.png');
  });
});

describe('withMarkdownExtension', () => {
  test('supplies the extension the daemon insists on', () => {
    expect(withMarkdownExtension('test23')).toBe('test23.md');
    expect(withMarkdownExtension('  hello  ')).toBe('hello.md');
    expect(withMarkdownExtension('notes.2024')).toBe('notes.2024.md');
    expect(withMarkdownExtension('.gitignore')).toBe('.gitignore.md');
  });

  test('leaves a name that already has one exactly as typed', () => {
    expect(withMarkdownExtension('a.md')).toBe('a.md');
    expect(withMarkdownExtension('a.MD')).toBe('a.MD');
    expect(withMarkdownExtension('a.markdown')).toBe('a.markdown');
  });

  test('an empty name stays empty, so the caller can treat it as a cancel', () => {
    expect(withMarkdownExtension('   ')).toBe('');
  });
});
