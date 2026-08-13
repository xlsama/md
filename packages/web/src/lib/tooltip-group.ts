/** How long the first hover of a cold group waits before its tooltip opens. */
export const TOOLTIP_DELAY = 500;

/**
 * How long the group stays warm after the last tooltip came down.
 *
 * Long enough to cross the gap between two neighbouring controls, short enough
 * that coming back to the toolbar later is a fresh, deliberate hover.
 */
export const WARM_GRACE = 400;

export interface WarmState {
  /** A tooltip from this group is on screen right now. */
  showing: boolean;
  /** When the last one came down, or null if none has been up yet. */
  hiddenAt: number | null;
}

/**
 * How long a hover starting at `now` should wait before opening its tooltip.
 *
 * The whole point of a delay is to keep tooltips out of the way of a pointer
 * that is merely passing through; once the reader has asked for one, they are
 * reading labels, and making them wait again at every neighbouring control is
 * just friction. So the group warms up on the first tooltip and answers
 * instantly until the pointer has been away long enough to have moved on.
 */
export function hoverDelay(
  state: WarmState,
  now: number,
  delay = TOOLTIP_DELAY,
  grace = WARM_GRACE
): number {
  if (state.showing) return 0;
  if (state.hiddenAt !== null && now - state.hiddenAt < grace) return 0;
  return delay;
}
