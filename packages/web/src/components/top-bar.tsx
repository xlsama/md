import { basename } from '../lib/paths.ts';
import { useStore, writeSettings } from '../store.ts';
import { useAnchoredTooltip } from './anchored-tooltip.tsx';
import { useSidebarShown } from './file-tree.tsx';
import { IconButton } from './icon-button.tsx';

/**
 * The dot is small, so the hover target is the padded box around it — the same
 * box an icon button occupies, which also keeps it aligned with its neighbours.
 */
function DisconnectedDot() {
  const { ref, handlers, tip } = useAnchoredTooltip<HTMLSpanElement>({
    label: '连接已断开，正在重连…',
  });

  return (
    <>
      <span
        ref={ref}
        {...handlers}
        role="status"
        aria-label="未连接"
        className="flex shrink-0 items-center justify-center p-1.5"
      >
        <span className="block size-2 animate-pulse rounded-full bg-red-500" />
      </span>

      {tip}
    </>
  );
}

export function TopBar() {
  const docPath = useStore((s) => s.docPath);
  const readOnly = useStore((s) => s.readOnly);
  const toggleReadOnly = useStore((s) => s.toggleReadOnly);
  const connected = useStore((s) => s.connected);
  const narrow = useStore((s) => s.sidebarNarrow);
  const setSidebarOverride = useStore((s) => s.setSidebarOverride);
  // What the button reports is what is on screen, which on a narrow window is
  // not the same as what the settings say.
  const sidebarOpen = useSidebarShown();

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--md-border)] px-3">
      <IconButton
        icon={sidebarOpen ? 'panel-left-close' : 'panel-left-open'}
        label={sidebarOpen ? '收起文件树' : '展开文件树'}
        tooltip={false}
        pressed={sidebarOpen}
        onClick={() => {
          const next = !sidebarOpen;
          writeSettings({ sidebarOpen: next });
          // Asking for the tree on a window that folded it away is an answer to
          // that, and it stands until the window crosses the breakpoint again.
          if (narrow) setSidebarOverride(next);
        }}
      />

      <div className="flex min-w-0 flex-1 items-center">
        {docPath === null ? (
          <span className="truncate text-sm text-[var(--md-muted)]">未打开文件</span>
        ) : (
          // The folder a note lives in is already the tree's job to show; the
          // bar keeps to the one thing that changes as you read. Saving is
          // silent — it always succeeds, and a failure raises a toast.
          <span className="truncate text-sm font-medium" title={docPath}>
            {basename(docPath)}
          </span>
        )}
      </div>

      <IconButton
        icon="lock"
        label={readOnly ? '只读模式（已开启）' : '只读模式'}
        active={readOnly}
        pressed={readOnly}
        onClick={toggleReadOnly}
      />

      {/* A healthy connection is the normal state and needs no badge; only the
          broken one is worth a dot. */}
      {!connected && <DisconnectedDot />}
    </header>
  );
}
