import {
  MeowdownEditor,
  useExtension,
  type EditorHandle,
  type SlashMenuItem,
  type WikilinkItem,
} from '@meowdown/react';
import { useElementScrollRestoration, useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { uploadAsset } from '../api.ts';
import { defineDetailsBlocks } from '../details-blocks.ts';
import { watchImageLoading } from '../image-loading.ts';
import { defineLinkBlocks } from '../link-blocks.tsx';
import { dirname, isMarkdown, join, resolveImageUrl, stripExtension } from '../lib/paths.ts';
import { locationScrollKey } from '../lib/route.ts';
import { EDITOR_SCROLL_ID, restoreScrollTop } from '../lib/scroll.ts';
import { focusTrailingParagraph, isBelowLastBlock } from '../lib/trailing-paragraph.ts';
import { resolveWikilink, searchNotes } from '../lib/tree.ts';
import { session } from '../session.ts';
import { useStore } from '../store.ts';
import { FrontmatterTable } from './frontmatter-table.tsx';

const PLACEHOLDER = '开始写点什么…';

/**
 * Registers the link-block decorations.
 *
 * `useExtension` only works inside the editor's ProseKit context, which
 * `MeowdownEditor` exposes through `children` — hence a component that renders
 * nothing and exists purely to be a child.
 *
 * Switching the setting off removes the extension rather than making it render
 * nothing: the decorations are the only thing that hides the paragraph's own
 * text, so without them a bare link is simply a link again, live.
 */
function LinkBlocks() {
  const linkEmbeds = useStore((s) => s.settings.linkEmbeds);
  useExtension(useMemo(() => (linkEmbeds ? defineLinkBlocks() : null), [linkEmbeds]));
  return null;
}

/**
 * Registers the `<details>` folding.
 *
 * Which folds the reader has opened lives in the plugin's own state, and the
 * path is what scopes it: a new file gets a new plugin and starts from the
 * markdown's `open` attributes, while the formatter's write-back — a new
 * document under the same path — leaves the folds alone.
 */
function DetailsBlocks() {
  const docPath = useStore((s) => s.docPath);
  useExtension(useMemo(() => defineDetailsBlocks(docPath), [docPath]));
  return null;
}

export function Editor() {
  const handleRef = useRef<EditorHandle>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const docPath = useStore((s) => s.docPath);
  const docLoading = useStore((s) => s.docLoading);
  const readOnly = useStore((s) => s.readOnly);
  const urlFile = useSearch({ from: '/', select: (search) => search.file ?? null });
  const remembered =
    useElementScrollRestoration({ id: EDITOR_SCROLL_ID, getKey: locationScrollKey })?.scrollY ?? 0;

  useEffect(() => {
    session.attach(handleRef.current);
    return () => {
      session.attach(null);
    };
  }, []);

  /**
   * Puts the reader back where they left this document.
   *
   * The router restores element scroll the moment the route renders, which here
   * is too early by a WebSocket round trip — the text has not arrived, and
   * loading it moves the caret to the start, which scrolls the container to the
   * top. So the offset is re-applied once the document is in, and a file being
   * opened for the first time has no offset to apply and simply stays at the
   * top where the load left it.
   *
   * `urlFile === docPath` is the gate: the cache entry is read for whatever the
   * URL currently names, so the offset can only be trusted once the URL and the
   * editor agree on the document.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (host === null || docPath === null || docLoading || urlFile !== docPath) return undefined;
    return restoreScrollTop(host, remembered);
  }, [docPath, docLoading, urlFile, remembered]);

  // Image placeholders are driven from the host because meowdown rebuilds the
  // image DOM on every reparse — see `image-loading.ts`.
  useEffect(() => {
    const host = hostRef.current;
    return host === null ? undefined : watchImageLoading(host);
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
    if (isMarkdown(target)) session.open(target);
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

  /**
   * A document without frontmatter shows no property table, so this is where a
   * block is started. Typing `---` cannot do it: the peel happens when markdown
   * is parsed, and a rule typed into the editor is a rule.
   */
  const handleSlashMenuSearch = useCallback((): SlashMenuItem[] => {
    const editor = handleRef.current?.editor;
    if (editor === undefined || editor.state.doc.attrs.frontmatter !== null) return [];
    return [
      {
        id: 'frontmatter',
        label: '属性',
        keywords: ['frontmatter', 'yaml', 'properties', 'metadata'],
        detail: 'YAML frontmatter',
        onSelect: () => {
          editor.exec((state, dispatch) => {
            dispatch?.(state.tr.setDocAttribute('frontmatter', ''));
            return true;
          });
        },
      },
    ];
  }, []);

  return (
    <div
      ref={hostRef}
      data-scroll-restoration-id={EDITOR_SCROLL_ID}
      className="md-editor-host min-h-0 flex-1 overflow-y-auto"
      onBlur={() => {
        session.onBlur();
      }}
      // Clicking the empty space under the text continues the document there,
      // the way pressing Enter on the last line would. Capture phase with the
      // event cancelled: ProseMirror's own mousedown would otherwise drop the
      // caret at the end of the last block and start a selection drag from it.
      onMouseDownCapture={(event) => {
        const editor = handleRef.current?.editor;
        if (editor === undefined || docPath === null || readOnly) return;
        if (event.button !== 0 || event.shiftKey) return;
        if (!isBelowLastBlock(editor.view.dom.lastElementChild, event.clientY)) return;
        event.preventDefault();
        event.stopPropagation();
        focusTrailingParagraph(editor);
      }}
      // Capture phase: the clipboard is read before ProseMirror consumes the
      // event. The paste itself proceeds untouched — this only notes which
      // remote images it carried so they can be imported in the background.
      onPasteCapture={(event) => {
        const data = event.clipboardData;
        session.importPastedImages(
          `${data.getData('text/plain')}\n${data.getData('text/html')}`
        );
      }}
    >
      <MeowdownEditor
        handleRef={handleRef}
        // The Typora-style reveal-at-the-caret rendering is the only mode the
        // app offers; the other two existed for a switcher that is gone.
        mode="focus"
        initialMarkdown=""
        readOnly={docPath === null || readOnly}
        placeholder={PLACEHOLDER}
        spellCheck={false}
        // Peels a leading `---` block onto the doc's `frontmatter` attribute
        // instead of parsing it as a rule and a paragraph of prose, and writes
        // it back on save. `FrontmatterTable` is the UI for that attribute.
        frontmatter
        onDocChange={handleDocChange}
        onSlashMenuSearch={handleSlashMenuSearch}
        onWikilinkSearch={handleWikilinkSearch}
        onWikilinkClick={handleWikilinkClick}
        onLinkClick={handleLinkClick}
        onFilePaste={handleFilePaste}
        onFileSaveError={handleFileSaveError}
        resolveImageUrl={resolveImage}
      >
        <LinkBlocks />
        <DetailsBlocks />
        <FrontmatterTable />
      </MeowdownEditor>
    </div>
  );
}
