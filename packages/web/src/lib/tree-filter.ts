import fuzzysort from 'fuzzysort';
import { basename } from './paths.ts';

export interface FileMatch {
  path: string;
  /** The base name, which is what the query was matched against. */
  name: string;
  /** Matched character offsets inside `name`, for highlighting. */
  indexes: readonly number[];
}

export interface NameSegment {
  text: string;
  hit: boolean;
}

/**
 * How many hits the filter is willing to hand back.
 *
 * Every result is a live DOM row with per-character highlighting, so an
 * unbounded list turns a one-letter query in a large workspace into thousands
 * of them. Nobody scrolls that far — anyone who has not found their note in the
 * first screen types another letter — and the list says so when it is full.
 */
export const FILTER_LIMIT = 200;

/**
 * The notes whose *name* fuzzy-matches `query`, best score first.
 *
 * Returns `null` for a blank query, which callers read as "no filtering" and
 * is deliberately distinct from an empty result (a query that matched
 * nothing). Directories never take part: the result list names files, and the
 * folder each one lives in is shown alongside its name rather than as a row.
 *
 * Matching is delegated to `fuzzysort`: it is a subsequence matcher, so `tpg`
 * finds `typography.md`, and because it compares code units a Chinese name
 * matches on a plain substring too. `threshold: 0` keeps every subsequence
 * hit — a filter that silently drops a real match is worse than a loose one —
 * but at most {@link FILTER_LIMIT} of them are returned, so a result list that
 * is exactly that long should be read as "there may be more".
 */
export function filterTreePaths(paths: readonly string[], query: string): FileMatch[] | null {
  const trimmed = query.trim();
  if (trimmed === '') return null;

  const files = paths
    .filter((path) => !path.endsWith('/'))
    .map((path) => ({ path, name: basename(path) }));
  const results = fuzzysort.go(trimmed, files, {
    key: 'name',
    limit: FILTER_LIMIT,
    threshold: 0,
  });

  return results.map((result) => ({
    path: result.obj.path,
    name: result.obj.name,
    indexes: result.indexes,
  }));
}

/**
 * Cuts `name` into alternating plain and matched runs, so a renderer can style
 * the matched characters without doing any index arithmetic of its own.
 *
 * Offsets are sorted, de-duplicated and dropped when they fall outside the
 * name: the list comes from a matcher that is handed the same string, but a
 * caller pairing stale offsets with a fresh name should get a plain name back
 * rather than a scrambled one.
 */
export function highlightSegments(name: string, indexes: readonly number[]): NameSegment[] {
  const hits = [...new Set(indexes)]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < name.length)
    .toSorted((a, b) => a - b);
  if (hits.length === 0) return [{ text: name, hit: false }];

  const runs: { start: number; end: number }[] = [];
  for (const index of hits) {
    const last = runs.at(-1);
    if (last !== undefined && last.end === index) last.end = index + 1;
    else runs.push({ start: index, end: index + 1 });
  }

  const segments: NameSegment[] = [];
  let cursor = 0;
  for (const run of runs) {
    if (run.start > cursor) segments.push({ text: name.slice(cursor, run.start), hit: false });
    segments.push({ text: name.slice(run.start, run.end), hit: true });
    cursor = run.end;
  }
  if (cursor < name.length) segments.push({ text: name.slice(cursor), hit: false });
  return segments;
}
