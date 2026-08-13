import { useEffect, useRef, useState } from 'react';
import { basename, dirname, join, withMarkdownExtension } from '../lib/paths.ts';
import { session } from '../session.ts';
import { useStore, type Dialog } from '../store.ts';

function Shell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 pt-[18vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="md-fade-in w-[min(26rem,90vw)] rounded-2xl border border-[var(--md-border)] bg-[var(--md-panel)] p-4 shadow-xl">
        {children}
      </div>
    </div>
  );
}

function Actions({
  confirmLabel,
  danger = false,
  onCancel,
  disabled = false,
}: {
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="mt-4 flex justify-end gap-2">
      <button
        type="button"
        onClick={onCancel}
        className="cursor-pointer rounded-lg px-3 py-1.5 text-xs ring-1 ring-[var(--md-border)] transition-colors hover:bg-[var(--md-hover)]"
      >
        取消
      </button>
      <button
        type="submit"
        disabled={disabled}
        className={`cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 ${
          danger ? 'bg-red-600' : 'bg-[var(--md-accent)]'
        }`}
      >
        {confirmLabel}
      </button>
    </div>
  );
}

function NameForm({
  title,
  hint,
  initial,
  confirmLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  hint: string;
  initial: string;
  confirmLabel: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const node = input.current;
    if (node === null) return;
    node.focus();
    const dot = initial.lastIndexOf('.');
    node.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  return (
    <Shell onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = value.trim();
          if (trimmed === '') return;
          onSubmit(trimmed);
          onClose();
        }}
      >
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="mt-1 text-xs text-[var(--md-muted)]">{hint}</p>
        <input
          ref={input}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
          }}
          className="mt-3 w-full rounded-lg bg-[var(--md-bg)] px-2.5 py-1.5 text-sm ring-1 ring-[var(--md-border)] outline-none focus:ring-[var(--md-accent)]"
        />
        <Actions confirmLabel={confirmLabel} onCancel={onClose} disabled={value.trim() === ''} />
      </form>
    </Shell>
  );
}

function DeleteForm({ dialog, onClose }: { dialog: Dialog & { kind: 'delete' }; onClose: () => void }) {
  return (
    <Shell onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          session.remove(dialog.path);
          onClose();
        }}
      >
        <h2 className="text-sm font-medium">移到废纸篓</h2>
        <p className="mt-1 text-xs text-[var(--md-muted)]">
          {dialog.isDir ? '文件夹' : '文件'}「{basename(dialog.path)}」
          将被移到系统废纸篓，可以从废纸篓恢复。
        </p>
        <Actions confirmLabel="移到废纸篓" danger onCancel={onClose} />
      </form>
    </Shell>
  );
}

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  const setDialog = useStore((s) => s.setDialog);
  if (dialog === null) return null;

  const close = () => {
    setDialog(null);
  };

  if (dialog.kind === 'delete') return <DeleteForm dialog={dialog} onClose={close} />;

  return (
    <NameForm
      title="重命名"
      hint={dirname(dialog.path) === '' ? '工作区根目录' : `${dirname(dialog.path)}/`}
      initial={basename(dialog.path)}
      confirmLabel="重命名"
      onClose={close}
      onSubmit={(name) => {
        const finalName = dialog.isDir ? name : withMarkdownExtension(name);
        session.rename(dialog.path, join(dirname(dialog.path), finalName));
      }}
    />
  );
}
