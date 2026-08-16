import { autoUpdate, flip, offset, shift, useFloating } from '@floating-ui/react-dom';
import { useState, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { useTooltipTrigger, type TooltipHandlers } from './use-tooltip.ts';

/** Which side of the control the tooltip prefers to open on. */
export type TipPlacement = 'bottom' | 'top';

export interface AnchoredTooltip<T extends HTMLElement> {
  /** Goes on the control the tooltip describes; it is measured to place the tip. */
  ref: Ref<T>;
  /** Spread onto the same control: hover and focus drive the tooltip. */
  handlers: TooltipHandlers;
  /** Render next to the control; `null` while the tooltip is down. */
  tip: ReactNode;
}

/**
 * A label that opens beside a control on hover, for controls that carry no text
 * of their own.
 *
 * The tooltip is portalled and `fixed` so it can escape the toolbar's own
 * clipping, and it reuses the `md-tooltip` surface the outline already uses —
 * `title` is deliberately avoided: it lags by a second and is styled by the OS.
 *
 * Placement is a preference, not a promise: the first and last buttons of a bar
 * sit against the window edge, where a centred label would hang off it, so
 * `shift` slides the label back inside and `flip` sends it to the other side
 * when the preferred one has no room.
 */
export function useAnchoredTooltip<T extends HTMLElement>({
  label,
  placement = 'bottom',
  enabled = true,
}: {
  label: string;
  /** `top` for controls on the last row of the window, where below is off-screen. */
  placement?: TipPlacement;
  /** Self-explanatory controls opt out; `label` still names them for a11y. */
  enabled?: boolean;
}): AnchoredTooltip<T> {
  const [open, setOpen] = useState(false);

  const { refs, floatingStyles } = useFloating({
    open,
    placement,
    middleware: [offset(8), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
    // Positioned by `top`/`left` rather than a transform, which the fade-in
    // keyframes already own — a transform here would be overridden mid-animation
    // and drop the tooltip in the corner of the window.
    transform: false,
  });

  const show = (): boolean => {
    if (!enabled) return false;
    setOpen(true);
    return true;
  };

  const hide = () => {
    setOpen(false);
  };

  const handlers = useTooltipTrigger(show, hide);

  const tip = open
    ? createPortal(
        <div
          ref={refs.setFloating}
          role="tooltip"
          style={floatingStyles}
          className="md-fade-in md-tooltip pointer-events-none z-50 max-w-[calc(100vw-1rem)] rounded-lg px-2.5 py-1.5 text-[11px] leading-snug break-words"
        >
          {label}
        </div>,
        document.body
      )
    : null;

  return { ref: refs.setReference, handlers, tip };
}
