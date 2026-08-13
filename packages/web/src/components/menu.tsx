import { useEffect, useRef } from 'react';
import type { IconName } from '../lib/icons.ts';
import { Icon } from './icon.tsx';

/** Shared surface for the sidebar dropdown and the file tree's context menu. */
export function MenuSurface({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="menu"
      className={`md-fade-in md-menu min-w-44 rounded-xl border border-[var(--md-menu-border)] bg-[var(--md-menu-bg)] p-1 ${className}`}
    >
      {children}
    </div>
  );
}

export function MenuItem({
  icon,
  label,
  onClick,
  danger = false,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-[var(--md-menu-hover)] ${
        danger ? 'text-red-500' : 'text-[var(--md-fg)]'
      }`}
    >
      <Icon name={icon} className="size-4 shrink-0 opacity-70" />
      <span className="truncate">{label}</span>
    </button>
  );
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-[var(--md-menu-border)]" />;
}

/**
 * Closes on a click anywhere outside `ref` and on Escape. The pointer listener
 * runs in the capture phase so a click that lands on another interactive
 * element still dismisses the menu first.
 */
export function useDismiss<T extends HTMLElement = HTMLDivElement>(
  open: boolean,
  close: () => void
) {
  const ref = useRef<T>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const node = ref.current;
      if (node !== null && event.target instanceof Node && node.contains(event.target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    if (open) {
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('keydown', onKeyDown);
    }
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  return ref;
}

