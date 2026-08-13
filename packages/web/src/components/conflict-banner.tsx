import { lazy, Suspense, useState } from 'react';
import { basename } from '../lib/paths.ts';
import { session } from '../session.ts';
import { useStore } from '../store.ts';

/** Loaded the first time someone expands a conflict — see `conflict-diff.tsx`. */
const ConflictDiff = lazy(() => import('./conflict-diff.tsx'));

function DiffFallback() {
  return (
    <div className="grid h-24 place-items-center rounded-xl border border-[var(--md-border)] text-xs text-[var(--md-muted)]">
      正在加载对比…
    </div>
  );
}

export function ConflictBanner() {
  const conflict = useStore((s) => s.conflict);
  const [expanded, setExpanded] = useState(false);
  if (conflict === null) return null;

  return (
    <div className="md-fade-in shrink-0 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 text-xs">
          <span className="font-medium">{basename(conflict.path)}</span>
          <span className="text-[var(--md-muted)]"> 在磁盘上被改动了，而你这里有未保存的修改。</span>
        </p>
        <button
          type="button"
          onClick={() => {
            setExpanded((value) => !value);
          }}
          className="cursor-pointer rounded-lg px-2 py-1 text-xs ring-1 ring-[var(--md-border)] transition-colors hover:bg-[var(--md-hover)]"
        >
          {expanded ? '收起对比' : '查看对比'}
        </button>
        <button
          type="button"
          onClick={() => {
            setExpanded(false);
            session.useDisk();
          }}
          className="cursor-pointer rounded-lg px-2 py-1 text-xs ring-1 ring-[var(--md-border)] transition-colors hover:bg-[var(--md-hover)]"
        >
          用磁盘版
        </button>
        <button
          type="button"
          onClick={() => {
            setExpanded(false);
            session.keepMine();
          }}
          className="cursor-pointer rounded-lg bg-[var(--md-accent)] px-2 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90"
        >
          保留我的
        </button>
      </div>

      {expanded && (
        <div className="mt-2.5">
          <div className="flex gap-4 pb-1.5 text-[11px] text-[var(--md-muted)]">
            <span className="flex-1">左：磁盘版本</span>
            <span className="flex-1">右：我的版本</span>
          </div>
          <Suspense fallback={<DiffFallback />}>
            <ConflictDiff conflict={conflict} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
