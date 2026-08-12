import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TocEntry } from '../lib/toc.ts';
import { useStore } from '../store.ts';

const HEADINGS = 'h1, h2, h3, h4, h5, h6';

/**
 * Scrolls to the n-th heading of the document. The outline is built from the
 * markdown in document order and ProseMirror renders headings in the same
 * order, so the index lines the two up even when two headings share a title.
 */
function scrollToHeading(index: number): void {
  const editor = document.querySelector('.md-editor-host .ProseMirror');
  const heading = editor?.querySelectorAll(HEADINGS)[index];
  heading?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

function TocItem({ entry, onShow }: { entry: TocEntry; onShow: (anchor: TipAnchor | null) => void }) {
  const ref = useRef<HTMLButtonElement>(null);

  const show = () => {
    const node = ref.current;
    if (node === null) return;
    // Only overflowing labels earn a tooltip; everything else is already legible.
    if (node.scrollWidth <= node.clientWidth) return;
    const rect = node.getBoundingClientRect();
    onShow({
      text: entry.text,
      top: rect.top + rect.height / 2,
      right: window.innerWidth - rect.left + 8,
    });
  };

  const hide = () => {
    onShow(null);
  };

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => {
        scrollToHeading(entry.index);
      }}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      style={{ paddingInlineStart: `${String(0.5 + (entry.level - 1) * 0.65)}rem` }}
      className="block w-full truncate rounded-md py-1 pe-2 text-left text-xs text-[var(--md-muted)] transition-colors hover:bg-[var(--md-hover)] hover:text-[var(--md-fg)]"
    >
      {entry.text}
    </button>
  );
}

export function Toc() {
  const toc = useStore((s) => s.toc);
  const tocOpen = useStore((s) => s.tocOpen);
  const docPath = useStore((s) => s.docPath);
  const [anchor, setAnchor] = useState<TipAnchor | null>(null);
  const onShow = useCallback((next: TipAnchor | null) => {
    setAnchor(next);
  }, []);

  if (!tocOpen || docPath === null) return null;

  return (
    <nav className="hidden w-56 shrink-0 overflow-x-hidden overflow-y-auto px-2 py-3 lg:block">
      <p className="px-2 pb-2 text-[11px] font-medium tracking-wide text-[var(--md-muted)]">大纲</p>
      {toc.length === 0 && <p className="px-2 text-xs text-[var(--md-muted)]">这篇文档还没有标题</p>}
      <ul>
        {toc.map((entry) => (
          <li key={`${String(entry.index)}:${entry.text}`} className="min-w-0">
            <TocItem entry={entry} onShow={onShow} />
          </li>
        ))}
      </ul>
      {anchor !== null && <Tooltip anchor={anchor} />}
    </nav>
  );
}
