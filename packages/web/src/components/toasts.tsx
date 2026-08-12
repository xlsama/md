import { useEffect } from 'react';
import { useStore } from '../store.ts';

const TTL = 4000;

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);

  useEffect(() => {
    const timers = toasts.map((toast) =>
      setTimeout(() => {
        dismiss(toast.id);
      }, TTL)
    );
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [toasts, dismiss]);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          onClick={() => {
            dismiss(toast.id);
          }}
          className={`md-fade-in pointer-events-auto max-w-[80vw] cursor-pointer truncate rounded-full px-4 py-2 text-xs shadow-lg ring-1 ${
            toast.kind === 'error'
              ? 'bg-red-600 text-white ring-red-700/40'
              : 'bg-[var(--md-panel)] text-[var(--md-fg)] ring-[var(--md-border)]'
          }`}
        >
          {toast.message}
        </button>
      ))}
    </div>
  );
}
