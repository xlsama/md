import type { ClientMessage, ServerMessage, TreeNode } from '@xlsama/md/protocol';
import type { EditorHandle } from '@meowdown/react';
import { importAsset } from './api.ts';
import { extractRemoteImageUrls } from './lib/paste-images.ts';
import { replaceTextInEditor } from './lib/replace-text.ts';
import { extractToc, sameToc } from './lib/toc.ts';
import { decideWorkspace, type RouteBridge } from './lib/route.ts';
import { hasPath } from './lib/tree.ts';
import {
  classifyExternal,
  resolveSaved,
  shouldReflow,
  type PendingFormatted,
  type ReflowReason,
} from './lib/sync.ts';
import { useStore } from './store.ts';

const IDLE_REFLOW = 2000;
const TOC_DEBOUNCE = 400;

/**
 * How long a document has to stay unsaved before the file tree says so.
 *
 * Comfortably longer than the debounced autosave, so ordinary typing never
 * paints the marker: what it is left to report is the states that persist —
 * a save still in flight after a second, a refused write, a conflict. Those two
 * bypass the wait entirely.
 */
const DIRTY_SETTLE = 1000;

type Send = (msg: ClientMessage) => void;
type TimerName = 'saveTimer' | 'idleTimer' | 'tocTimer' | 'dirtyTimer';

/**
 * The imperative bridge between the WebSocket protocol and the (uncontrolled)
 * meowdown editor. All the ordering-sensitive rules from DESIGN.md live here;
 * the decisions themselves are pure functions in `lib/sync.ts`.
 *
 * **The four names of "the current document".** The same path is spelled four
 * ways, and every one of them is written from {@link Session.setPath}:
 *
 * | where | name | who reads it |
 * |---|---|---|
 * | WS protocol | `focus` (server → client), `path` on `open`/`save` | the daemon, which also persists it to `state.json` |
 * | this class | `this.path` | every guard that drops a reply for a document we already left |
 * | store | `docPath` | the React tree: tree selection, top bar, editor gating |
 * | URL | `?file=` | reloads and the per-file scroll cache |
 *
 * They can disagree only in the gap between asking for a document and its
 * content arriving, which is exactly what `docLoading` marks.
 *
 * Invariants:
 * - only one `save` is in flight per document, so a debounced save can never
 *   race ahead of its own write and come back as a spurious conflict;
 * - `saved.content` (formatted) is never pushed into the editor on arrival —
 *   it is staged and flowed back only while the user is idle;
 * - every server message is matched against the current path before it is
 *   applied, so replies for a document we already left are dropped.
 */
class Session {
  private handle: EditorHandle | null = null;
  private send: Send | null = null;
  private route: RouteBridge | null = null;
  /**
   * `?file` is honoured exactly once, by the first `workspace` message of a
   * page load. After that the URL is an output of the session, not an input —
   * a reconnect must not drag the reader back to the file they started on.
   */
  private urlPending = true;

  private root: string | null = null;
  private path: string | null = null;
  private baseHash = '';
  private dirty = false;
  private saving = false;
  /** Set when the daemon refused a write; cleared by the next successful one. */
  private saveFailed = false;
  private sentContent: string | null = null;
  private editedWhileSaving = false;
  private pending: PendingFormatted | null = null;
  private lastEditAt = 0;
  /** Path of a just-created file, opened as soon as it shows up in the tree. */
  private pendingOpen: string | null = null;
  /** Content that arrived before the editor mounted. */
  private queuedLoad: { path: string; content: string; hash: string } | null = null;

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private tocTimer: ReturnType<typeof setTimeout> | null = null;
  private dirtyTimer: ReturnType<typeof setTimeout> | null = null;

  attach(handle: EditorHandle | null): void {
    this.handle = handle;
    if (handle === null || this.queuedLoad === null) return;
    const queued = this.queuedLoad;
    this.queuedLoad = null;
    this.applyLoad(queued);
  }

  setSend(send: Send | null): void {
    this.send = send;
  }

  setRoute(route: RouteBridge | null): void {
    this.route = route;
  }

  /**
   * Path of the document currently in the editor. Updated *before* the editor
   * is written to, so resolvers reading it during a reparse see the new
   * document's directory rather than the one being replaced.
   */
  currentPath(): string | null {
    return this.path;
  }

  // --------------------------------------------------------------- editor →

  onDocChange(): void {
    this.dirty = true;
    this.lastEditAt = Date.now();
    this.pending = null;
    this.clearTimer('idleTimer');
    if (this.saving) this.editedWhileSaving = true;
    this.syncDirty();
    this.scheduleSave();
    this.scheduleToc();
  }

  onBlur(): void {
    this.maybeReflow('blur');
  }

  /**
   * Imports the remote images a paste brought in — see `paste-images.ts`.
   *
   * Fire-and-forget from the paste event: the pasted content lands in the
   * document immediately (remote URLs and all), and each image is swapped to
   * its local path as its download finishes. The swap is a literal text
   * replacement, so a document that moved on in the meantime — switched away,
   * edited, undone — simply no longer contains the URL and nothing happens.
   */
  importPastedImages(pasted: string): void {
    if (!useStore.getState().settings.importPastedImages) return;
    const docPath = this.path;
    if (docPath === null) return;
    const urls = extractRemoteImageUrls(pasted);
    if (urls.length === 0) return;
    void this.runImageImports(urls, docPath);
  }

  private async runImageImports(urls: string[], docPath: string): Promise<void> {
    let failed = 0;
    const queue = [...urls];
    const worker = async (): Promise<void> => {
      for (;;) {
        const url = queue.shift();
        if (url === undefined) return;
        try {
          const asset = await importAsset(url, docPath);
          const editor = this.handle?.editor;
          // The replacement dispatches a normal transaction, so `onDocChange`
          // fires and the autosave pipeline persists the rewritten link.
          if (editor !== undefined) replaceTextInEditor(editor, url, asset.relativePath);
        } catch {
          failed += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, urls.length) }, worker));
    // One summary instead of a toast per image: a paste can carry dozens, and
    // a kept remote link is a degradation, not a loss.
    if (failed > 0) {
      useStore.getState().pushToast(`${String(failed)} 张网络图片转存失败，已保留原链接`, 'error');
    }
  }

  /** `Cmd+S`: save immediately, and flow formatted text back if one is staged. */
  saveNow(): void {
    this.flushSave();
    this.maybeReflow('shortcut');
  }

  // ----------------------------------------------------------------- files →

  open(path: string): void {
    if (path === this.path) {
      this.syncUrl();
      return;
    }
    this.flushSave();
    this.maybeReflow('switch');
    this.resetDoc(path, true);
    this.send?.({ type: 'open', path });
  }

  create(path: string, kind: 'file' | 'dir'): void {
    if (kind === 'file') this.pendingOpen = path;
    this.send?.({ type: 'create', path, kind });
  }

  rename(from: string, to: string): void {
    if (from === to || to === '') return;
    this.flushSave();
    // The document keeps its content and its place in the editor; only its
    // name moves, and it moves before the daemon confirms so the UI does not
    // blink through "no such file".
    if (this.path === from) this.setPath(to, false);
    else if (this.path?.startsWith(`${from}/`) === true) {
      this.setPath(`${to}/${this.path.slice(from.length + 1)}`, false);
    }
    this.send?.({ type: 'rename', from, to });
  }

  remove(path: string): void {
    this.send?.({ type: 'delete', path });
    if (this.path === path || this.path?.startsWith(`${path}/`) === true) this.closeDoc();
  }

  search(query: string): void {
    this.send?.({ type: 'search', query });
  }

  // ------------------------------------------------------------- conflicts →

  useDisk(): void {
    const state = useStore.getState();
    const { conflict } = state;
    if (conflict === null || this.handle === null) return;
    this.handle.setState(conflict.diskContent);
    this.baseHash = conflict.diskHash;
    this.dirty = false;
    this.saveFailed = false;
    this.pending = null;
    state.setConflict(null);
    this.syncDirty();
    this.refreshToc();
  }

  keepMine(): void {
    const state = useStore.getState();
    const { conflict } = state;
    if (conflict === null || this.handle === null) return;
    const content = this.handle.getMarkdown();
    this.sentContent = content;
    this.saving = true;
    this.editedWhileSaving = false;
    state.setConflict(null);
    this.syncDirty();
    this.send?.({ type: 'force-save', path: conflict.path, content });
  }

  // ---------------------------------------------------------------- server →

  receive(msg: ServerMessage): void {
    switch (msg.type) {
      case 'workspace':
        this.onWorkspace(msg.root, msg.focus, msg.tree);
        return;
      case 'tree':
        this.onTree(msg.tree);
        return;
      case 'focus':
        this.open(msg.path);
        return;
      case 'file':
        if (msg.path !== this.path) return;
        this.applyLoad(msg);
        return;
      case 'saved':
        this.onSaved(msg);
        return;
      case 'external':
        this.onExternal(msg);
        return;
      case 'conflict':
        this.onConflict(msg);
        return;
      case 'settings':
        useStore.getState().setSettings(msg.settings);
        return;
      case 'search-results':
        // The daemon still answers `search`, but nothing in the UI asks for a
        // full-text search since the sidebar became a file-name filter.
        return;
      case 'error':
        this.onError(msg.message, msg.op);
        return;
    }
  }

  onDisconnect(): void {
    this.saving = false;
    this.clearTimer('saveTimer');
    this.syncDirty();
    useStore.getState().setConnected(false);
  }

  // -------------------------------------------------------------- internals

  private onWorkspace(root: string, focus: string | null, tree: TreeNode[]): void {
    const state = useStore.getState();
    const rootChanged = this.root !== null && this.root !== root;
    this.root = root;
    state.setWorkspace(root, tree);

    const action = decideWorkspace({
      rootChanged,
      urlFile: this.takeUrlFile(),
      focus,
      currentPath: this.path,
      dirty: this.dirty,
      exists: (path) => hasPath(tree, path),
    });

    // A switched workspace empties the editor first, so the previous root's
    // document is not left on screen while the next one loads.
    if (rootChanged) this.closeDoc();

    switch (action.kind) {
      case 'open':
        this.open(action.path);
        break;
      case 'resync':
        this.setPath(action.path, true);
        this.send?.({ type: 'open', path: action.path });
        break;
      case 'close':
        this.closeDoc();
        break;
      case 'none':
        // Nothing to show, so nothing for the URL to name either — this is
        // where a `?file=` the workspace does not contain gets dropped.
        this.syncUrl();
        break;
    }

    // This message is also the first thing a *reconnect* delivers, and the
    // socket may well have died with a debounced save still pending — the
    // daemon never heard about those edits and the editor is now the only
    // place they exist. Anything still dirty here goes out immediately.
    if (this.dirty) this.flushSave();
  }

  private takeUrlFile(): string | null {
    if (!this.urlPending) return null;
    this.urlPending = false;
    return this.route?.readFile() ?? null;
  }

  /** Pushes the open document into the URL; null clears the parameter. */
  private syncUrl(): void {
    this.route?.setFile(this.path);
  }

  /**
   * The single writer for "which document is open" — see the table on the
   * class. Every one of the names is set from here, in this order, because the
   * store update re-renders components that read the path back out of the
   * session.
   */
  private setPath(path: string | null, loading: boolean): void {
    this.path = path;
    useStore.getState().setDoc(path, loading);
    this.syncUrl();
  }

  private onTree(tree: TreeNode[]): void {
    const state = useStore.getState();
    state.setTree(tree);
    if (this.pendingOpen !== null && hasPath(tree, this.pendingOpen)) {
      const next = this.pendingOpen;
      this.pendingOpen = null;
      this.open(next);
      return;
    }
    if (this.path !== null && !hasPath(tree, this.path)) this.closeDoc();
  }

  private onError(message: string, op?: string): void {
    const state = useStore.getState();
    if (op === 'save' || op === 'force-save') {
      this.saving = false;
      // A refused write leaves the editor holding the only copy: the tree keeps
      // its marker until the document is saved or reloaded.
      this.saveFailed = true;
      this.syncDirty();
    }
    if (op === 'open') this.resetDoc(null);
    // The file was never made, so the tree will never announce it — without
    // this the session would open whatever file happens to appear next.
    if (op === 'create') this.pendingOpen = null;
    state.pushToast(op === undefined ? message : `${op}：${message}`, 'error');
  }

  private applyLoad(file: { path: string; content: string; hash: string }): void {
    if (this.handle === null) {
      this.queuedLoad = file;
      return;
    }
    this.path = file.path;
    this.baseHash = file.hash;
    this.dirty = false;
    this.saving = false;
    this.sentContent = null;
    this.editedWhileSaving = false;
    this.pending = null;
    this.saveFailed = false;
    this.clearTimer('idleTimer');
    this.clearTimer('saveTimer');
    this.syncDirty();
    this.handle.setState(file.content, 'start');
    this.releaseEditorFocus();
    useStore.getState().setConflict(null);
    this.setPath(file.path, false);
    this.refreshToc();
  }

  private onSaved(msg: { path: string; content: string; hash: string }): void {
    if (msg.path !== this.path) {
      this.saving = false;
      return;
    }
    const outcome = resolveSaved(
      {
        currentPath: this.path,
        sentContent: this.sentContent,
        editedWhileSaving: this.editedWhileSaving,
      },
      msg
    );
    this.saving = false;
    this.saveFailed = false;
    this.baseHash = outcome.baseHash;
    this.dirty = outcome.dirty;
    this.pending = outcome.pending;
    this.editedWhileSaving = false;
    this.syncDirty();

    if (outcome.resave) {
      this.flushSave();
      return;
    }
    if (this.pending !== null) this.scheduleIdleReflow();
  }

  private onExternal(msg: { path: string; content: string; hash: string }): void {
    if (this.handle === null) return;
    const action = classifyExternal(
      {
        currentPath: this.path,
        baseHash: this.baseHash,
        dirty: this.dirty,
        editorContent: this.handle.getMarkdown(),
      },
      msg
    );
    const state = useStore.getState();
    switch (action) {
      case 'ignore':
        return;
      case 'rebase':
        this.baseHash = msg.hash;
        return;
      case 'refresh':
        this.handle.setState(msg.content);
        this.baseHash = msg.hash;
        this.pending = null;
        this.clearTimer('idleTimer');
        this.refreshToc();
        return;
      case 'conflict':
        state.setConflict({
          path: msg.path,
          diskContent: msg.content,
          diskHash: msg.hash,
          mine: this.handle.getMarkdown(),
        });
        this.syncDirty();
        return;
    }
  }

  private onConflict(msg: { path: string; diskContent: string; diskHash: string }): void {
    this.saving = false;
    if (msg.path !== this.path || this.handle === null) return;
    const state = useStore.getState();
    state.setConflict({
      path: msg.path,
      diskContent: msg.diskContent,
      diskHash: msg.diskHash,
      mine: this.sentContent ?? this.handle.getMarkdown(),
    });
    this.syncDirty();
  }

  private closeDoc(): void {
    this.resetDoc(null);
    useStore.getState().setToc([]);
    this.handle?.setState('', 'start');
    this.releaseEditorFocus();
  }

  /**
   * Hands focus back after a document is swapped in.
   *
   * ProseMirror always has a selection, and meowdown reveals the markdown
   * syntax around it, so a freshly loaded document would otherwise open with
   * the first heading's `#`/`**` exposed. The selection stays at the start
   * (that is what scrolls the new document to the top), but with the editor
   * unfocused there is no caret and the `:focus-within` rule in `index.css`
   * keeps the syntax hidden until the reader clicks into the text.
   *
   * Only the load path calls this: an in-place reflow or a conflict
   * resolution must never steal focus away from someone who is typing.
   */
  private releaseEditorFocus(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('.md-editor-host') !== null) active.blur();
  }

  private resetDoc(path: string | null, loading = false): void {
    this.clearTimer('saveTimer');
    this.clearTimer('idleTimer');
    this.clearTimer('tocTimer');
    this.path = path;
    this.baseHash = '';
    this.dirty = false;
    this.saving = false;
    this.sentContent = null;
    this.editedWhileSaving = false;
    this.pending = null;
    this.saveFailed = false;
    this.queuedLoad = null;
    useStore.getState().setConflict(null);
    this.syncDirty();
    this.setPath(path, loading);
  }

  /** Whether the open document differs from what is on disk, right now. */
  private unsettled(): boolean {
    return (
      this.dirty || this.saving || this.saveFailed || useStore.getState().conflict !== null
    );
  }

  /**
   * Mirrors "the open document is not what is on disk" onto the store, which is
   * what paints the marker in the file tree.
   *
   * One editor means at most one such document at a time, so this is a single
   * path rather than a set.
   *
   * Raising the marker waits out {@link DIRTY_SETTLE} first. Under the debounced
   * autosave every keystroke would otherwise raise it and the next save clear
   * it again — a dot blinking on and off beside the file name while someone
   * types, and (worse) a full repaint of the tree rows behind it on each
   * change, since the tree exposes no cheaper way to redraw a decoration.
   * Waiting means only the states that actually persist ever paint.
   *
   * Two do not wait: a refused write and a conflict are both stuck until the
   * reader does something, and both are worth saying immediately. Clearing
   * never waits either.
   */
  private syncDirty(): void {
    const state = useStore.getState();
    const urgent = this.saveFailed || state.conflict !== null;
    const next = this.unsettled() ? this.path : null;

    if (next === null || urgent) {
      this.clearTimer('dirtyTimer');
      if (state.dirtyPath !== next) state.setDirtyPath(next);
      return;
    }
    if (state.dirtyPath === next) {
      this.clearTimer('dirtyTimer');
      return;
    }
    if (this.dirtyTimer !== null) return;
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = null;
      const current = useStore.getState();
      const path = this.unsettled() ? this.path : null;
      if (current.dirtyPath !== path) current.setDirtyPath(path);
    }, DIRTY_SETTLE);
  }

  private scheduleSave(): void {
    this.clearTimer('saveTimer');
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flushSave();
    }, useStore.getState().settings.saveDebounceMs);
  }

  private flushSave(): void {
    this.clearTimer('saveTimer');
    if (this.handle === null || this.path === null || !this.dirty) return;
    if (useStore.getState().conflict !== null) return;
    if (this.saving) {
      this.editedWhileSaving = true;
      return;
    }
    const content = this.handle.getMarkdown();
    this.sentContent = content;
    this.editedWhileSaving = false;
    this.saving = true;
    this.send?.({ type: 'save', path: this.path, content, baseHash: this.baseHash });
  }

  private scheduleIdleReflow(): void {
    this.clearTimer('idleTimer');
    const delay = Math.max(0, IDLE_REFLOW - (Date.now() - this.lastEditAt));
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.maybeReflow('idle');
    }, delay);
  }

  /** Flows staged formatted text back in, restoring the caret where possible. */
  private maybeReflow(_reason: ReflowReason): void {
    if (this.handle === null || this.pending === null) return;
    const editorContent = this.handle.getMarkdown();
    const ready = shouldReflow({
      pending: this.pending,
      currentPath: this.path,
      dirty: this.dirty,
      saving: this.saving,
      editorContent,
    });
    if (!ready) return;

    const pending = this.pending;
    // No selection is passed on purpose: `setState` then maps the current one
    // through the replacement instead of re-resolving a pre-format offset —
    // formatting shifts every position after its first change, so an explicit
    // selection lands the caret somewhere else and `scrollIntoView` yanks the
    // page there with it.
    this.handle.setState(pending.content);
    this.baseHash = pending.hash;
    this.pending = null;
    this.clearTimer('idleTimer');
    this.refreshToc();
  }

  private scheduleToc(): void {
    this.clearTimer('tocTimer');
    this.tocTimer = setTimeout(() => {
      this.tocTimer = null;
      this.refreshToc();
    }, TOC_DEBOUNCE);
  }

  private refreshToc(): void {
    if (this.handle === null) return;
    const toc = extractToc(this.handle.getMarkdown());
    const state = useStore.getState();
    if (!sameToc(state.toc, toc)) state.setToc(toc);
  }

  private clearTimer(name: TimerName): void {
    const timer = this[name];
    if (timer !== null) {
      clearTimeout(timer);
      this[name] = null;
    }
  }
}

export const session = new Session();
