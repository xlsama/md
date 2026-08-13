import type {
  ContextMenuItem,
  ContextMenuOpenContext,
  FileTreeDirectoryHandle,
  FileTree as FileTreeModel,
  FileTreeItemHandle,
} from '@pierre/trees';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '@xlsama/md/protocol';
import { basename, dirname, isMarkdown, withMarkdownExtension } from '../lib/paths.ts';
import {
  dragSidebar,
  sidebarShown,
  SIDEBAR_NARROW_QUERY,
  type SidebarDrag,
} from '../lib/sidebar.ts';
import { toggledTheme } from '../lib/theme.ts';
import { diffTreePaths } from '../lib/tree.ts';
import {
  FILTER_LIMIT,
  filterTreePaths,
  highlightSegments,
  type FileMatch,
} from '../lib/tree-filter.ts';
import { session } from '../session.ts';
import { useStore, writeSettings } from '../store.ts';
import { Icon } from './icon.tsx';
import { IconButton } from './icon-button.tsx';
import { MenuItem, MenuSeparator, MenuSurface, useDismiss } from './menu.tsx';
import { useMediaQuery } from './use-media-query.ts';
import { useSystemTheme } from './use-system-theme.ts';

/**
 * The tree holds `.md` files only, so a per-row file glyph is pure noise.
 * `icons: { set: 'none' }` drops the built-in file-type icon set; the generic
 * fallback glyph that remains is hidden through the tree's own `unsafeCSS`
 * option, since the rows live inside a shadow root our stylesheet cannot reach.
 * The icon lane keeps its width, so file names stay aligned with folder names.
 */
const HIDE_FILE_ICONS =
  '[data-item-type="file"] [data-item-section="icon"] > svg { display: none; }';

/**
 * The built-in chevron is drawn at the icon lane's full 16px, which reads as a
 * heavy arrow next to 12px row labels. Shrinking the glyph alone would park it
 * against the left edge of its lane, so the lane centers its contents too.
 */
const SMALL_CHEVRON = `
[data-icon-name="file-tree-icon-chevron"] { width: 12px; height: 12px; }
[data-item-type="folder"] > [data-item-section="icon"] { align-items: center; justify-content: center; }
`;

/**
 * The unsaved-changes marker. `renderRowDecoration` can only hand back text or
 * one of the tree's own icons, so the dot is drawn from the decoration span
 * itself: the glyph is collapsed to nothing and a pseudo-element takes its
 * place, which is the only way to get an exact 6px circle in there.
 */
const DIRTY_DOT = `
[data-item-section="decoration"] span { display: flex; align-items: center; font-size: 0; }
[data-item-section="decoration"] span::after {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: var(--md-dirty);
}
`;

const TREE_CSS = `${HIDE_FILE_ICONS}\n${SMALL_CHEVRON}\n${DIRTY_DOT}`;

/** Stable across renders: it doubles as the tree's repaint handle (see below). */
const TREE_ICONS = { set: 'none' } as const;

/**
 * The panel's edge: a drag handle wide enough to hit, drawn as the 1px line
 * that was already there.
 *
 * Only the colour changes — on hover, and for as long as a drag lasts — so the
 * layout never twitches under the pointer. The handle sits inside the panel
 * rather than straddling its border, because the panel clips its own overflow
 * while collapsing.
 */
/** Leftwards is outwards — and so widening — once the interface is mirrored. */
function dragDirection(dx: number): number {
  return document.dir === 'rtl' ? -dx : dx;
}

function SidebarResizer({
  width,
  dragging,
  onStart,
  onNudge,
}: {
  width: number;
  dragging: boolean;
  onStart: (x: number) => void;
  onNudge: (step: number) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="调整文件树宽度"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        // Otherwise the press starts a text selection in the tree behind it.
        event.preventDefault();
        onStart(event.clientX);
      }}
      // The same edge for keyboards, in steps rather than pixels. A step that
      // would take it past the minimum stops there; closing the panel is what
      // the toolbar's own toggle is for.
      onKeyDown={(event) => {
        const step = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0;
        if (step === 0) return;
        event.preventDefault();
        onNudge(dragDirection(step));
      }}
      className="group absolute inset-y-0 end-0 z-10 w-1.5 cursor-col-resize"
    >
      <div
        className={`absolute inset-y-0 end-0 w-px transition-colors ${
          dragging ? 'bg-[var(--md-accent)]' : 'bg-transparent group-hover:bg-[var(--md-accent)]'
        }`}
      />
    </div>
  );
}

/**
 * The drag itself: live width while the pointer is down, committed on release.
 *
 * The pointer is tracked on the window rather than on the handle, which spends
 * most of a drag nowhere near the pointer and is not even on screen once the
 * drag has pulled the panel shut. That also takes the cursor and the text
 * selection off every element the pointer crosses on the way.
 */
function useSidebarDrag(width: number, commit: (drag: SidebarDrag) => void) {
  const [origin, setOrigin] = useState<{ x: number; width: number } | null>(null);
  const [drag, setDrag] = useState<SidebarDrag | null>(null);
  /** The last position handed to `setDrag`, readable from the release handler. */
  const latest = useRef<SidebarDrag | null>(null);

  const start = useCallback(
    (x: number) => {
      setOrigin({ x, width });
    },
    [width]
  );

  useEffect(() => {
    if (origin === null) return undefined;

    const move = (event: PointerEvent) => {
      const next = dragSidebar(origin.width, dragDirection(event.clientX - origin.x));
      latest.current = next;
      setDrag(next);
    };
    const end = () => {
      const final = latest.current;
      latest.current = null;
      setOrigin(null);
      setDrag(null);
      if (final !== null) commit(final);
    };

    const { style } = document.body;
    const cursor = style.cursor;
    const select = style.userSelect;
    style.cursor = 'col-resize';
    style.userSelect = 'none';

    // An embed is its own document: pointer events over an iframe go to it,
    // not to this window, so the drag would go dead — and never see its
    // release — the moment the pointer crossed one.
    const frames = Array.from(document.querySelectorAll('iframe'));
    const shields = frames.map((frame) => frame.style.pointerEvents);
    for (const frame of frames) frame.style.pointerEvents = 'none';

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      frames.forEach((frame, i) => {
        frame.style.pointerEvents = shields[i] ?? '';
      });
      style.cursor = cursor;
      style.userSelect = select;
    };
  }, [origin, commit]);

  return { drag, dragging: origin !== null, start };
}

/** Whether the file tree is on screen — the toolbar toggle reads it too. */
export function useSidebarShown(): boolean {
  const open = useStore((s) => s.settings.sidebarOpen);
  const narrow = useStore((s) => s.sidebarNarrow);
  const override = useStore((s) => s.sidebarOverride);
  return sidebarShown(open, narrow, override);
}

/** Canonical tree paths keep a trailing slash on directories; the daemon does not. */
function toServerPath(path: string): string {
  return path.replace(/\/+$/, '');
}

/** Canonical tree paths keep a trailing slash on directories. */
function toTreePath(path: string, isDir: boolean): string {
  return isDir ? `${toServerPath(path)}/` : path;
}

function childPath(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

type NewEntry = 'file' | 'dir';

function ContextMenu({
  item,
  context,
  onCreate,
}: {
  item: ContextMenuItem;
  context: ContextMenuOpenContext;
  onCreate: (parent: string, entry: NewEntry) => void;
}) {
  const setDialog = useStore((s) => s.setDialog);
  const path = toServerPath(item.path);
  const isDir = item.kind === 'directory';
  const parent = isDir ? path : dirname(path);

  const run = (fn: () => void) => () => {
    context.close({ restoreFocus: false });
    fn();
  };

  return (
    <MenuSurface>
      <MenuItem
        icon="file-plus"
        label="新建文件"
        onClick={run(() => {
          onCreate(parent, 'file');
        })}
      />
      <MenuItem
        icon="folder-plus"
        label="新建文件夹"
        onClick={run(() => {
          onCreate(parent, 'dir');
        })}
      />
      <MenuSeparator />
      <MenuItem
        icon="pencil"
        label="重命名"
        onClick={run(() => {
          setDialog({ kind: 'rename', path, isDir });
        })}
      />
      <MenuItem
        icon="trash"
        label="移到废纸篓"
        danger
        onClick={run(() => {
          setDialog({ kind: 'delete', path, isDir });
        })}
      />
    </MenuSurface>
  );
}

/** Grace period before a hover-opened menu closes, so crossing the gap is safe. */
const MENU_CLOSE_DELAY = 150;

function NewEntryMenu({ onCreate }: { onCreate: (parent: string, entry: NewEntry) => void }) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current === null) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  const close = useCallback(() => {
    cancelClose();
    setOpen(false);
  }, [cancelClose]);

  const ref = useDismiss(open, close);

  useEffect(() => cancelClose, [cancelClose]);

  const openNow = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);

  // The button and the menu share one hover region, and leaving it only starts
  // a timer — a pointer cutting the corner between the two does not lose it.
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, MENU_CLOSE_DELAY);
  }, [cancelClose]);

  const create = (entry: NewEntry) => () => {
    close();
    // The header button belongs to the tree as a whole, so it always builds at
    // the workspace root; the context menu is what targets a folder.
    onCreate('', entry);
  };

  return (
    <div ref={ref} className="relative" onPointerEnter={openNow} onPointerLeave={scheduleClose}>
      <button
        type="button"
        title="新建"
        aria-label="新建"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
        className={`flex cursor-pointer items-center rounded-md p-1 transition-colors hover:bg-[var(--md-hover)] hover:text-[var(--md-fg)] ${
          open ? 'bg-[var(--md-hover)] text-[var(--md-fg)]' : 'text-[var(--md-muted)]'
        }`}
      >
        <Icon name="plus" className="size-4" />
      </button>

      {open && (
        <MenuSurface className="absolute end-0 top-full z-40 mt-1.5">
          <MenuItem icon="file-plus" label="新建文件" onClick={create('file')} />
          <MenuItem icon="folder-plus" label="新建文件夹" onClick={create('dir')} />
        </MenuSurface>
      )}
    </div>
  );
}

/**
 * Resolves a row handle to its directory branch. `isDirectory()` is typed per
 * branch, but a method call is not a narrowing position — probing for a
 * method only directories have narrows the union without an assertion.
 */
function asDirectory(item: FileTreeItemHandle | null): FileTreeDirectoryHandle | null {
  return item !== null && 'expand' in item ? item : null;
}

/**
 * Whether the tree is currently showing its inline editor.
 *
 * There is no public flag for it, and the rows live in a shadow root, so the
 * input element itself is the signal. It is needed because the tree stays quiet
 * in exactly one case — the user accepts the pre-filled name unchanged, which
 * makes source and destination equal and skips `onRename` entirely — and a
 * placeholder row left behind after that would name a file that does not exist.
 */
function renamingNow(model: FileTreeModel): boolean {
  const container = model.getFileTreeContainer();
  if (container === undefined) return false;
  // The container is the custom element when the tree owns its shadow root, and
  // a plain element inside it otherwise; searching from whichever we get covers
  // both without depending on which one the version at hand hands back.
  const scope: ParentNode = container.shadowRoot ?? container;
  return scope.querySelector('[data-item-rename-input]') !== null;
}

/**
 * The two controls that belong to the app rather than to the tree. They sit at
 * the very bottom of the sidebar, so their tooltips open upwards — a tooltip
 * below a button on the last row of the window would fall off the screen.
 */
function SidebarFooter() {
  const theme = useStore((s) => s.settings.theme);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const system = useSystemTheme();
  // A reader on `system` starts from the scheme they are looking at.
  const next = toggledTheme(theme, system);

  return (
    <div className="flex shrink-0 items-center gap-1 border-t border-[var(--md-border)] px-2 py-1.5">
      <IconButton
        icon={next === 'dark' ? 'moon' : 'sun'}
        label={next === 'dark' ? '切换到暗色' : '切换到亮色'}
        placement="top"
        onClick={() => {
          writeSettings({ theme: next });
        }}
      />
      <IconButton
        icon="settings"
        label="设置"
        placement="top"
        onClick={() => {
          setSettingsOpen(true);
        }}
      />
    </div>
  );
}

/** The tree paints its selected row with this; the result list borrows it. */
const MATCH_ACTIVE_BG = 'color-mix(in oklab, var(--md-accent) 18%, transparent)';

/**
 * One hit in the filter's result list — the file name with its matched
 * characters picked out, and the folder it lives in as a quiet trailer.
 *
 * This is the whole reason the filter no longer narrows the tree: the tree
 * renders row names inside a shadow root we cannot split, so character-level
 * highlighting is only possible on markup we own.
 */
function MatchRow({
  match,
  active,
  onPick,
}: {
  match: FileMatch;
  active: boolean;
  onPick: (path: string) => void;
}) {
  const dir = dirname(match.path);

  let offset = 0;
  const name = highlightSegments(match.name, match.indexes).map((segment) => {
    const key = `${String(offset)}:${segment.text}`;
    offset += segment.text.length;
    return (
      <span key={key} className={segment.hit ? 'font-medium text-[var(--md-accent)]' : undefined}>
        {segment.text}
      </span>
    );
  });

  return (
    <button
      type="button"
      data-active={active}
      title={match.path}
      onClick={() => {
        onPick(match.path);
      }}
      // Inline so it outranks the hover class: the active row keeps its wash
      // while the pointer is elsewhere in the list.
      style={active ? { background: MATCH_ACTIVE_BG } : undefined}
      className="flex w-full cursor-pointer items-baseline gap-1.5 rounded-md px-2 py-1 text-left text-xs text-[var(--md-fg)] transition-colors hover:bg-[var(--md-hover)]"
    >
      <span className="min-w-0 truncate">{name}</span>
      {dir !== '' && (
        <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--md-muted)]">{dir}</span>
      )}
    </button>
  );
}

export function Sidebar() {
  const treePaths = useStore((s) => s.treePaths);
  const docPath = useStore((s) => s.docPath);
  const dirtyPath = useStore((s) => s.dirtyPath);
  const root = useStore((s) => s.root);
  const storedWidth = useStore((s) => s.settings.sidebarWidth);
  useMediaQuery(
    SIDEBAR_NARROW_QUERY,
    useStore((s) => s.setSidebarNarrow)
  );
  const commitDrag = useCallback(
    (final: SidebarDrag) => {
      if (final.collapse) writeSettings({ sidebarOpen: false });
      else if (final.width !== storedWidth) writeSettings({ sidebarWidth: final.width });
    },
    [storedWidth]
  );
  /** `drag` is non-null only mid-drag, and outranks the stored width while it is. */
  const { drag, dragging, start } = useSidebarDrag(storedWidth, commitDrag);
  const width = drag?.width ?? storedWidth;
  // A drag held past the collapse point previews the close it would commit to.
  const open = useSidebarShown() && drag?.collapse !== true;
  const applied = useRef<readonly string[]>([]);
  /** Set while the effect below mirrors `docPath` into the tree selection. */
  const syncingSelection = useRef(false);
  const [query, setQuery] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  /** Index of the highlighted row in `matches`; meaningless while it is null. */
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => filterTreePaths(treePaths, query), [treePaths, query]);

  /** The row being typed into right now, and where its entry will be created. */
  const draft = useRef<{
    path: string;
    parent: string;
    entry: NewEntry;
  } | null>(null);
  /** A folder to open once the daemon reports it exists. */
  const expandOnArrival = useRef<string | null>(null);
  const modelRef = useRef<FileTreeModel | null>(null);

  /** `remove` throws on a path the tree no longer has; that is not an error here. */
  const dropRow = useCallback((path: string): void => {
    try {
      modelRef.current?.remove(path, { recursive: true });
    } catch {
      // Already gone — the tree removes cancelled rows on its own.
    }
  }, []);

  const dropDraft = useCallback((): void => {
    const pending = draft.current;
    draft.current = null;
    if (pending !== null) dropRow(pending.path);
  }, [dropRow]);

  /**
   * Turns a finished inline edit into the `create` the daemon actually acts on.
   *
   * `row` is where that edit left the placeholder: the renamed path when the
   * tree reported one, the original path when it stayed put.
   */
  const commitDraft = useCallback(
    (name: string, row: string): void => {
      const pending = draft.current;
      draft.current = null;
      if (pending === null) return;

      const trimmed = name.trim();
      if (trimmed === '') {
        dropRow(row);
        return;
      }
      // A note typed without an extension is still a note, and the daemon only
      // creates markdown — so the extension is supplied rather than refused.
      const isFile = pending.entry === 'file';
      const finalName = isFile ? withMarkdownExtension(trimmed) : trimmed;
      const target = childPath(pending.parent, finalName);

      // The tree moves the placeholder onto its new name right after `onRename`
      // returns, so the row can only be dropped once that has happened —
      // leaving it would collide with the daemon's own tree update.
      queueMicrotask(() => {
        dropRow(row);
        dropRow(toTreePath(target, !isFile));
        if (!isFile) expandOnArrival.current = target;
        session.create(target, pending.entry);
      });
    },
    [dropRow]
  );

  // `useFileTree` reads its options once, so callbacks reach for live state
  // through refs rather than closing over a render's values.
  const { model } = useFileTree({
    paths: [],
    initialExpansion: 'open',
    icons: TREE_ICONS,
    unsafeCSS: TREE_CSS,
    // Read live: the tree keeps this callback from the moment it is built.
    renderRowDecoration: ({ item }) =>
      item.kind === 'file' && item.path === useStore.getState().dirtyPath
        ? { text: '\u25cf', title: '有未保存的更改' }
        : null,
    renaming: {
      // Renaming an existing entry stays a dialog; the tree's own inline editor
      // is borrowed only for the row that does not exist yet.
      canRename: ({ isFolder, path }) => toTreePath(path, isFolder) === draft.current?.path,
      onRename: ({ destinationPath, isFolder }) => {
        commitDraft(basename(destinationPath), toTreePath(destinationPath, isFolder));
      },
      onError: (message) => {
        useStore.getState().pushToast(message, 'error');
        const pending = draft.current;
        const current = modelRef.current;
        if (pending === null || current === null) return;
        // The tree closes its editor on a rejected name; reopen it so the row
        // is still there to correct instead of vanishing under the toast.
        queueMicrotask(() => {
          current.startRenaming(pending.path, { removeIfCanceled: true });
        });
      },
    },
    onSelectionChange: (paths) => {
      // Selection is a set and `select()` is additive, so the newest entry is
      // the one the user just acted on. The guard keeps our own programmatic
      // sync from being read back as a request to reopen the previous file.
      if (syncingSelection.current) return;
      const selected = paths.at(-1);
      if (selected === undefined || selected.endsWith('/')) return;
      // Starting an inline edit selects the placeholder row, which names no
      // file yet.
      if (selected === draft.current?.path) return;
      if (!isMarkdown(selected)) return;
      session.open(selected);
    },
  });
  modelRef.current = model;

  const startCreate = useCallback(
    (parent: string, entry: NewEntry): void => {
      dropDraft();
      const isDir = entry === 'dir';
      const base = isDir ? '新建文件夹' : '未命名.md';
      // The pre-filled name is also the fallback: pressing Enter on it
      // unchanged is a perfectly good way to create the entry, so it has to be
      // a name that does not already exist.
      let name = base;
      for (let n = 2; model.getItem(toTreePath(childPath(parent, name), isDir)) !== null; n += 1) {
        name = isDir ? `${base} ${String(n)}` : `未命名 ${String(n)}.md`;
      }
      const path = toTreePath(childPath(parent, name), isDir);

      draft.current = { path, parent, entry };
      model.add(path);
      // `startRenaming` opens every ancestor on the way down, so a folder the
      // reader had collapsed reveals the row it is about to fill in.
      if (!model.startRenaming(path, { removeIfCanceled: true })) dropDraft();
    },
    [model, dropDraft]
  );

  // Nothing is emitted when the pre-filled name is accepted as-is, so the end
  // of an edit is detected by watching the input disappear. The poll only runs
  // while a row is open, and stops as soon as it resolves.
  useEffect(() => {
    let seen = false;
    const timer = setInterval(() => {
      const pending = draft.current;
      if (pending === null) {
        seen = false;
        return;
      }
      if (renamingNow(model)) {
        seen = true;
        return;
      }
      if (!seen) return;
      seen = false;
      // The tree removes the row itself when the edit is cancelled; a row still
      // standing means the name was confirmed unchanged.
      if (model.getItem(pending.path) === null) draft.current = null;
      else commitDraft(basename(toServerPath(pending.path)), pending.path);
    }, 120);
    return () => {
      clearInterval(timer);
    };
  }, [model, commitDraft]);

  useEffect(() => {
    const previous = applied.current;
    applied.current = treePaths;
    const ops = diffTreePaths(previous, treePaths);
    if (ops === null) {
      model.resetPaths(treePaths);
      return;
    }
    if (ops.length === 0) return;
    try {
      model.batch(ops);
    } catch {
      model.resetPaths(treePaths);
    }
  }, [model, treePaths]);

  // A fresh query is answered from the top of its result list.
  useEffect(() => {
    setActive(0);
  }, [query]);

  // Scrolling happens here rather than in the key handler because the row that
  // needs to come into view only exists after the render the keystroke causes.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, matches]);

  // Mirror the open document onto the tree for files opened from anywhere but
  // the tree itself: a search hit, a wikilink, the CLI's `focus`, or a newly
  // created file. Re-run on `treePaths` as well, because a row that has only
  // just arrived cannot be selected before it exists.
  useEffect(() => {
    if (docPath === null) return;
    const item = model.getItem(docPath);
    if (item === null) return;
    syncingSelection.current = true;
    try {
      // `getSelectedPaths()` hands back a fresh array, so deselecting while
      // iterating it is safe.
      for (const path of model.getSelectedPaths()) {
        if (path !== docPath) model.getItem(path)?.deselect();
      }
      if (!item.isSelected()) item.select();
    } finally {
      syncingSelection.current = false;
    }
  }, [model, docPath, treePaths]);

  // Scrolling is deliberately *not* tied to the tree contents: an agent adding
  // a file somewhere else in the workspace pushes a new tree, and yanking the
  // sidebar back to the open document every time it does would fight anyone
  // browsing the tree. Only opening a different document earns a scroll.
  useEffect(() => {
    if (docPath === null) return;
    model.scrollToPath(docPath, { offset: 'nearest' });
  }, [model, docPath]);

  // The tree reads `renderRowDecoration` while it paints and exposes no
  // "decorations changed" entry point of its own. `setIcons` re-renders the
  // rows with the options the model already holds, which is the cheapest public
  // way to ask for that repaint — the icon set handed back is the same one.
  useEffect(() => {
    model.setIcons(TREE_ICONS);
  }, [model, dirtyPath]);

  // A folder the user just made is opened as soon as the daemon confirms it,
  // so the next thing they create lands inside it.
  useEffect(() => {
    const target = expandOnArrival.current;
    if (target === null) return;
    const dir = asDirectory(model.getItem(`${target}/`));
    if (dir === null) return;
    expandOnArrival.current = null;
    dir.expand();
  }, [model, treePaths]);

  const closeFilter = () => {
    setFilterOpen(false);
    setQuery('');
  };

  // Picking a hit puts the tree back but leaves the box open and focused, so
  // the next search is one keystroke away — quick open, not a one-shot filter.
  const openMatch = (path: string) => {
    session.open(path);
    setQuery('');
    inputRef.current?.focus();
  };

  return (
    // Collapsing animates the width rather than unmounting the tree, so folder
    // states, scroll position and the model itself survive a round trip. The
    // inner column keeps its full width throughout, so nothing reflows while
    // the panel slides.
    <motion.aside
      initial={false}
      animate={{ width: open ? width : 0 }}
      // A dragged edge has to sit under the pointer, not chase it.
      transition={dragging ? { duration: 0 } : { duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
      inert={open ? undefined : true}
      className="relative shrink-0 overflow-hidden bg-[var(--md-panel)]"
    >
      <div style={{ width }} className="flex h-full flex-col border-r border-[var(--md-border)]">
        <div className="flex h-11 shrink-0 items-center gap-1 px-3">
          <span
            className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--md-muted)]"
            title={root}
          >
            {basename(root) === '' ? '工作区' : basename(root)}
          </span>
          <NewEntryMenu onCreate={startCreate} />
          <button
            type="button"
            title={filterOpen ? '关闭筛选' : '按文件名筛选'}
            aria-label={filterOpen ? '关闭筛选' : '按文件名筛选'}
            aria-expanded={filterOpen}
            onClick={() => {
              if (filterOpen) closeFilter();
              else setFilterOpen(true);
            }}
            className={`flex cursor-pointer items-center rounded-md p-1 transition-colors hover:bg-[var(--md-hover)] hover:text-[var(--md-fg)] ${
              filterOpen ? 'bg-[var(--md-hover)] text-[var(--md-fg)]' : 'text-[var(--md-muted)]'
            }`}
          >
            <Icon name={filterOpen ? 'x' : 'search'} className="size-4" />
          </button>
        </div>

        <AnimatePresence initial={false}>
          {filterOpen && (
            // The row grows out of zero height rather than fading in place, so
            // the tree below is pushed down instead of jumping.
            <motion.div
              key="tree-filter"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
              className="shrink-0 overflow-hidden"
            >
              {/* The `pt-1` is load-bearing: the wrapper clips its overflow while
                it animates open, and the focus ring is drawn *outside* the
                input's box, so without a gutter its top edge is shaved off. */}
              <div className="px-3 pt-1 pb-2">
                <input
                  ref={inputRef}
                  // The row only exists because the user just asked to type in it.
                  autoFocus
                  type="text"
                  value={query}
                  placeholder="按文件名筛选…"
                  onChange={(event) => {
                    setQuery(event.target.value);
                  }}
                  // The result list is driven from the box the user is typing
                  // in, so it never has to take focus of its own.
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.stopPropagation();
                      closeFilter();
                      return;
                    }
                    if (matches === null) return;
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      // Otherwise the caret jumps to either end of the query.
                      event.preventDefault();
                      const step = event.key === 'ArrowDown' ? 1 : -1;
                      const last = Math.max(matches.length - 1, 0);
                      setActive((index) => Math.min(Math.max(index + step, 0), last));
                      return;
                    }
                    if (event.key !== 'Enter') return;
                    const match = matches[active];
                    if (match !== undefined) openMatch(match.path);
                  }}
                  className="w-full rounded-lg bg-[var(--md-bg)] px-2.5 py-1.5 text-xs ring-1 ring-[var(--md-border)] outline-none placeholder:text-[var(--md-muted)] focus:ring-[var(--md-accent)]"
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {matches !== null && (
          <div ref={listRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 py-2">
            {matches.length === 0 ? (
              <p className="px-1 py-1 text-xs text-[var(--md-muted)]">无匹配文件</p>
            ) : (
              <>
                {matches.map((match, index) => (
                  <MatchRow
                    key={match.path}
                    match={match}
                    active={index === active}
                    onPick={openMatch}
                  />
                ))}
                {matches.length === FILTER_LIMIT && (
                  <p className="px-1 pt-1.5 pb-1 text-[10px] text-[var(--md-muted)]">
                    仅显示前 {FILTER_LIMIT} 条结果
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {/* Hidden rather than unmounted while the result list is up: the tree
            owns its scroll position and folder states, and rebuilding it on
            every cleared query would throw both away.

            It has to be hidden from the `style` prop rather than a utility
            class: the tree writes `display: flex` straight onto its own host
            element, and no class can outrank an inline declaration. Dropping
            the property again drops that write with it, which is harmless —
            the tree's own stylesheet declares the same `display` on `:host`. */}
        <FileTree
          model={model}
          className="md-tree min-h-0 flex-1 pt-2"
          style={{ height: '100%', display: matches === null ? undefined : 'none' }}
          renderContextMenu={(item, context) => (
            <ContextMenu item={item} context={context} onCreate={startCreate} />
          )}
        />

        <SidebarFooter />
      </div>

      {open && (
        <SidebarResizer
          width={width}
          dragging={dragging}
          onStart={start}
          onNudge={(step) => {
            commitDrag(dragSidebar(width, step));
          }}
        />
      )}
    </motion.aside>
  );
}
