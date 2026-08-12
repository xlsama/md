import { useEffect } from 'react';
import { fetchHealth } from './api.ts';
import { ConflictBanner } from './components/conflict-banner.tsx';
import { Dialogs } from './components/dialogs.tsx';
import { Editor } from './components/editor.tsx';
import { Sidebar } from './components/file-tree.tsx';
import { Icon } from './components/icon.tsx';
import { Toasts } from './components/toasts.tsx';
import { Toc } from './components/toc.tsx';
import { TopBar } from './components/top-bar.tsx';
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
    void fetchHealth().then((health) => {
      if (health !== null) useStore.getState().setRipgrep(health.ripgrep);
    });
    return () => {
      session.setSend(null);
      client.close();
    };
  }, []);
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

export function App() {
  const root = useStore((s) => s.root);
  useConnection();
  useSaveShortcut();

  return (
    <div className="flex h-full flex-col">
      {root === '' ? (
        <Welcome />
      ) : (
        <>
          <TopBar />
          <div className="flex min-h-0 flex-1">
            <Sidebar />
            <main className="flex min-w-0 flex-1 flex-col">
              <ConflictBanner />
              <Editor />
            </main>
            <Toc />
          </div>
        </>
      )}
      <Dialogs />
      <Toasts />
    </div>
  );
}
