/** Viewport width at which the outline is wide enough to dock beside the text. */
export const TOC_WIDE_QUERY = '(min-width: 1280px)';

/**
 * Whether the user has taken over the outline's open state. Until they do, the
 * viewport decides; afterwards their choice sticks, across reloads included.
 */
export type TocPref = { manual: false } | { manual: true; open: boolean };

/** Docked panel, floating popover, or just the collapsed affordance. */
export type TocView = 'docked' | 'popover' | 'collapsed';

export const AUTO_PREF: TocPref = { manual: false };

/**
 * Reads the persisted preference. The stored value is the same `'1'`/`'0'`
 * the previous toggle wrote, so an existing choice keeps working and its
 * mere presence is what marks the state as manual.
 */
export function readTocPref(raw: string | null): TocPref {
  if (raw === '1') return { manual: true, open: true };
  if (raw === '0') return { manual: true, open: false };
  return AUTO_PREF;
}

/** The value to persist for a preference, or `null` when nothing should be. */
export function tocPrefValue(pref: TocPref): string | null {
  return pref.manual ? (pref.open ? '1' : '0') : null;
}

/**
 * Which of the three presentations the outline is in.
 *
 * A wide viewport has room to dock the panel beside the text, and the stored
 * preference says whether it is showing. A narrow one has not: there the
 * outline hangs off its button for as long as the pointer rests on it. That is
 * a passing state rather than a choice, so no preference governs it — and the
 * one a wide viewport left behind does not follow the reader down here.
 */
export function tocView(pref: TocPref, wide: boolean, hovered: boolean): TocView {
  if (!wide) return hovered ? 'popover' : 'collapsed';
  return !pref.manual || pref.open ? 'docked' : 'collapsed';
}

/** A user-driven open/close always takes the outline out of auto mode. */
export function manualPref(open: boolean): TocPref {
  return { manual: true, open };
}
