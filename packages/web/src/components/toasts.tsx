import { useEffect } from 'react';
import { useStore, type Toast } from '../store.ts';

const TTL = 4000;

/**
 * One toast, owning the timer that retires it.
 *
 * The timer belongs to the row rather than to the list because the list is a
 * new array on every push: a shared effect keyed on it would restart every
 * timer each time a toast arrived, so a stack of them would only ever expire
 * `TTL` after the *last* one — the first would sit there far longer than the
 * four seconds it was promised.
 */
function ToastRow({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const { id } = toast;
  useEffect(() => {
    const timer = setTimeout(() => {
      onDismiss(id);
    }, TTL);
    return () => {
      clearTimeout(timer);
    };
  }, [id, onDismiss]);

  return (
    <button
      type="button"
      onClick={() => {
        onDismiss(id);
      }}
      className={`md-fade-in pointer-events-auto max-w-[80vw] cursor-pointer truncate rounded-full px-4 py-2 text-xs shadow-lg ring-1 ${
        toast.kind === 'error'
          ? 'bg-red-600 text-white ring-red-700/40'
          : 'bg-[var(--md-panel)] text-[var(--md-fg)] ring-[var(--md-border)]'
      }`}
    >
      {toast.message}
    </button>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} onDismiss={dismiss} />
      ))}
    </div>
  );
}
