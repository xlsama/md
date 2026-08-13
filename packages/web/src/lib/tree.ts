import type { TreeNode } from '@xlsama/md/protocol';
import { basename, isMarkdown, stripExtension } from './paths.ts';

/**
 * Flattens the daemon's tree into the path list `@pierre/trees` consumes.
 * Directories keep a trailing slash so empty ones survive the round trip.
 */
export function toTreePaths(tree: readonly TreeNode[]): string[] {
  const paths: string[] = [];
  const walk = (nodes: readonly TreeNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'dir') {
        paths.push(`${node.path}/`);
        walk(node.children ?? []);
      } else {
        paths.push(node.path);
      }
    }
  };
  walk(tree);
  return paths;
}

const depthOf = (path: string): number => path.replace(/\/+$/, '').split('/').length;

export type TreePathOp =
  | { type: 'add'; path: string }
  | { type: 'remove'; path: string; recursive: true };

/**
 * Minimal `add`/`remove` operations turning `prev` into `next`.
 *
 * Patching the file tree instead of resetting it keeps directory expansion and
 * scroll position intact across the frequent full-tree pushes the daemon
 * sends. Returns `null` when the change is large enough that a plain reset is
 * cheaper and safer.
 *
 * Removals come first (deepest first, and skipped when a removed ancestor
 * already takes them out recursively); additions follow shallowest first so a
 * parent directory always exists before its children.
 */
export function diffTreePaths(
  prev: readonly string[],
  next: readonly string[],
  maxOps = 200
): TreePathOp[] | null {
  const prevSet = new Set(prev);
  const nextSet = new Set(next);

  const removed = prev.filter((path) => !nextSet.has(path));
  const removedDirs = removed.filter((path) => path.endsWith('/'));
  const removals = removed
    .filter((path) => !removedDirs.some((dir) => dir !== path && path.startsWith(dir)))
    .toSorted((a, b) => depthOf(b) - depthOf(a));

  const additions = next
    .filter((path) => !prevSet.has(path))
    .toSorted((a, b) => depthOf(a) - depthOf(b));

  const ops: TreePathOp[] = [
    ...removals.map((path): TreePathOp => ({ type: 'remove', path, recursive: true })),
    ...additions.map((path): TreePathOp => ({ type: 'add', path })),
  ];
  return ops.length > maxOps ? null : ops;
}

export function collectFiles(tree: readonly TreeNode[]): string[] {
  const files: string[] = [];
  const walk = (nodes: readonly TreeNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'dir') walk(node.children ?? []);
      else files.push(node.path);
    }
  };
  walk(tree);
  return files;
}

export function markdownFiles(tree: readonly TreeNode[]): string[] {
  return collectFiles(tree).filter(isMarkdown);
}

/** Directory paths, plus `''` for the workspace root. */
export function collectDirs(tree: readonly TreeNode[]): string[] {
  const dirs: string[] = [''];
  const walk = (nodes: readonly TreeNode[]): void => {
    for (const node of nodes) {
      if (node.kind !== 'dir') continue;
      dirs.push(node.path);
      walk(node.children ?? []);
    }
  };
  walk(tree);
  return dirs;
}

export function hasPath(tree: readonly TreeNode[], target: string): boolean {
  const walk = (nodes: readonly TreeNode[]): boolean =>
    nodes.some((node) => node.path === target || (node.children ? walk(node.children) : false));
  return walk(tree);
}

/**
 * Fuzzy-ranks markdown notes for the `[[wikilink]]` menu.
 *
 * Matching is case-insensitive on the base name (extension stripped) with the
 * full path as a fallback, so `[[api]]` also finds `docs/api-notes.md`.
 * Ranking: exact base name, then prefix, then substring, then path substring;
 * ties break on path length and then alphabetically.
 */
export function searchNotes(files: readonly string[], query: string, limit = 20): string[] {
  const q = query.trim().toLowerCase();
  const scored: { path: string; score: number }[] = [];

  for (const path of files) {
    const name = stripExtension(path).toLowerCase();
    if (q === '') {
      scored.push({ path, score: 3 });
      continue;
    }
    if (name === q) scored.push({ path, score: 0 });
    else if (name.startsWith(q)) scored.push({ path, score: 1 });
    else if (name.includes(q)) scored.push({ path, score: 2 });
    else if (path.toLowerCase().includes(q)) scored.push({ path, score: 3 });
  }

  return scored
    .toSorted(
      (a, b) =>
        a.score - b.score ||
        a.path.length - b.path.length ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    )
    .slice(0, limit)
    .map((entry) => entry.path);
}

/**
 * Resolves a wikilink target to a workspace path.
 *
 * A target may be a bare base name (`Daily journal`), a name with extension,
 * or a full relative path. Targets are matched relative to `fromPath`'s
 * directory first so sibling notes win, then anywhere in the workspace.
 * Returns `null` when nothing matches.
 */
export function resolveWikilink(
  files: readonly string[],
  target: string,
  fromPath: string | null = null
): string | null {
  const raw = target.split('#')[0]?.trim() ?? '';
  if (raw === '') return null;
  const needle = raw.toLowerCase();
  const needleNoExt = stripExtension(raw).toLowerCase();

  const exact = files.filter(
    (path) => path.toLowerCase() === needle || path.toLowerCase() === `${needle}.md`
  );
  if (exact[0] !== undefined) return exact[0];

  const byName = files.filter((path) => {
    const name = basename(path).toLowerCase();
    return name === needle || stripExtension(path).toLowerCase() === needleNoExt;
  });
  if (byName.length === 0) return null;
  if (byName.length === 1) return byName[0] ?? null;

  const dir = fromPath === null ? '' : fromPath.slice(0, Math.max(0, fromPath.lastIndexOf('/')));
  const sibling = byName.find((path) => path.slice(0, Math.max(0, path.lastIndexOf('/'))) === dir);
  return sibling ?? byName[0] ?? null;
}
