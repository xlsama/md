import type { Settings, SettingsPatch, TreeNode } from 'mdopen/protocol';
import { create } from 'zustand';
import { saveSettings } from './api.ts';
import { markdownFiles, toTreePaths } from './lib/tree.ts';
import type { TocEntry } from './lib/toc.ts';
import { readCachedSettings } from './lib/settings.ts';
import { applyTheme } from './lib/theme.ts';
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
  readOnly: boolean;
  toasts: Toast[];
  dialog: Dialog | null;
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
  toggleReadOnly: () => void;
  pushToast: (message: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
  setDialog: (dialog: Dialog | null) => void;
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
  readOnly: localStorage.getItem(READ_ONLY_KEY) === '1',
  toasts: [],
  dialog: null,
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
