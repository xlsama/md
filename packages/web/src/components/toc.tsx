import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { activeHeading, type TocEntry } from '../lib/toc.ts';
import { JUMP_GUTTER, jumpScrollTop, reducedMotion } from '../lib/scroll.ts';
import { TOC_WIDE_QUERY, tocView } from '../lib/toc-panel.ts';
import { useStore } from '../store.ts';
import { IconButton } from './icon-button.tsx';
import { useDismiss } from './menu.tsx';
import { useMediaQuery } from './use-media-query.ts';
import { useTooltipTrigger } from './use-tooltip.ts';

const HEADINGS = 'h1, h2, h3, h4, h5, h6';

function editorHost(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.md-editor-host');
}

function headingNodes(host: HTMLElement): NodeListOf<Element> | undefined {
  return host.querySelector('.ProseMirror')?.querySelectorAll(HEADINGS);
}

/**
 * Scrolls to the n-th heading of the document. The outline is built from the
 * markdown in document order and ProseMirror renders headings in the same
 * order, so the index lines the two up even when two headings share a title.
 *
 * The offset is measured against the scroll container rather than handed to
 * `scrollIntoView`, because the jump is animated by us — see `jumpScrollTop`.
 */
function scrollToHeading(index: number): void {
  const host = editorHost();
  const heading = host === null ? undefined : headingNodes(host)?.[index];
  if (host === null || heading === undefined) return;
  const offset = heading.getBoundingClientRect().top - host.getBoundingClientRect().top;
  jumpScrollTop(host, host.scrollTop + offset - JUMP_GUTTER);
}

/** Each heading's offset from the top of the document, in scroll coordinates. */
function headingTops(host: HTMLElement): number[] {
  const base = host.getBoundingClientRect().top - host.scrollTop;
  return [...(headingNodes(host) ?? [])].map((node) => node.getBoundingClientRect().top - base);
}

/**
 * The heading the reader is currently under, kept in step with the editor's
 * scroll so the outline can mark it.
 *
 * Positions are measured on demand rather than cached: images, link cards and
 * highlighted code all land after the document is parsed, and every one of them
 * moves the headings below it. Measuring is capped at one animation frame, and
 * only ever runs while an outline is on screen to read the result.
 *
 * `key` re-measures when the document itself changes; scrolling covers the rest.
 */
function useActiveHeading(key: string): number {
  const [active, setActive] = useState(-1);

  useEffect(() => {
    const host = editorHost();
    if (host === null) return undefined;

    let frame = 0;
    const measure = () => {
      frame = 0;
      setActive(activeHeading(headingTops(host), host));
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };

    schedule();
    host.addEventListener('scroll', schedule, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      host.removeEventListener('scroll', schedule);
    };
  }, [key]);

  return active;
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
  active,
  onShow,
  onNavigate,
}: {
  entry: TocEntry;
  active: boolean;
  onShow: (anchor: TipAnchor | null) => void;
  onNavigate: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);

  // A long outline scrolls too, and the marked entry is no use off-screen.
  // `nearest` leaves it alone whenever it is already in view, so the list only
  // moves when the reading has actually walked past its edge.
  useEffect(() => {
    if (!active) return;
    ref.current?.scrollIntoView({
      block: 'nearest',
      behavior: reducedMotion() ? 'auto' : 'smooth',
    });
  }, [active]);

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
      aria-current={active ? 'location' : undefined}
      style={{ paddingInlineStart: `${String(0.5 + (entry.level - 1) * 0.65)}rem` }}
      className={`block w-full cursor-pointer truncate rounded-md py-1 pe-2 text-left text-[13px] transition-colors duration-200 ${
        active
          ? 'bg-[color-mix(in_oklab,var(--md-accent)_12%,transparent)] font-medium text-[var(--md-accent)]'
          : 'text-[var(--md-muted)] hover:bg-[var(--md-hover)] hover:text-[var(--md-fg)]'
      }`}
    >
      {entry.text}
    </button>
  );
}

/** The outline list itself, shared by the docked panel and the popover. */
function TocList({ onNavigate }: { onNavigate: () => void }) {
  const toc = useStore((s) => s.toc);
  const docPath = useStore((s) => s.docPath);
  const active = useActiveHeading(`${docPath ?? ''}:${String(toc.length)}`);
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
            <TocItem
              entry={entry}
              active={entry.index === active}
              onShow={onShow}
              onNavigate={onNavigate}
            />
          </li>
        ))}
      </ul>
      {anchor !== null && <Tooltip anchor={anchor} />}
    </>
  );
}

/** Keeps `tocWide` in step with the viewport so auto mode can follow it. */
function useTocViewport(): void {
  useMediaQuery(
    TOC_WIDE_QUERY,
    useStore((s) => s.setTocWide)
  );
}

/**
 * Whether the docked panel is showing. Read by the app shell, which reserves
 * its width on the editor column — the panel itself is taken out of the flow,
 * so it takes no space of its own.
 */
export function useTocDocked(): boolean {
  const pref = useStore((s) => s.tocPref);
  const wide = useStore((s) => s.tocWide);
  return tocView(pref, wide, false) === 'docked';
}

/**
 * The outline on a viewport too narrow to dock it: a button that hangs the
 * list off itself while the pointer is on it. No click needed, and none that
 * has to be undone — the outline is gone the moment the pointer leaves.
 *
 * The list is a child of the hovered element rather than a sibling, so moving
 * the pointer from the button down onto it never crosses a gap and the padding
 * between the two belongs to the hover target.
 */
function TocHover() {
  const [hovered, setHovered] = useState(false);
  const close = useCallback(() => {
    setHovered(false);
  }, []);
  // A pointer that never hovers — a touch screen — opens the outline by tapping
  // the button and closes it by tapping away, which is what this covers.
  const ref = useDismiss(hovered, close);

  return (
    <div
      ref={ref}
      className="absolute end-[calc(var(--md-scrollbar)+1.5rem)] top-2 z-30"
      onMouseEnter={() => {
        setHovered(true);
      }}
      onMouseLeave={close}
      // React's `onFocus`/`onBlur` bubble, so these fire for the button and for
      // anything in the list: keyboard users get the same outline by tabbing.
      onFocus={() => {
        setHovered(true);
      }}
      onBlur={close}
    >
      {/* No tooltip: the outline itself is what the pointer gets, and naming
          the button underneath it would only crowd the corner. A tap — the
          gesture with no hover to it — is what `onClick` is left holding. */}
      <IconButton
        icon="align-left"
        label="大纲"
        tooltip={false}
        onClick={() => {
          setHovered(true);
        }}
      />
      {hovered && (
        <nav aria-label="大纲" className="absolute end-0 top-full w-60 pt-2">
          <div className="md-fade-in md-glass max-h-[70vh] overflow-x-hidden overflow-y-auto rounded-xl border p-2">
            <TocList onNavigate={close} />
          </div>
        </nav>
      )}
    </div>
  );
}

export function Toc() {
  const docPath = useStore((s) => s.docPath);
  const pref = useStore((s) => s.tocPref);
  const wide = useStore((s) => s.tocWide);
  const setTocOpen = useStore((s) => s.setTocOpen);
  useTocViewport();

  if (docPath === null) return null;
  if (!wide) return <TocHover />;

  if (tocView(pref, wide, false) === 'collapsed') {
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

  return (
    // Docked, but floating: the panel is taken out of the flow and sits just
    // inside the scrollbar, so the editor's scroll container can run to the
    // very edge of the window. The space it covers is reserved by the shell's
    // `--md-toc-reserve`, which is why it never lands on top of the text.
    <nav
      aria-label="大纲"
      className="absolute end-[calc(var(--md-scrollbar)+1rem)] top-0 bottom-0 z-20 w-60 overflow-x-hidden overflow-y-auto px-2 pb-3"
    >
      <div className="sticky top-0 z-10 flex justify-end bg-[var(--md-bg)] pt-2 pb-1">
        <IconButton
          icon="chevrons-right"
          label="收起大纲"
          onClick={() => {
            setTocOpen(false);
          }}
        />
      </div>
      <TocList onNavigate={noop} />
    </nav>
  );
}

function noop(): void {
  // The docked panel stays put after a jump.
}
