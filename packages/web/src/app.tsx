import { useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, type CSSProperties } from 'react';
import { fetchHealth } from './api.ts';
import { ConflictBanner } from './components/conflict-banner.tsx';
import { Dialogs } from './components/dialogs.tsx';
import { Editor } from './components/editor.tsx';
import { Sidebar } from './components/file-tree.tsx';
import { ImagePreview } from './components/image-preview.tsx';
import { Icon } from './components/icon.tsx';
import { SettingsDialog } from './components/settings-dialog.tsx';
import { Toasts } from './components/toasts.tsx';
import { Toc, useTocDocked } from './components/toc.tsx';
import { TopBar } from './components/top-bar.tsx';
import { readFileParam } from './lib/route.ts';
import { documentTitle } from './lib/title.ts';
import { session } from './session.ts';
import { useStore } from './store.ts';
import { createWsClient } from './ws.ts';

function Welcome() {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-md text-center">
        <Icon name="file-text" className="mx-auto size-8 text-[var(--md-muted)]" />
        <h1 className="mt-3 text-lg font-medium">还没有打开工作区</h1>
        <p className="mt-2 text-sm leading-relaxed text-[var(--md-muted)]">
          在终端运行{' '}
          <code className="rounded-md bg-[var(--md-panel)] px-1.5 py-0.5 text-[var(--md-fg)] ring-1 ring-[var(--md-border)]">
            md &lt;路径&gt;
          </code>{' '}
          打开文件或目录，这个页面会自动跟着切换。
        </p>
      </div>
    </div>
  );
}

/**
 * Keeps `?file=` and the open document in step.
 *
 * Outbound is the normal direction: every way of opening a document — the tree,
 * a wikilink, the CLI's `focus`, a file just created — goes through the session,
 * which mirrors its path into the URL. `replace` because switching files inside
 * one workspace is not a page the reader would expect Back to return to; the
 * cost is that Back leaves the app rather than stepping through files.
 *
 * Inbound only matters when something outside the app moves the URL — the
 * address bar, or a history entry from a real page load. The first render is
 * skipped: the initial `?file=` is the session's to consume, once the daemon
 * has said which workspace it belongs to.
 */
function useFileParam(): void {
  const navigate = useNavigate();
  const router = useRouter();

  useEffect(() => {
    session.setRoute({
      readFile: () => readFileParam(router.latestLocation.search),
      setFile: (file) => {
        // A same-href navigation is not free — the router reloads its matches
        // and runs the scroll cache again — and the session syncs on every
        // document event, so unchanged is the common case.
        if (readFileParam(router.latestLocation.search) === file) return;
        void navigate({ to: '/', search: file === null ? {} : { file }, replace: true });
      },
    });
    return () => {
      session.setRoute(null);
    };
  }, [navigate, router]);

  const file = useSearch({ from: '/', select: (search) => search.file ?? null });
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (file !== null && file !== session.currentPath()) session.open(file);
  }, [file]);
}

function useConnection(): void {
  useEffect(() => {
    const client = createWsClient({
      onMessage: (msg) => {
        session.receive(msg);
      },
      onOpen: () => {
        useStore.getState().setConnected(true);
      },
      onClose: () => {
        session.onDisconnect();
      },
    });
    session.setSend(client.send);
    return () => {
      session.setSend(null);
      client.close();
    };
  }, []);
}

/**
 * Says so when the daemon cannot read the workspace, or is not watching it.
 *
 * Both failures are otherwise invisible. A workspace it was refused reads as an
 * empty file tree, indistinguishable from a folder holding no Markdown — the
 * reader sees a blank sidebar and no reason for it. A dead watcher is subtler
 * still: everything keeps working except the one guarantee the app is built
 * around, that an agent's edits show up on their own.
 *
 * Re-asked whenever the workspace changes, because the answer is about *this*
 * root: `md <path>` can move a healthy daemon onto a directory it is refused,
 * and the reverse.
 */
function useAccessWarning(): void {
  const root = useStore((s) => s.root);
  useEffect(() => {
    if (root === '') return;
    void fetchHealth().then((health) => {
      if (health === null || health.workspace === null) return;
      const toast = useStore.getState().pushToast;
      if (!health.readable) {
        toast('无法读取工作区目录，文件列表为空；在终端重新运行 md <路径> 以重新授权', 'error');
        return;
      }
      if (!health.watching) toast('外部改动监听不可用，其他程序修改的文件不会自动刷新', 'error');
    });
  }, [root]);
}

/** Names the tab after the open document — see `documentTitle`. */
function useDocumentTitle(): void {
  const docPath = useStore((s) => s.docPath);
  const root = useStore((s) => s.root);
  useEffect(() => {
    document.title = documentTitle(docPath, root);
  }, [docPath, root]);
}

function useSaveShortcut(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      session.saveNow();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);
}

/** The docked outline floats over the text column, so the column pays for it in padding. */
const TOC_RESERVE = '17rem';

/** Custom properties are not part of `CSSProperties`, hence the widened type. */
function shellStyle(tocDocked: boolean): CSSProperties {
  const style: CSSProperties & Record<string, string> = {
    '--md-toc-reserve': tocDocked ? TOC_RESERVE : '0px',
  };
  return style;
}

export function App() {
  const root = useStore((s) => s.root);
  const tocDocked = useTocDocked();
  useFileParam();
  useConnection();
  useAccessWarning();
  useDocumentTitle();
  useSaveShortcut();

  return (
    <div className="flex h-full flex-col">
      {root === '' ? (
        <Welcome />
      ) : (
        <>
          <TopBar />
          <div className="flex min-h-0 flex-1" style={shellStyle(tocDocked)}>
            <Sidebar />
            {/* The editor column runs to the right edge of the window: its
                scrollbar is the one the reader reaches for. The outline floats
                over that column — inside it, so a conflict banner pushes the
                outline down with the text instead of being covered by it. */}
            <main className="flex min-w-0 flex-1 flex-col">
              <ConflictBanner />
              <div className="relative flex min-h-0 flex-1 flex-col">
                <Editor />
                <Toc />
              </div>
            </main>
          </div>
        </>
      )}
      <Dialogs />
      <ImagePreview />
      <SettingsDialog />
      <Toasts />
    </div>
  );
}
