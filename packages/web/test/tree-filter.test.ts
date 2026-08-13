import { describe, expect, test } from 'bun:test';
import { filterTreePaths, highlightSegments } from '../src/lib/tree-filter.ts';

const PATHS = [
  'docs/',
  'docs/nested/',
  'docs/nested/beta.md',
  'docs/alpha.md',
  'notes/',
  'notes/会议记录.md',
  'outline.md',
  'typography.md',
];

function paths(query: string): string[] {
  return (filterTreePaths(PATHS, query) ?? []).map((match) => match.path);
}

describe('filterTreePaths', () => {
  test('a blank query means no filtering at all', () => {
    expect(filterTreePaths(PATHS, '')).toBeNull();
    expect(filterTreePaths(PATHS, '   ')).toBeNull();
  });

  test('lists the matching files, folders excluded', () => {
    expect(paths('beta')).toEqual(['docs/nested/beta.md']);
    expect(paths('outline')).toEqual(['outline.md']);
  });

  test('matches a subsequence of the file name', () => {
    expect(paths('tpg')).toEqual(['typography.md']);
  });

  test('matches a Chinese name on a plain substring', () => {
    expect(paths('会议')).toEqual(['notes/会议记录.md']);
  });

  test('carries the base name and the matched offsets for highlighting', () => {
    const matches = filterTreePaths(PATHS, 'alpha') ?? [];
    expect(matches[0]?.name).toBe('alpha.md');
    expect([...(matches[0]?.indexes ?? [])]).toEqual([0, 1, 2, 3, 4]);
  });

  test('a query nothing matches yields an empty list, not null', () => {
    expect(filterTreePaths(PATHS, 'zzzz')).toEqual([]);
  });

  test('ranks the better match first', () => {
    // `alpha.md` matches from the first character; `typography.md` only through
    // a scattered subsequence.
    expect(paths('a')[0]).toBe('docs/alpha.md');
  });
});

describe('highlightSegments', () => {
  test('merges adjacent offsets into one run', () => {
    expect(highlightSegments('alpha.md', [0, 1, 2, 3, 4])).toEqual([
      { text: 'alpha', hit: true },
      { text: '.md', hit: false },
    ]);
  });

  test('keeps a scattered subsequence as separate runs', () => {
    const name = 'typography.md';
    const indexes = (filterTreePaths(['typography.md'], 'tpg') ?? [])[0]?.indexes ?? [];
    const segments = highlightSegments(name, indexes);
    expect(segments.map((segment) => segment.text).join('')).toBe(name);
    expect(segments.filter((segment) => segment.hit).map((segment) => segment.text)).toEqual([
      't',
      'p',
      'g',
    ]);
  });

  test('a hit at the very end closes the last run', () => {
    expect(highlightSegments('note', [3])).toEqual([
      { text: 'not', hit: false },
      { text: 'e', hit: true },
    ]);
  });

  test('no offsets leaves the name in one plain segment', () => {
    expect(highlightSegments('outline.md', [])).toEqual([{ text: 'outline.md', hit: false }]);
  });

  test('highlights a Chinese name by character', () => {
    expect(highlightSegments('会议记录.md', [0, 1])).toEqual([
      { text: '会议', hit: true },
      { text: '记录.md', hit: false },
    ]);
  });

  test('tolerates unsorted, duplicated and out-of-range offsets', () => {
    expect(highlightSegments('beta.md', [3, 0, 0, 99, -1, 2, 1])).toEqual([
      { text: 'beta', hit: true },
      { text: '.md', hit: false },
    ]);
  });
});
