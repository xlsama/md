import type { ClientMessage, ServerMessage, TreeNode } from 'mdopen/protocol';
import type { EditorHandle } from '@meowdown/react';
import { extractToc, sameToc } from './lib/toc.ts';
import { hasPath } from './lib/tree.ts';
import {
  classifyExternal,
  resolveSaved,
  shouldReflow,
  type PendingFormatted,
  type ReflowReason,
} from './lib/sync.ts';
import { useStore } from './store.ts';

const SAVE_DEBOUNCE = 500;
const IDLE_REFLOW = 2000;
const TOC_DEBOUNCE = 400;

type Send = (msg: ClientMessage) => void;
type TimerName = 'saveTimer' | 'idleTimer' | 'tocTimer';

/**
 * The imperative bridge between the WebSocket protocol and the (uncontrolled)
 * meowdown editor. All the ordering-sensitive rules from DESIGN.md live here;
 * the decisions themselves are pure functions in `lib/sync.ts`.
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

  private root: string | null = null;
  private path: string | null = null;
  private baseHash = '';
  private dirty = false;
  private saving = false;
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
    useStore.getState().setSaveState('dirty');
    this.scheduleSave();
    this.scheduleToc();
  }

  onBlur(): void {
    this.maybeReflow('blur');
  }

  /** `Cmd+S`: save immediately, and flow formatted text back if one is staged. */
  saveNow(): void {
    this.flushSave();
    this.maybeReflow('shortcut');
  }

  // ----------------------------------------------------------------- files →

  open(path: string): void {
    if (path === this.path) return;
    this.flushSave();
    this.maybeReflow('switch');
    this.resetDoc(path);
    useStore.getState().setDoc(path, true);
    this.send?.({ type: 'open', path });
  }

  create(path: string, kind: 'file' | 'dir'): void {
    if (kind === 'file') this.pendingOpen = path;
    this.send?.({ type: 'create', path, kind });
  }

  rename(from: string, to: string): void {
    if (from === to || to === '') return;
    this.flushSave();
    if (this.path === from) {
      this.path = to;
      useStore.getState().setDoc(to, false);
    } else if (this.path?.startsWith(`${from}/`) === true) {
      this.path = `${to}/${this.path.slice(from.length + 1)}`;
      useStore.getState().setDoc(this.path, false);
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
    this.pending = null;
    state.setConflict(null);
    state.setSaveState('saved');
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
    state.setSaveState('saving');
    this.send?.({ type: 'force-save', path: conflict.path, content });
  }

  // ---------------------------------------------------------------- server →

  receive(msg: ServerMessage): void {
    const state = useStore.getState();
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
      case 'search-results':
        state.setSearchResults(msg.query, msg.results);
        return;
      case 'error':
        this.onError(msg.message, msg.op);
        return;
    }
  }

  onDisconnect(): void {
    this.saving = false;
    this.clearTimer('saveTimer');
    useStore.getState().setConnected(false);
  }

  // -------------------------------------------------------------- internals

  private onWorkspace(root: string, focus: string | null, tree: TreeNode[]): void {
    const state = useStore.getState();
    const rootChanged = this.root !== root;
    this.root = root;
    state.setWorkspace(root, tree);
    state.setSearchResults(state.searchQuery, []);

    if (rootChanged) this.closeDoc();

    if (focus !== null && focus !== '') {
      this.open(focus);
      return;
    }
    // Same workspace, fresh connection (reconnect): resync the open document,
    // unless local edits would be clobbered.
    if (this.path !== null && !this.dirty) {
      const path = this.path;
      state.setDoc(path, true);
      this.send?.({ type: 'open', path });
    }
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
      state.setSaveState('error');
    }
    if (op === 'search') state.setSearching(false);
    if (op === 'open') {
      this.resetDoc(null);
      state.setDoc(null, false);
    }
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
    this.clearTimer('idleTimer');
    this.clearTimer('saveTimer');
    this.handle.setState(file.content, 'start');
    const state = useStore.getState();
    state.setDoc(file.path, false);
    state.setSaveState('idle');
    state.setConflict(null);
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
    this.baseHash = outcome.baseHash;
    this.dirty = outcome.dirty;
    this.pending = outcome.pending;
    this.editedWhileSaving = false;

    if (outcome.resave) {
      this.flushSave();
      return;
    }
    useStore.getState().setSaveState('saved');
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
        state.setSaveState('saved');
        this.refreshToc();
        return;
      case 'conflict':
        state.setConflict({
          path: msg.path,
          diskContent: msg.content,
          diskHash: msg.hash,
          mine: this.handle.getMarkdown(),
        });
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
    state.setSaveState('dirty');
  }

  private closeDoc(): void {
    this.resetDoc(null);
    const state = useStore.getState();
    state.setDoc(null, false);
    state.setToc([]);
    state.setSaveState('idle');
    this.handle?.setState('', 'start');
  }

  private resetDoc(path: string | null): void {
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
    this.queuedLoad = null;
    useStore.getState().setConflict(null);
  }

  private scheduleSave(): void {
    this.clearTimer('saveTimer');
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flushSave();
    }, SAVE_DEBOUNCE);
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
    useStore.getState().setSaveState('saving');
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
    const selection = this.handle.getSelection();
    // `setState` clamps an out-of-range selection instead of throwing, so a
    // formatting pass that shortened the document still lands a sane caret.
    this.handle.setState(pending.content, selection);
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
