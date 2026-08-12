/**
 * POSIX-ish path helpers for workspace-relative paths. The daemon always speaks
 * POSIX relative paths, so this is all we need — no `node:path` in the browser.
 */

export function dirname(p: string): string {
  const clean = p.replace(/\/+$/, '');
  const idx = clean.lastIndexOf('/');
  if (idx < 0) return '';
  return clean.slice(0, idx);
}

export function basename(p: string): string {
  const clean = p.replace(/\/+$/, '');
  const idx = clean.lastIndexOf('/');
  return idx < 0 ? clean : clean.slice(idx + 1);
}

export function extname(p: string): string {
  const name = basename(p);
  const idx = name.lastIndexOf('.');
  return idx <= 0 ? '' : name.slice(idx);
}

export function stripExtension(p: string): string {
  const name = basename(p);
  const idx = name.lastIndexOf('.');
  return idx <= 0 ? name : name.slice(0, idx);
}

export function isMarkdownPath(p: string): boolean {
  const ext = extname(p).toLowerCase();
  return ext === '.md' || ext === '.markdown';
}

/** Collapses `.` / `..` segments. Leading `..` that escape the root are dropped. */
export function normalize(p: string): string {
  const out: string[] = [];
  for (const segment of p.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

export function join(...parts: string[]): string {
  return normalize(parts.filter((part) => part !== '').join('/'));
}

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i;

export function isAbsoluteUrl(src: string): boolean {
  return ABSOLUTE_URL.test(src) || src.startsWith('//');
}

/**
 * Maps a markdown image `src` to something the browser can load.
 *
 * - `http(s)://…`, `data:…` and other absolute URLs pass through untouched.
 * - Anything else is treated as relative to the directory of `docPath` and
 *   served through the daemon's `/raw/<workspace relative path>` route.
 */
export function resolveImageUrl(src: string, docPath: string | null): string | undefined {
  const trimmed = src.trim();
  if (trimmed === '') return undefined;
  if (isAbsoluteUrl(trimmed)) return trimmed;
  if (trimmed.startsWith('/raw/')) return trimmed;

  const [rawPath = '', ...rest] = trimmed.split(/(?=[?#])/);
  const suffix = rest.join('');
  const base = trimmed.startsWith('/') ? '' : (docPath === null ? '' : dirname(docPath));
  const workspacePath = join(base, rawPath);
  if (workspacePath === '') return undefined;
  return `/raw/${workspacePath.split('/').map(encodeURIComponent).join('/')}${suffix}`;
}
