import { z } from 'zod';

/**
 * The one piece of app state the URL carries: which document is open.
 *
 * Everything else — workspace root, outline, theme — belongs to the daemon or
 * to local settings, so the address bar stays short enough to paste.
 */
export interface FileSearch {
  /** Workspace-relative path of the open document. */
  file?: string;
}

/**
 * `catch` rather than a hard failure: a hand-edited or stale `?file=` should
 * degrade to "no file selected", never to a router error screen.
 */
const fileSearchSchema = z.object({
  file: z.string().min(1).optional().catch(undefined),
});

export function validateFileSearch(search: Record<string, unknown>): FileSearch {
  const { file } = fileSearchSchema.parse(search);
  // The key is dropped rather than set to `undefined`, so an empty search
  // object serialises to a bare `/` instead of `/?file=`.
  return file === undefined ? {} : { file };
}

/** Reads `?file` out of a parsed search object, from anywhere it is untyped. */
export function readFileParam(search: unknown): string | null {
  if (typeof search !== 'object' || search === null) return null;
  const { file } = search as { file?: unknown };
  return typeof file === 'string' && file !== '' ? file : null;
}

/**
 * The scroll-restoration cache key.
 *
 * The default key is per history entry, which would be one bucket for the whole
 * app: every document is opened with `replace`, so there is only ever one entry.
 * Keying on the document instead is what gives each file its own remembered
 * offset, and what makes A → B → A come back to where A was left.
 */
export function scrollRestorationKey(search: unknown): string {
  const file = readFileParam(search);
  return file === null ? 'md:workspace' : `md:${file}`;
}

/**
 * The same key, in the shape both consumers want.
 *
 * It has to be handed to the router *and* to `useElementScrollRestoration`
 * separately: the hook reads the cache with its own `getKey` and does not fall
 * back to the router's, so leaving it out silently looks up the default
 * per-history-entry key and finds nothing.
 */
export function locationScrollKey(location: { search: unknown }): string {
  return scrollRestorationKey(location.search);
}

/**
 * The session's window onto the URL, handed to it by the router.
 *
 * Injected rather than imported so the session stays a plain object that knows
 * nothing about React or about the router instance.
 */
export interface RouteBridge {
  /** `?file` as it stands right now, or null. */
  readFile: () => string | null;
  /** Mirrors the open document into the URL, replacing the history entry. */
  setFile: (file: string | null) => void;
}

/** What a `workspace` message should do with the document that is open. */
export type WorkspaceAction =
  | { kind: 'open'; path: string }
  /** Re-request the current document without touching editor state. */
  | { kind: 'resync'; path: string }
  | { kind: 'close' }
  | { kind: 'none' };

export interface WorkspaceInput {
  /** The daemon switched to a different root (never true on the first message). */
  rootChanged: boolean;
  /** `?file` from the URL, or null once it has been honoured. */
  urlFile: string | null;
  /** The document the daemon remembers, if any. */
  focus: string | null;
  /** Document currently in the editor. */
  currentPath: string | null;
  /** Unsaved edits, which a reconnect must not clobber. */
  dirty: boolean;
  /** Whether a path is present in the tree that came with the message. */
  exists: (path: string) => boolean;
}

/**
 * Decides which document a `workspace` message lands on.
 *
 * Three situations reach this, and they want different things:
 *
 * - **page load** — `?file` wins over the daemon's remembered focus, so a
 *   pasted or reloaded URL opens the document it names. An unknown path (the
 *   file was deleted, or the link came from another workspace) falls through
 *   to the focus rather than asking the daemon for something that is not there;
 * - **workspace switch** — `?file` names a file under the old root, so it is
 *   dropped and the daemon's focus decides. No focus means nothing to show;
 * - **reconnect** — the same root comes back; the open document is re-requested
 *   so it picks up whatever changed while the socket was down, unless it holds
 *   edits that have not been saved yet.
 */
export function decideWorkspace(input: WorkspaceInput): WorkspaceAction {
  const { rootChanged, urlFile, focus, currentPath, dirty, exists } = input;

  if (!rootChanged && urlFile !== null && urlFile !== currentPath && exists(urlFile)) {
    return { kind: 'open', path: urlFile };
  }
  if (focus !== null && focus !== '') return { kind: 'open', path: focus };
  if (rootChanged) return { kind: 'close' };
  if (currentPath !== null && !dirty) return { kind: 'resync', path: currentPath };
  return { kind: 'none' };
}
