import { useEffect, useRef } from 'react';
import { hoverDelay, type WarmState } from '../lib/tooltip-group.ts';

/**
 * The app has one tooltip group, so every tooltip in it warms up together —
 * the outline's clipped entries and the icon buttons behave the same way.
 */
const warm: WarmState = { showing: false, hiddenAt: null };
let openCount = 0;

function acquire(): void {
  openCount += 1;
  warm.showing = true;
}

function release(): void {
  openCount = Math.max(0, openCount - 1);
  if (openCount > 0) return;
  warm.showing = false;
  warm.hiddenAt = Date.now();
}

export interface TooltipHandlers {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
}

/**
 * Wires a control's hover and focus to a tooltip that respects the group delay.
 *
 * `show` returns whether a tooltip actually went up: a control can decline —
 * an icon button with `tooltip={false}`, an outline entry whose text is not
 * clipped — and a declined hover must not warm the group up for the others.
 *
 * Focus opens without waiting: a keyboard user tabbing onto a control is asking
 * what it is, not passing over it.
 */
export function useTooltipTrigger(show: () => boolean, hide: () => void): TooltipHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = useRef(false);

  const clear = (): void => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
  };

  const openNow = (): void => {
    clear();
    if (open.current || !show()) return;
    open.current = true;
    acquire();
  };

  const close = (): void => {
    clear();
    hide();
    if (!open.current) return;
    open.current = false;
    release();
  };

  const enter = (): void => {
    clear();
    const delay = hoverDelay(warm, Date.now());
    if (delay === 0) {
      openNow();
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      openNow();
    }, delay);
  };

  // A control unmounted while its tooltip is up (the outline closing, say) would
  // otherwise leave the group believing one is still on screen.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      if (!open.current) return;
      open.current = false;
      release();
    },
    []
  );

  return { onMouseEnter: enter, onMouseLeave: close, onFocus: openNow, onBlur: close };
}
