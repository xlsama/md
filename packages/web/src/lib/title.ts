/** What the page is called when there is nothing more specific to say. */
const APP_NAME = 'writedown';

/** The last path segment, whichever slash the platform used. */
function lastSegment(path: string): string {
  const segments = path.split(/[/\\]/).filter((s) => s !== '');
  return segments[segments.length - 1] ?? '';
}

/**
 * The browser-tab title.
 *
 * The file name leads: a narrowing tab keeps its beginning, and the file is
 * what tells two writedown tabs apart. The workspace name after it is what
 * tells two *daemons* apart — the same `notes.md` can be open from two roots.
 * Only a page with nothing open at all falls back to the app's own name.
 */
export function documentTitle(docPath: string | null, root: string): string {
  const workspace = lastSegment(root);
  if (docPath !== null && docPath !== '') {
    const file = lastSegment(docPath);
    return workspace === '' ? file : `${file} — ${workspace}`;
  }
  return workspace === '' ? APP_NAME : workspace;
}
