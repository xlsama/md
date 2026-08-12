import type { EditorMode } from '@meowdown/react';
import { basename, dirname } from '../lib/paths.ts';
import { useStore, type SaveState } from '../store.ts';

const MODES: { value: EditorMode; label: string; title: string }[] = [
  { value: 'focus', label: '专注', title: '语法只在光标处显现' },
  { value: 'show', label: '显示', title: '始终显示 Markdown 语法' },
  { value: 'hide', label: '隐藏', title: '完全隐藏 Markdown 语法' },
];

const SAVE_LABEL: Record<SaveState, string> = {
  idle: '已同步',
  dirty: '未保存',
  saving: '保存中',
  saved: '已保存',
  error: '保存失败',
};

const SAVE_COLOR: Record<SaveState, string> = {
  idle: 'bg-[var(--md-muted)]/40',
  dirty: 'bg-amber-500',
  saving: 'bg-sky-500 animate-pulse',
  saved: 'bg-emerald-500',
  error: 'bg-red-500',
};

function SaveDot() {
  const saveState = useStore((s) => s.saveState);
  const docPath = useStore((s) => s.docPath);
  if (docPath === null) return null;
  return (
    <span
      className="flex items-center gap-1.5 text-xs text-[var(--md-muted)]"
      title={SAVE_LABEL[saveState]}
    >
      <span className={`size-1.5 rounded-full ${SAVE_COLOR[saveState]}`} />
      {SAVE_LABEL[saveState]}
    </span>
  );
}

export function TopBar() {
  const docPath = useStore((s) => s.docPath);
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const tocOpen = useStore((s) => s.tocOpen);
  const toggleToc = useStore((s) => s.toggleToc);
  const connected = useStore((s) => s.connected);

  const dir = docPath === null ? '' : dirname(docPath);

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--md-border)] px-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {docPath === null ? (
          <span className="truncate text-sm text-[var(--md-muted)]">未打开文件</span>
        ) : (
          <>
            {dir !== '' && (
              <span className="hidden truncate text-xs text-[var(--md-muted)] sm:inline">
                {dir}/
              </span>
            )}
            <span className="truncate text-sm font-medium">{basename(docPath)}</span>
          </>
        )}
        <SaveDot />
      </div>

      <div
        role="radiogroup"
        aria-label="编辑器模式"
        className="flex items-center gap-0.5 rounded-full bg-[var(--md-panel)] p-0.5 ring-1 ring-[var(--md-border)]"
      >
        {MODES.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={mode === option.value}
            title={option.title}
            onClick={() => {
              setMode(option.value);
            }}
            className={`cursor-pointer rounded-full px-2.5 py-1 text-xs transition-colors ${
              mode === option.value
                ? 'bg-[var(--md-bg)] font-medium text-[var(--md-fg)] shadow-sm'
                : 'text-[var(--md-muted)] hover:text-[var(--md-fg)]'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={toggleToc}
        title={tocOpen ? '隐藏大纲' : '显示大纲'}
        aria-pressed={tocOpen}
        className={`cursor-pointer rounded-lg px-2 py-1 text-xs ring-1 ring-[var(--md-border)] transition-colors hover:bg-[var(--md-hover)] ${
          tocOpen ? 'text-[var(--md-fg)]' : 'text-[var(--md-muted)]'
        }`}
      >
        大纲
      </button>

      <span
        title={connected ? '已连接到本地服务' : '连接已断开，正在重连…'}
        aria-label={connected ? '已连接' : '未连接'}
        className={`block size-2 shrink-0 rounded-full ${
          connected ? 'bg-emerald-500' : 'animate-pulse bg-red-500'
        }`}
      />
    </header>
  );
}
