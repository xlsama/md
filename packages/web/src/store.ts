import type { SearchHit, TreeNode } from 'mdopen/protocol';
import type { EditorMode } from '@meowdown/react';
import { create } from 'zustand';
import { markdownFiles, toTreePaths } from './lib/tree.ts';
import type { TocEntry } from './lib/toc.ts';

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
  | { kind: 'create'; entry: 'file' | 'dir'; parent: string }
  | { kind: 'rename'; path: string; isDir: boolean }
  | { kind: 'delete'; path: string; isDir: boolean };

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

const MODE_KEY = 'md:mode';
const TOC_KEY = 'md:toc-open';

function readMode(): EditorMode {
  const stored = localStorage.getItem(MODE_KEY);
  return stored === 'focus' || stored === 'show' || stored === 'hide' ? stored : 'focus';
}

interface State {
  connected: boolean;
  root: string;
  tree: TreeNode[];
  treePaths: string[];
  mdFiles: string[];
  /** Path shown in the editor, or null when nothing is open. */
  docPath: string | null;
  docLoading: boolean;
  saveState: SaveState;
  conflict: ConflictState | null;
  toc: TocEntry[];
  tocOpen: boolean;
  mode: EditorMode;
  ripgrep: boolean;
  searchQuery: string;
  searchResults: SearchHit[];
  searching: boolean;
  /** Query handed to the editor's find highlighting after a search jump. */
  editorQuery: string;
  toasts: Toast[];
  dialog: Dialog | null;

  setConnected: (connected: boolean) => void;
  setWorkspace: (root: string, tree: TreeNode[]) => void;
  setTree: (tree: TreeNode[]) => void;
  setDoc: (path: string | null, loading: boolean) => void;
  setSaveState: (state: SaveState) => void;
  setConflict: (conflict: ConflictState | null) => void;
  setToc: (toc: TocEntry[]) => void;
  toggleToc: () => void;
  setMode: (mode: EditorMode) => void;
  setRipgrep: (ok: boolean) => void;
  setSearchQuery: (query: string) => void;
  setSearchResults: (query: string, results: SearchHit[]) => void;
  setSearching: (searching: boolean) => void;
  setEditorQuery: (query: string) => void;
  pushToast: (message: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
  setDialog: (dialog: Dialog | null) => void;
}

let toastId = 0;

export const useStore = create<State>()((set) => ({
  connected: false,
  root: '',
  tree: [],
  treePaths: [],
  mdFiles: [],
  docPath: null,
  docLoading: false,
  saveState: 'idle',
  conflict: null,
  toc: [],
  tocOpen: localStorage.getItem(TOC_KEY) !== '0',
  mode: readMode(),
  ripgrep: true,
  searchQuery: '',
  searchResults: [],
  searching: false,
  editorQuery: '',
  toasts: [],
  dialog: null,

  setConnected: (connected) => set({ connected }),
  setWorkspace: (root, tree) =>
    set({ root, tree, treePaths: toTreePaths(tree), mdFiles: markdownFiles(tree) }),
  setTree: (tree) => set({ tree, treePaths: toTreePaths(tree), mdFiles: markdownFiles(tree) }),
  setDoc: (docPath, docLoading) => set({ docPath, docLoading }),
  setSaveState: (saveState) => set({ saveState }),
  setConflict: (conflict) => set({ conflict }),
  setToc: (toc) => set({ toc }),
  toggleToc: () =>
    set((state) => {
      const tocOpen = !state.tocOpen;
      localStorage.setItem(TOC_KEY, tocOpen ? '1' : '0');
      return { tocOpen };
    }),
  setMode: (mode) => {
    localStorage.setItem(MODE_KEY, mode);
    set({ mode });
  },
  setRipgrep: (ripgrep) => set({ ripgrep }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSearchResults: (query, results) =>
    set((state) => (state.searchQuery === query ? { searchResults: results, searching: false } : {})),
  setSearching: (searching) => set({ searching }),
  setEditorQuery: (editorQuery) => set({ editorQuery }),
  pushToast: (message, kind = 'info') =>
    set((state) => ({ toasts: [...state.toasts, { id: ++toastId, message, kind }] })),
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  setDialog: (dialog) => set({ dialog }),
}));

export const store = useStore;
