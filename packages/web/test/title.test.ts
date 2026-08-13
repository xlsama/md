import { describe, expect, test } from 'bun:test';
import { documentTitle } from '../src/lib/title.ts';

describe('documentTitle', () => {
  test('names the tab after the file, then the workspace', () => {
    expect(documentTitle('未命名.md', '/Users/x/i/md')).toBe('未命名.md — md');
    expect(documentTitle('docs/guide.md', '/Users/x/i/md')).toBe('guide.md — md');
  });

  test('a workspace with nothing open shows its own name', () => {
    expect(documentTitle(null, '/Users/x/i/md')).toBe('md');
    expect(documentTitle('', '/Users/x/i/md')).toBe('md');
  });

  test('no workspace at all falls back to the app name', () => {
    expect(documentTitle(null, '')).toBe('writedown');
  });

  test('windows-style roots still yield the directory name', () => {
    expect(documentTitle('a.md', 'C:\\Users\\x\\notes')).toBe('a.md — notes');
  });
});
