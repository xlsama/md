import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import trash from 'trash';
import type { TreeNode } from './protocol.ts';

export const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
export const EXCLUDED_DIRS = new Set(['node_modules']);

export class PathViolationError extends Error {
  constructor(input: string) {
    super(`path escapes workspace: ${input}`);
    this.name = 'PathViolationError';
  }
}

export function isMarkdown(p: string): boolean {
  return MARKDOWN_EXTENSIONS.has(path.extname(p).toLowerCase());
}

export function isExcludedName(name: string): boolean {
  return name.startsWith('.') || EXCLUDED_DIRS.has(name);
}

export function isExcludedRelPath(rel: string): boolean {
  return rel.split('/').some((seg) => seg.length > 0 && isExcludedName(seg));
}

export function hashContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export async function resolveInRoot(root: string, rel: string): Promise<string> {
  if (typeof rel !== 'string') throw new PathViolationError(String(rel));
  if (rel.includes('\0')) throw new PathViolationError(rel);
  const cleaned = rel.replace(/^[/\\]+/, '');
  const abs = path.resolve(root, cleaned);
  if (!isInside(root, abs)) throw new PathViolationError(rel);

  const missing: string[] = [];
  let probe = abs;
  while (!(await exists(probe))) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    missing.push(path.basename(probe));
    probe = parent;
  }
  const realExisting = await realpathOrSelf(probe);
  const realTarget = missing.length ? path.resolve(realExisting, ...missing.toReversed()) : realExisting;
  const realRoot = await realpathOrSelf(root);
  if (!isInside(realRoot, realTarget)) throw new PathViolationError(rel);
  return abs;
}

export function relativeInRoot(root: string, abs: string): string {
  return toPosix(path.relative(root, abs));
}

const byName = (a: TreeNode, b: TreeNode) => a.name.localeCompare(b.name, 'en');

async function scanDir(root: string, dirAbs: string): Promise<TreeNode[]> {
  const entries = await fs.readdir(dirAbs, { withFileTypes: true, encoding: 'utf8' }).catch(() => []);
  const dirs: TreeNode[] = [];
  const files: TreeNode[] = [];
  for (const entry of entries) {
    if (isExcludedName(entry.name)) continue;
    const abs = path.join(dirAbs, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      const st = await fs.stat(abs).catch(() => null);
      if (!st || st.isDirectory()) continue;
      isDir = false;
      isFile = st.isFile();
    }
    const rel = relativeInRoot(root, abs);
    if (isDir) {
      dirs.push({ name: entry.name, path: rel, kind: 'dir', children: await scanDir(root, abs) });
    } else if (isFile && isMarkdown(entry.name)) {
      files.push({ name: entry.name, path: rel, kind: 'file' });
    }
  }
  dirs.sort(byName);
  files.sort(byName);
  return [...dirs, ...files];
}

export async function scanTree(root: string): Promise<TreeNode[]> {
  return scanDir(root, root);
}

export async function readText(abs: string): Promise<string> {
  return fs.readFile(abs, 'utf8');
}

export async function readTextIfExists(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, 'utf8');
  } catch {
    return null;
  }
}

export async function writeText(abs: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, 'utf8');
}

export async function createEntry(abs: string, kind: 'file' | 'dir'): Promise<void> {
  if (await exists(abs)) throw new Error(`already exists: ${path.basename(abs)}`);
  if (kind === 'dir') {
    await fs.mkdir(abs, { recursive: true });
    return;
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, '', { encoding: 'utf8', flag: 'wx' });
}

export async function renameEntry(fromAbs: string, toAbs: string): Promise<void> {
  if (await exists(toAbs)) throw new Error(`already exists: ${path.basename(toAbs)}`);
  await fs.mkdir(path.dirname(toAbs), { recursive: true });
  await fs.rename(fromAbs, toAbs);
}

export type Deleter = (abs: string) => Promise<void>;

let deleter: Deleter = async (abs) => {
  await trash(abs, { glob: false });
};

export function setDeleter(fn: Deleter): void {
  deleter = fn;
}

export async function deleteEntry(abs: string): Promise<void> {
  if (!(await exists(abs))) throw new Error(`not found: ${path.basename(abs)}`);
  await deleter(abs);
}

const pad = (n: number) => String(n).padStart(2, '0');

export function timestampPrefix(date = new Date()): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export function sanitizeAssetName(name: string): string {
  const base = path.basename(name || 'pasted.png').replace(/[/\\\0]/g, '_').trim();
  return base.length ? base : 'pasted.png';
}
