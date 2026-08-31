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

/** Same name, same rule as the daemon's `isMarkdown` in `packages/md/src/files.ts`. */
export function isMarkdown(p: string): boolean {
  const ext = extname(p).toLowerCase();
  return ext === '.md' || ext === '.markdown';
}

/**
 * The name a new note is actually created under.
 *
 * The daemon only creates markdown files, so a name typed without an extension
 * would be rejected outright — supplying the one the user obviously meant is
 * friendlier than an error. A name that already ends in `.md`/`.markdown` is
 * left exactly as typed; any other extension is kept and `.md` appended, so
 * `notes.2024` stays recognisable as `notes.2024.md`.
 */
export function withMarkdownExtension(name: string): string {
  const trimmed = name.trim();
  return trimmed === '' || isMarkdown(trimmed) ? trimmed : `${trimmed}.md`;
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
 * Maps a markdown `src`/`href` to something the browser can load — an image,
 * an HTML page opened in a new tab, any file the workspace holds.
 *
 * - `http(s)://…`, `data:…` and other absolute URLs pass through untouched.
 * - Anything else is treated as relative to the directory of `docPath` and
 *   served through the daemon's `/raw/<workspace relative path>` route.
 *
 * A reference with no path of its own — a bare `#heading` — names no file and
 * comes back `undefined` rather than resolving to the containing directory.
 */
export function resolveRawUrl(src: string, docPath: string | null): string | undefined {
  const trimmed = src.trim();
  if (trimmed === '') return undefined;
  if (isAbsoluteUrl(trimmed)) return trimmed;
  if (trimmed.startsWith('/raw/')) return trimmed;

  const [, rawPath = '', suffix = ''] = /^([^?#]*)([?#].*)?$/.exec(trimmed) ?? [];
  if (rawPath === '') return undefined;
  const base = trimmed.startsWith('/') ? '' : (docPath === null ? '' : dirname(docPath));
  const workspacePath = join(base, rawPath);
  if (workspacePath === '') return undefined;
  return `/raw/${workspacePath.split('/').map(encodeURIComponent).join('/')}${suffix}`;
}
