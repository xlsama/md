import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TocEntry } from '../lib/toc.ts';
import { JUMP_GUTTER, jumpScrollTop } from '../lib/scroll.ts';
import { resolveTocOpen, TOC_WIDE_QUERY, tocView, type TocView } from '../lib/toc-panel.ts';
import { useStore } from '../store.ts';
import { IconButton } from './icon-button.tsx';
import { useDismiss } from './menu.tsx';
import { useTooltipTrigger } from './use-tooltip.ts';

const HEADINGS = 'h1, h2, h3, h4, h5, h6';

/**
 * Scrolls to the n-th heading of the document. The outline is built from the
 * markdown in document order and ProseMirror renders headings in the same
 * order, so the index lines the two up even when two headings share a title.
 *
 * The offset is measured against the scroll container rather than handed to
 * `scrollIntoView`, because the jump is animated by us — see `jumpScrollTop`.
 */
function scrollToHeading(index: number): void {
  const host = document.querySelector<HTMLElement>('.md-editor-host');
  const heading = host?.querySelector('.ProseMirror')?.querySelectorAll(HEADINGS)[index];
  if (host === null || host === undefined || heading === undefined) return;
  const offset = heading.getBoundingClientRect().top - host.getBoundingClientRect().top;
  jumpScrollTop(host, host.scrollTop + offset - JUMP_GUTTER);
}

interface TipAnchor {
  text: string;
  top: number;
  right: number;
}

/**
 * A hand-rolled tooltip instead of `title`: it is styled to match the app, it
 * appears without the native delay, and — most importantly — it only shows for
 * entries whose text is actually clipped.
 */
function Tooltip({ anchor }: { anchor: TipAnchor }) {
  return createPortal(
    <div
      role="tooltip"
      style={{ top: anchor.top, right: anchor.right }}
      className="md-fade-in md-tooltip pointer-events-none fixed z-50 max-w-sm -translate-y-1/2 rounded-lg px-2.5 py-1.5 text-[11px] leading-snug break-words"
    >
      {anchor.text}
    </div>,
    document.body
  );
}

function TocItem({
  entry,
  onShow,
  onNavigate,
}: {
  entry: TocEntry;
  onShow: (anchor: TipAnchor | null) => void;
  onNavigate: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);

  const show = (): boolean => {
    const node = ref.current;
    if (node === null) return false;
    // Only overflowing labels earn a tooltip; everything else is already legible.
    if (node.scrollWidth <= node.clientWidth) return false;
    const rect = node.getBoundingClientRect();
    onShow({
      text: entry.text,
      top: rect.top + rect.height / 2,
      right: window.innerWidth - rect.left + 8,
    });
    return true;
  };

  const hide = () => {
    onShow(null);
  };

  const handlers = useTooltipTrigger(show, hide);

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => {
        handlers.onMouseLeave();
        scrollToHeading(entry.index);
        onNavigate();
      }}
      {...handlers}
      style={{ paddingInlineStart: `${String(0.5 + (entry.level - 1) * 0.65)}rem` }}
      className="block w-full cursor-pointer truncate rounded-md py-1 pe-2 text-left text-[13px] text-[var(--md-muted)] transition-colors hover:bg-[var(--md-hover)] hover:text-[var(--md-fg)]"
    >
      {entry.text}
    </button>
  );
}

/** The outline list itself, shared by the docked panel and the popover. */
function TocList({ onNavigate }: { onNavigate: () => void }) {
  const toc = useStore((s) => s.toc);
  const [anchor, setAnchor] = useState<TipAnchor | null>(null);
  const onShow = useCallback((next: TipAnchor | null) => {
    setAnchor(next);
  }, []);

  return (
    <>
      {toc.length === 0 && (
        <p className="px-2 py-1 text-xs text-[var(--md-muted)]">这篇文档还没有标题</p>
      )}
      <ul>
        {toc.map((entry) => (
          <li key={`${String(entry.index)}:${entry.text}`} className="min-w-0">
            <TocItem entry={entry} onShow={onShow} onNavigate={onNavigate} />
          </li>
        ))}
      </ul>
      {anchor !== null && <Tooltip anchor={anchor} />}
    </>
  );
}

/** Keeps `tocWide` in step with the viewport so auto mode can follow it. */
function useTocViewport(): void {
  const setTocWide = useStore((s) => s.setTocWide);
  useEffect(() => {
    const query = window.matchMedia(TOC_WIDE_QUERY);
    const sync = () => {
      setTocWide(query.matches);
    };
    sync();
    query.addEventListener('change', sync);
    return () => {
      query.removeEventListener('change', sync);
    };
  }, [setTocWide]);
}

/**
 * Which of the three outline presentations is showing. Also read by the app
 * shell, which reserves the docked panel's width on the editor column — the
 * panel itself is `fixed`, so it takes no space of its own.
 */
export function useTocView(): TocView {
  const pref = useStore((s) => s.tocPref);
  const wide = useStore((s) => s.tocWide);
  return tocView(resolveTocOpen(pref, wide), wide);
}

export function Toc() {
  const docPath = useStore((s) => s.docPath);
  const setTocOpen = useStore((s) => s.setTocOpen);
  useTocViewport();

  const view = useTocView();
  const close = useCallback(() => {
    setTocOpen(false);
  }, [setTocOpen]);
  // The popover is the only view that can be dismissed by clicking away; the
  // hook is called unconditionally and simply idles for the other two.
  const popoverRef = useDismiss<HTMLElement>(view === 'popover', close);

  if (docPath === null) return null;

  if (view === 'collapsed') {
    return (
      // Same button, same place, same behaviour as the one that collapsed the
      // panel: transparent until hovered, so the corner stays quiet.
      <div className="absolute end-[calc(var(--md-scrollbar)+1.5rem)] top-2 z-30">
        <IconButton
          icon="align-left"
          label="展开大纲"
          onClick={() => {
            setTocOpen(true);
          }}
        />
      </div>
    );
  }

  const collapse = (
    <div className="flex justify-end">
      <IconButton icon="chevrons-right" label="收起大纲" onClick={close} />
    </div>
  );

  if (view === 'popover') {
    return (
      <nav
        ref={popoverRef}
        aria-label="大纲"
        className="md-fade-in md-glass absolute end-4 top-2 z-30 max-h-[70vh] w-60 overflow-x-hidden overflow-y-auto rounded-xl border p-2"
      >
        {collapse}
        <TocList onNavigate={close} />
      </nav>
    );
  }

  return (
    // Docked, but floating: the panel is taken out of the flow and sits just
    // inside the scrollbar, so the editor's scroll container can run to the
    // very edge of the window. The space it covers is reserved by the shell's
    // `--md-toc-reserve`, which is why it never lands on top of the text.
    <nav
      aria-label="大纲"
      className="absolute end-[calc(var(--md-scrollbar)+1rem)] top-0 bottom-0 z-20 w-60 overflow-x-hidden overflow-y-auto px-2 pb-3"
    >
      <div className="sticky top-0 z-10 bg-[var(--md-bg)] pt-2 pb-1">{collapse}</div>
      <TocList onNavigate={noop} />
    </nav>
  );
}

function noop(): void {
  // The docked panel stays put after a jump.
}
