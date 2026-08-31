import type { Settings, SettingsPatch, TreeNode } from '@xlsama/md/protocol';
import { create } from 'zustand';
import { saveSettings } from './api.ts';
import { stepIndex } from './lib/image-preview.ts';
import { markdownFiles, toTreePaths } from './lib/tree.ts';
import type { TocEntry } from './lib/toc.ts';
import { readCachedSettings } from './lib/settings.ts';
import { applyTheme } from './lib/theme.ts';
import { SIDEBAR_NARROW_QUERY } from './lib/sidebar.ts';
import {
  manualPref,
  readTocPref,
  tocPrefValue,
  TOC_WIDE_QUERY,
  type TocPref,
} from './lib/toc-panel.ts';

export interface ConflictState {
  path: string;
  /** Raw content currently on disk. */
  diskContent: string;
  diskHash: string;
  /** Content in the editor when the conflict was detected. */
  mine: string;
}

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
}

export type Dialog =
  | { kind: 'rename'; path: string; isDir: boolean }
  | { kind: 'delete'; path: string; isDir: boolean };

/** One picture the lightbox can show, already resolved to a loadable URL. */
export interface PreviewImage {
  src: string;
  alt: string;
}

/**
 * The open lightbox.
 *
 * The whole document's pictures travel together rather than just the one that
 * was clicked, so `←` / `→` can walk them without reaching back into the
 * editor's DOM a second time.
 */
export interface PreviewState {
  images: PreviewImage[];
  index: number;
}

const TOC_KEY = 'md:toc-open';
const READ_ONLY_KEY = 'md:read-only';
export const SETTINGS_KEY = 'md:settings';

interface State {
  connected: boolean;
  root: string;
  /**
   * The daemon's tree, kept only in the two derived shapes anything reads: the
   * flat path list the tree component consumes, and the markdown files the
   * wikilink and filter lookups walk. The nested `TreeNode[]` itself is handed
   * to `session`, which is where the tree-shaped questions are asked.
   */
  treePaths: string[];
  mdFiles: string[];
  /** Path shown in the editor, or null when nothing is open. */
  docPath: string | null;
  docLoading: boolean;
  conflict: ConflictState | null;
  toc: TocEntry[];
  /** Auto (viewport-driven) or the open state the user last chose. */
  tocPref: TocPref;
  /** Whether the viewport is wide enough to dock the outline. */
  tocWide: boolean;
  /** Whether the window is too narrow to give the file tree its own column. */
  sidebarNarrow: boolean;
  /** Whether the reader has re-opened the tree despite that. */
  sidebarOverride: boolean;
  readOnly: boolean;
  toasts: Toast[];
  dialog: Dialog | null;
  /** The image lightbox, or null when it is closed. */
  preview: PreviewState | null;
  /** The daemon's settings, mirrored locally so the first frame is themed. */
  settings: Settings;
  settingsOpen: boolean;
  /**
   * The one document whose state is not on disk — unsaved, saving, failed, or
   * waiting on a conflict. A single editor can only ever have one.
   */
  dirtyPath: string | null;

  setConnected: (connected: boolean) => void;
  setWorkspace: (root: string, tree: TreeNode[]) => void;
  setTree: (tree: TreeNode[]) => void;
  setDoc: (path: string | null, loading: boolean) => void;
  setConflict: (conflict: ConflictState | null) => void;
  setToc: (toc: TocEntry[]) => void;
  setTocOpen: (open: boolean) => void;
  setTocWide: (wide: boolean) => void;
  setSidebarNarrow: (narrow: boolean) => void;
  setSidebarOverride: (override: boolean) => void;
  toggleReadOnly: () => void;
  pushToast: (message: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
  setDialog: (dialog: Dialog | null) => void;
  openPreview: (images: PreviewImage[], index: number) => void;
  closePreview: () => void;
  stepPreview: (delta: number) => void;
  setSettings: (settings: Settings) => void;
  setSettingsOpen: (open: boolean) => void;
  setDirtyPath: (path: string | null) => void;
}

let toastId = 0;

const initialSettings = readCachedSettings(localStorage.getItem(SETTINGS_KEY));

export const useStore = create<State>()((set) => ({
  connected: false,
  root: '',
  treePaths: [],
  mdFiles: [],
  docPath: null,
  docLoading: false,
  conflict: null,
  toc: [],
  tocPref: readTocPref(localStorage.getItem(TOC_KEY)),
  tocWide: window.matchMedia(TOC_WIDE_QUERY).matches,
  sidebarNarrow: window.matchMedia(SIDEBAR_NARROW_QUERY).matches,
  sidebarOverride: false,
  readOnly: localStorage.getItem(READ_ONLY_KEY) === '1',
  toasts: [],
  dialog: null,
  preview: null,
  settings: initialSettings,
  settingsOpen: false,
  dirtyPath: null,

  setConnected: (connected) => set({ connected }),
  setWorkspace: (root, tree) =>
    set({ root, treePaths: toTreePaths(tree), mdFiles: markdownFiles(tree) }),
  setTree: (tree) => set({ treePaths: toTreePaths(tree), mdFiles: markdownFiles(tree) }),
  setDoc: (docPath, docLoading) => set({ docPath, docLoading }),
  setConflict: (conflict) => set({ conflict }),
  setToc: (toc) => set({ toc }),
  setTocOpen: (open) => {
    const tocPref = manualPref(open);
    const value = tocPrefValue(tocPref);
    if (value !== null) localStorage.setItem(TOC_KEY, value);
    set({ tocPref });
  },
  setTocWide: (tocWide) => set({ tocWide }),
  // Crossing the breakpoint is a fresh question, so the previous answer to it
  // goes with the crossing: the tree folds away again on the next narrow window.
  setSidebarNarrow: (sidebarNarrow) => set({ sidebarNarrow, sidebarOverride: false }),
  setSidebarOverride: (sidebarOverride) => set({ sidebarOverride }),
  toggleReadOnly: () =>
    set((state) => {
      const readOnly = !state.readOnly;
      localStorage.setItem(READ_ONLY_KEY, readOnly ? '1' : '0');
      return { readOnly };
    }),
  pushToast: (message, kind = 'info') =>
    set((state) => ({ toasts: [...state.toasts, { id: ++toastId, message, kind }] })),
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  setDialog: (dialog) => set({ dialog }),
  openPreview: (images, index) =>
    set({ preview: images.length === 0 ? null : { images, index } }),
  closePreview: () => set({ preview: null }),
  // Wrapping is `stepIndex`'s job; the store only refuses to step a lightbox
  // that is no longer open.
  stepPreview: (delta) =>
    set((state) =>
      state.preview === null
        ? {}
        : {
            preview: {
              images: state.preview.images,
              index: stepIndex(state.preview.index, delta, state.preview.images.length),
            },
          }
    ),
  // The daemon owns the settings; this is the single point where a new version
  // of them lands, so the theme and the first-paint mirror are updated here
  // rather than in every caller.
  setSettings: (settings) => {
    applyTheme(settings.theme);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // A full or disabled storage only costs us the un-flashed first paint.
    }
    set({ settings });
  },
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setDirtyPath: (dirtyPath) => set({ dirtyPath }),
}));

/**
 * A settings change made by a control rather than by the settings dialog — the
 * theme toggle and the sidebar switch.
 *
 * It is applied locally first so the control answers immediately, then written
 * through; the daemon's broadcast lands on top of it (and reaches the other
 * open tabs, which is why both stay in step).
 */
export function writeSettings(patch: SettingsPatch): void {
  const state = useStore.getState();
  state.setSettings({
    ...state.settings,
    ...patch,
    format: { ...state.settings.format, ...patch.format },
  });
  void saveSettings(patch).catch((err: unknown) => {
    useStore.getState().pushToast(err instanceof Error ? err.message : '设置保存失败', 'error');
  });
}
