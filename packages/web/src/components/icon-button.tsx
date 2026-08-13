import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { IconName } from '../lib/icons.ts';
import { Icon } from './icon.tsx';
import { useTooltipTrigger } from './use-tooltip.ts';

interface TipPosition {
  top: number;
  left: number;
}

/** Which side of the button the tooltip opens on. */
export type TipPlacement = 'bottom' | 'top';

/**
 * An icon-only control whose label lives in a tooltip rather than beside it.
 *
 * The tooltip is portalled and `fixed` so it can escape the toolbar's own
 * clipping, and it reuses the `md-tooltip` surface the outline already uses —
 * `title` is deliberately avoided: it lags by a second and is styled by the OS.
 */
export function IconButton({
  icon,
  label,
  onClick,
  active = false,
  pressed,
  placement = 'bottom',
  tooltip = true,
  className = '',
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  /** Highlights the button as an engaged toggle. */
  active?: boolean;
  pressed?: boolean;
  /** `top` for buttons on the last row of the window, where below is off-screen. */
  placement?: TipPlacement;
  /** Self-explanatory controls opt out; `label` still names them for a11y. */
  tooltip?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [tip, setTip] = useState<TipPosition | null>(null);

  const show = (): boolean => {
    if (!tooltip) return false;
    const rect = ref.current?.getBoundingClientRect();
    if (rect === undefined) return false;
    setTip({
      top: placement === 'top' ? rect.top - 8 : rect.bottom + 8,
      left: rect.left + rect.width / 2,
    });
    return true;
  };

  const hide = () => {
    setTip(null);
  };

  const handlers = useTooltipTrigger(show, hide);

  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        // Acting on a control dismisses its tooltip; the pointer is done here.
        onClick={() => {
          handlers.onMouseLeave();
          onClick();
        }}
        {...handlers}
        className={`flex cursor-pointer items-center justify-center rounded-lg p-1.5 transition-colors ${
          active
            ? 'bg-[color-mix(in_oklab,var(--md-accent)_18%,transparent)] text-[var(--md-accent)]'
            : 'text-[var(--md-muted)] hover:bg-[var(--md-hover)] hover:text-[var(--md-fg)]'
        } ${className}`}
      >
        <Icon name={icon} className="size-4" />
      </button>

      {tip !== null &&
        createPortal(
          <div
            role="tooltip"
            style={{ top: tip.top, left: tip.left }}
            className={`md-fade-in md-tooltip pointer-events-none fixed z-50 -translate-x-1/2 rounded-lg px-2.5 py-1.5 text-[11px] leading-snug whitespace-nowrap ${
              placement === 'top' ? '-translate-y-full' : ''
            }`}
          >
            {label}
          </div>,
          document.body
        )}
    </>
  );
}
