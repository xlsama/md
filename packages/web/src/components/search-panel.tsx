import { useEffect, useRef } from 'react';
import { basename } from '../lib/paths.ts';
import { session } from '../session.ts';
import { useStore } from '../store.ts';

const DEBOUNCE = 300;

export function SearchPanel() {
  const query = useStore((s) => s.searchQuery);
  const results = useStore((s) => s.searchResults);
  const searching = useStore((s) => s.searching);
  const ripgrep = useStore((s) => s.ripgrep);
  const setSearchQuery = useStore((s) => s.setSearchQuery);
  const setSearching = useStore((s) => s.setSearching);
  const setEditorQuery = useStore((s) => s.setEditorQuery);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    const trimmed = query.trim();
    if (trimmed === '') {
      useStore.getState().setSearchResults(query, []);
      setSearching(false);
    } else {
      setSearching(true);
      timer.current = setTimeout(() => {
        session.search(trimmed);
      }, DEBOUNCE);
    }
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [query, setSearching]);

  const open = query.trim() !== '';

  return (
    <div className="shrink-0 border-b border-[var(--md-border)] px-3 pb-2">
      <input
        type="search"
        value={query}
        disabled={!ripgrep}
        placeholder={ripgrep ? '全文搜索…' : '未检测到 ripgrep'}
        title={ripgrep ? undefined : '搜索需要系统安装 rg（ripgrep）'}
        onChange={(event) => {
          setSearchQuery(event.target.value);
        }}
        className="w-full rounded-lg bg-[var(--md-bg)] px-2.5 py-1.5 text-xs ring-1 ring-[var(--md-border)] outline-none placeholder:text-[var(--md-muted)] focus:ring-[var(--md-accent)] disabled:cursor-not-allowed disabled:opacity-50"
      />

      {open && (
        <div className="mt-2 max-h-64 overflow-y-auto">
          {searching && results.length === 0 && (
            <p className="px-1 py-2 text-xs text-[var(--md-muted)]">搜索中…</p>
          )}
          {!searching && results.length === 0 && (
            <p className="px-1 py-2 text-xs text-[var(--md-muted)]">没有匹配结果</p>
          )}
          {results.map((hit) => (
            <button
              key={`${hit.path}:${String(hit.line)}:${String(hit.column)}`}
              type="button"
              onClick={() => {
                setEditorQuery(query.trim());
                session.open(hit.path);
              }}
              className="w-full cursor-pointer rounded-md px-1.5 py-1 text-left transition-colors hover:bg-[var(--md-hover)]"
            >
              <span className="block truncate text-xs font-medium">{basename(hit.path)}</span>
              <span className="block truncate text-[11px] text-[var(--md-muted)]">
                {hit.line}: {hit.preview.trim()}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
