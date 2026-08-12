import { MeowdownEditor, type EditorHandle, type WikilinkItem } from '@meowdown/react';
import { useCallback, useEffect, useRef } from 'react';
import { uploadAsset } from '../api.ts';
import { dirname, isMarkdownPath, join, resolveImageUrl, stripExtension } from '../lib/paths.ts';
import { resolveWikilink, searchNotes } from '../lib/tree.ts';
import { session } from '../session.ts';
import { useStore } from '../store.ts';

const PLACEHOLDER = '开始写点什么…';

export function Editor() {
  const handleRef = useRef<EditorHandle>(null);
  const mode = useStore((s) => s.mode);
  const docPath = useStore((s) => s.docPath);
  const editorQuery = useStore((s) => s.editorQuery);

  useEffect(() => {
    session.attach(handleRef.current);
    return () => {
      session.attach(null);
    };
  }, []);

  const handleDocChange = useCallback(() => {
    session.onDocChange();
  }, []);

  // Every resolver below reads live state through `session` / `useStore`
  // instead of closing over props, so the identities stay stable: meowdown
  // reads several of them once at editor-creation time.
  const resolveImage = useCallback(
    (src: string) => resolveImageUrl(src, session.currentPath()),
    []
  );

  const handleWikilinkSearch = useCallback((query: string): WikilinkItem[] => {
    const files = useStore.getState().mdFiles;
    return searchNotes(files, query).map((path) => ({
      target: stripExtension(path),
      detail: dirname(path) === '' ? undefined : dirname(path),
    }));
  }, []);

  const handleWikilinkClick = useCallback(({ target }: { target: string }) => {
    const state = useStore.getState();
    const resolved = resolveWikilink(state.mdFiles, target, session.currentPath());
    if (resolved === null) {
      state.pushToast(`笔记「${target}」不存在`, 'error');
      return;
    }
    session.open(resolved);
  }, []);

  const handleLinkClick = useCallback(({ href }: { href: string }) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      window.open(href, '_blank', 'noopener,noreferrer');
      return;
    }
    const current = session.currentPath();
    const target = join(current === null ? '' : dirname(current), href.split('#')[0] ?? '');
    if (isMarkdownPath(target)) session.open(target);
  }, []);

  const handleFilePaste = useCallback(async (file: File): Promise<string | undefined> => {
    const docPathNow = session.currentPath();
    if (docPathNow === null) {
      useStore.getState().pushToast('请先打开一个文件再插入图片', 'error');
      return undefined;
    }
    const asset = await uploadAsset(file, docPathNow);
    return asset.relativePath;
  }, []);

  const handleFileSaveError = useCallback((error: unknown) => {
    useStore.getState().pushToast(error instanceof Error ? error.message : '图片上传失败', 'error');
  }, []);

  return (
    <div
      className="md-editor-host min-h-0 flex-1 overflow-y-auto"
      onBlur={() => {
        session.onBlur();
      }}
    >
      <MeowdownEditor
        handleRef={handleRef}
        mode={mode}
        initialMarkdown=""
        readOnly={docPath === null}
        placeholder={PLACEHOLDER}
        searchQuery={editorQuery}
        spellCheck={false}
        onDocChange={handleDocChange}
        onWikilinkSearch={handleWikilinkSearch}
        onWikilinkClick={handleWikilinkClick}
        onLinkClick={handleLinkClick}
        onFilePaste={handleFilePaste}
        onFileSaveError={handleFileSaveError}
        resolveImageUrl={resolveImage}
      />
    </div>
  );
}
