import type { TreeNode } from '@xlsama/md/protocol';
import { describe, expect, test } from 'bun:test';
import {
  collectDirs,
  diffTreePaths,
  hasPath,
  markdownFiles,
  resolveWikilink,
  searchNotes,
  toTreePaths,
} from '../src/lib/tree.ts';

const tree: TreeNode[] = [
  {
    name: 'notes',
    path: 'notes',
    kind: 'dir',
    children: [
      { name: 'daily.md', path: 'notes/daily.md', kind: 'file' },
      { name: 'empty', path: 'notes/empty', kind: 'dir', children: [] },
    ],
  },
  { name: 'README.md', path: 'README.md', kind: 'file' },
  { name: 'notes.md', path: 'notes.md', kind: 'file' },
];

describe('tree flattening', () => {
  test('directories keep a trailing slash so empty ones survive', () => {
    expect(toTreePaths(tree)).toEqual([
      'notes/',
      'notes/daily.md',
      'notes/empty/',
      'README.md',
      'notes.md',
    ]);
  });

  test('markdownFiles / collectDirs / hasPath', () => {
    expect(markdownFiles(tree)).toEqual(['notes/daily.md', 'README.md', 'notes.md']);
    expect(collectDirs(tree)).toEqual(['', 'notes', 'notes/empty']);
    expect(hasPath(tree, 'notes/daily.md')).toBe(true);
    expect(hasPath(tree, 'notes/gone.md')).toBe(false);
  });
});

describe('diffTreePaths', () => {
  test('no change yields no operations', () => {
    expect(diffTreePaths(['a.md'], ['a.md'])).toEqual([]);
  });

  test('additions come parent-first', () => {
    expect(diffTreePaths([], ['a/b/c.md', 'a/'])).toEqual([
      { type: 'add', path: 'a/' },
      { type: 'add', path: 'a/b/c.md' },
    ]);
  });

  test('removals come before additions and skip descendants of removed dirs', () => {
    const ops = diffTreePaths(['a/', 'a/b.md', 'c.md'], ['d.md']);
    expect(ops).toEqual([
      { type: 'remove', path: 'a/', recursive: true },
      { type: 'remove', path: 'c.md', recursive: true },
      { type: 'add', path: 'd.md' },
    ]);
  });

  test('bails out to a full reset when the change is large', () => {
    const next = Array.from({ length: 12 }, (_, i) => `f${String(i)}.md`);
    expect(diffTreePaths([], next, 10)).toBeNull();
  });
});

describe('searchNotes', () => {
  const files = ['notes/daily.md', 'README.md', 'notes.md', 'archive/daily-old.md'];

  test('ranks exact base name, then prefix, then substring', () => {
    expect(searchNotes(files, 'daily')).toEqual(['notes/daily.md', 'archive/daily-old.md']);
    expect(searchNotes(files, 'notes')).toEqual(['notes.md', 'notes/daily.md']);
  });

  test('an empty query lists everything, shortest path first', () => {
    expect(searchNotes(files, '')).toEqual([
      'notes.md',
      'README.md',
      'notes/daily.md',
      'archive/daily-old.md',
    ]);
  });

  test('respects the limit and is case-insensitive', () => {
    expect(searchNotes(files, 'DAILY', 1)).toEqual(['notes/daily.md']);
  });
});

describe('resolveWikilink', () => {
  const files = ['notes/daily.md', 'archive/daily.md', 'README.md', 'a/b/deep.md'];

  test('resolves a bare base name', () => {
    expect(resolveWikilink(files, 'README')).toBe('README.md');
    expect(resolveWikilink(files, 'README.md')).toBe('README.md');
  });

  test('a full relative path wins over base-name matching', () => {
    expect(resolveWikilink(files, 'a/b/deep')).toBe('a/b/deep.md');
    expect(resolveWikilink(files, 'a/b/deep.md')).toBe('a/b/deep.md');
  });

  test('ambiguous names prefer a sibling of the current document', () => {
    expect(resolveWikilink(files, 'daily', 'archive/x.md')).toBe('archive/daily.md');
    expect(resolveWikilink(files, 'daily', 'notes/x.md')).toBe('notes/daily.md');
    expect(resolveWikilink(files, 'daily', 'other/x.md')).toBe('notes/daily.md');
  });

  test('heading fragments are stripped, misses return null', () => {
    expect(resolveWikilink(files, 'README#intro')).toBe('README.md');
    expect(resolveWikilink(files, 'nope')).toBeNull();
    expect(resolveWikilink(files, '  ')).toBeNull();
  });
});
