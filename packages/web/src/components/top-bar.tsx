import { basename } from '../lib/paths.ts';
import { useStore, writeSettings } from '../store.ts';
import { useSidebarShown } from './file-tree.tsx';
import { IconButton } from './icon-button.tsx';

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

      <span
        title={connected ? '已连接到本地服务' : '连接已断开，正在重连…'}
        aria-label={connected ? '已连接' : '未连接'}
        className={`ml-1 block size-2 shrink-0 rounded-full ${
          connected ? 'bg-emerald-500' : 'animate-pulse bg-red-500'
        }`}
      />
    </header>
  );
}
