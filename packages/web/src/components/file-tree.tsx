import type { ContextMenuItem, ContextMenuOpenContext } from '@pierre/trees';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { basename, dirname, isMarkdownPath } from '../lib/paths.ts';
import { diffTreePaths } from '../lib/tree.ts';
import { session } from '../session.ts';
import { useStore } from '../store.ts';
import { Icon } from './icon.tsx';
import { MenuItem, MenuSeparator, MenuSurface, useDismiss } from './menu.tsx';
import { SearchPanel } from './search-panel.tsx';

/**
 * The tree holds `.md` files only, so a per-row file glyph is pure noise.
 * `icons: { set: 'none' }` drops the built-in file-type icon set; the generic
 * fallback glyph that remains is hidden through the tree's own `unsafeCSS`
 * option, since the rows live inside a shadow root our stylesheet cannot reach.
 * The icon lane keeps its width, so file names stay aligned with folder names.
 */
const HIDE_FILE_ICONS = '[data-item-type="file"] [data-item-section="icon"] > svg { display: none; }';

/** Canonical tree paths keep a trailing slash on directories; the daemon does not. */
function toServerPath(path: string): string {
  return path.replace(/\/+$/, '');
}

function ContextMenu({
  item,
  context,
}: {
  item: ContextMenuItem;
  context: ContextMenuOpenContext;
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
          setDialog({ kind: 'create', entry: 'file', parent });
        })}
      />
      <MenuItem
        icon="folder-plus"
        label="新建文件夹"
        onClick={run(() => {
          setDialog({ kind: 'create', entry: 'dir', parent });
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

function NewEntryMenu({ parent }: { parent: string }) {
  const setDialog = useStore((s) => s.setDialog);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => {
    setOpen(false);
  }, []);
  const ref = useDismiss(open, close);

  const create = (entry: 'file' | 'dir') => () => {
    close();
    setDialog({ kind: 'create', entry, parent });
  };

  return (
    <div ref={ref} className="relative">
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

export function Sidebar() {
  const treePaths = useStore((s) => s.treePaths);
  const docPath = useStore((s) => s.docPath);
  const root = useStore((s) => s.root);
  const applied = useRef<readonly string[]>([]);
  /** Set while the effect below mirrors `docPath` into the tree selection. */
  const syncingSelection = useRef(false);

  // `useFileTree` reads its options once, so callbacks reach for live state
  // through the store rather than closing over a render's values.
  const { model } = useFileTree({
    paths: [],
    initialExpansion: 'open',
    icons: { set: 'none' },
    unsafeCSS: HIDE_FILE_ICONS,
    onSelectionChange: (paths) => {
      // Selection is a set and `select()` is additive, so the newest entry is
      // the one the user just acted on. The guard keeps our own programmatic
      // sync from being read back as a request to reopen the previous file.
      if (syncingSelection.current) return;
      const selected = paths.at(-1);
      if (selected === undefined || selected.endsWith('/')) return;
      if (!isMarkdownPath(selected)) return;
      session.open(selected);
    },
  });

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

  // Mirror the open document onto the tree for files opened from anywhere but
  // the tree itself: a search hit, a wikilink, the CLI's `focus`, or a newly
  // created file.
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
      model.scrollToPath(docPath, { offset: 'nearest' });
    } finally {
      syncingSelection.current = false;
    }
  }, [model, docPath, treePaths]);

  const newEntryParent = docPath === null ? '' : dirname(docPath);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--md-border)] bg-[var(--md-panel)]">
      <div className="flex h-11 shrink-0 items-center gap-1 px-3">
        <span
          className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--md-muted)]"
          title={root}
        >
          {basename(root) === '' ? '工作区' : basename(root)}
        </span>
        <NewEntryMenu parent={newEntryParent} />
      </div>

      <SearchPanel />

      <FileTree
        model={model}
        className="md-tree min-h-0 flex-1"
        style={{ height: '100%' }}
        renderContextMenu={(item, context) => <ContextMenu item={item} context={context} />}
      />
    </aside>
  );
}
