/**
 * Pure decision logic for the save / format-reflow / external-change state
 * machine described in DESIGN.md («同步与冲突模型» + «格式化空闲回灌»).
 *
 * Keeping it free of React and of the editor handle makes the tricky parts
 * unit-testable; `session.ts` is the imperative shell that calls into it.
 */

export interface PendingFormatted {
  path: string;
  content: string;
  hash: string;
}

export type ReflowReason = 'idle' | 'shortcut' | 'switch' | 'blur';

export interface ReflowState {
  /** Formatted full text the daemon echoed back, waiting to be flowed in. */
  pending: PendingFormatted | null;
  /** Path currently loaded in the editor. */
  currentPath: string | null;
  /** The editor has edits that have not been acknowledged yet. */
  dirty: boolean;
  /** A save is in flight; its `saved` reply would invalidate `pending`. */
  saving: boolean;
  /** Current editor markdown. */
  editorContent: string;
}

/**
 * Whether the formatted text may be flowed back into the editor right now.
 *
 * Reflowing replaces the whole document, so it is only ever safe when the user
 * is not mid-edit: any `onDocChange` after the save that produced `pending`
 * drops it (see `session.ts`), and a save in flight will produce a newer one.
 */
export function shouldReflow(state: ReflowState): boolean {
  const { pending } = state;
  if (pending === null) return false;
  if (state.currentPath === null || pending.path !== state.currentPath) return false;
  if (state.dirty || state.saving) return false;
  return pending.content !== state.editorContent;
}

export interface SavedState {
  /** Path the editor is showing right now. */
  currentPath: string | null;
  /** Content that was handed to the daemon in the `save` message. */
  sentContent: string | null;
  /** Whether the document changed while the save was in flight. */
  editedWhileSaving: boolean;
}

export interface SavedOutcome {
  /** New base hash to compare future disk states against. */
  baseHash: string;
  /** Whether the editor should still be considered dirty. */
  dirty: boolean;
  /** Formatted text to stage for reflow, if the daemon rewrote our content. */
  pending: PendingFormatted | null;
  /** Whether another save must be sent for the edits made during the flight. */
  resave: boolean;
}

/**
 * Folds a `saved` acknowledgement into the session state.
 *
 * `saved.content` is the *formatted* file, which usually differs from what we
 * sent — it must never be pushed into the editor here (that would interrupt
 * typing); it is staged as `pending` and flowed in while idle instead.
 */
export function resolveSaved(
  state: SavedState,
  saved: { path: string; content: string; hash: string }
): SavedOutcome {
  const stale = saved.path !== state.currentPath;
  if (stale || state.editedWhileSaving) {
    return {
      baseHash: saved.hash,
      dirty: state.editedWhileSaving && !stale,
      pending: null,
      resave: state.editedWhileSaving && !stale,
    };
  }
  const changed = saved.content !== state.sentContent;
  return {
    baseHash: saved.hash,
    dirty: false,
    pending: changed ? { path: saved.path, content: saved.content, hash: saved.hash } : null,
    resave: false,
  };
}

export type ExternalAction =
  /** Not our document, or a change we already have — nothing to do. */
  | 'ignore'
  /** Same text, new hash: silently adopt the disk hash as the new base. */
  | 'rebase'
  /** Clean editor: push the disk content straight in. */
  | 'refresh'
  /** Dirty editor: hand it to the conflict banner. */
  | 'conflict';

export interface ExternalState {
  currentPath: string | null;
  baseHash: string;
  dirty: boolean;
  editorContent: string;
}

/**
 * Decides what an `external` (or a `saved` echoed to another tab) means for
 * the editor. `external` content is always raw disk content — the daemon never
 * formats writes it did not make.
 */
export function classifyExternal(
  state: ExternalState,
  msg: { path: string; content: string; hash: string }
): ExternalAction {
  if (state.currentPath === null || msg.path !== state.currentPath) return 'ignore';
  if (msg.hash === state.baseHash) return 'ignore';
  if (msg.content === state.editorContent) return 'rebase';
  return state.dirty ? 'conflict' : 'refresh';
}
