import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from 'writedown/protocol';

/**
 * Below this the window has no room for a tree *and* a readable text column,
 * so the tree gives way — the document is what the reader came for. Chosen to
 * sit above the widest sidebar plus a comfortable column, and below the
 * narrowest laptop screen, so a maximised window never trips it.
 */
export const SIDEBAR_NARROW_QUERY = '(max-width: 900px)';

/**
 * Where a drag stops narrowing the panel and starts closing it. Well below the
 * minimum width, so the collapse is something the reader has to keep pulling
 * for rather than something a shaky pixel does to them.
 */
export const SIDEBAR_COLLAPSE_WIDTH = 110;

export interface SidebarDrag {
  /** The panel's own width, never taken below what the tree needs to be read. */
  width: number;
  /** Whether letting go here closes the panel instead of resizing it. */
  collapse: boolean;
}

/**
 * Where a drag that began at `startWidth` and has moved `dx` px stands.
 *
 * Past either end the width simply stops, so the edge stays under the pointer's
 * general direction instead of running off with it; carry on well past the
 * minimum and the drag turns into a close.
 */
export function dragSidebar(startWidth: number, dx: number): SidebarDrag {
  const raw = startWidth + dx;
  return {
    width: Math.min(Math.max(raw, SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH),
    collapse: raw < SIDEBAR_COLLAPSE_WIDTH,
  };
}

/**
 * Whether the panel is on screen.
 *
 * A narrow window folds it away without touching the stored preference, so
 * widening the window brings back exactly what the reader had. `override` is
 * their answer to that: opening the tree anyway on a narrow window keeps it
 * open until the window crosses the breakpoint again.
 */
export function sidebarShown(open: boolean, narrow: boolean, override: boolean): boolean {
  return open && (!narrow || override);
}
