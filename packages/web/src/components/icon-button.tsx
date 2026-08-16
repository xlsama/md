import type { IconName } from '../lib/icons.ts';
import { useAnchoredTooltip, type TipPlacement } from './anchored-tooltip.tsx';
import { Icon } from './icon.tsx';

export type { TipPlacement };

/**
 * An icon-only control whose label lives in a tooltip rather than beside it.
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
  const { ref, handlers, tip } = useAnchoredTooltip<HTMLButtonElement>({
    label,
    placement,
    enabled: tooltip,
  });

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

      {tip}
    </>
  );
}
