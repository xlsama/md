import { parseDiffFromFile } from '@pierre/diffs';
import { FileDiff } from '@pierre/diffs/react';
import { useMemo } from 'react';
import type { ConflictState } from '../store.ts';

/**
 * The side-by-side view inside the conflict banner.
 *
 * It lives in its own module — and is the module's default export — so the
 * banner can reach it through `lazy(() => import(…))`. `@pierre/diffs` pulls in
 * a syntax highlighter and its own diff engine, which together are one of the
 * largest things the app can load; keeping them out of the first-paint bundle
 * matters because most sessions never hit a conflict at all, and the ones that
 * do are already waiting on the reader to press "查看对比".
 */
export default function ConflictDiff({ conflict }: { conflict: ConflictState }) {
  const fileDiff = useMemo(
    () =>
      parseDiffFromFile(
        {
          name: conflict.path,
          contents: conflict.diskContent,
          cacheKey: `disk:${conflict.diskHash}`,
        },
        { name: conflict.path, contents: conflict.mine }
      ),
    [conflict]
  );

  return (
    <div className="max-h-[45vh] overflow-auto rounded-xl border border-[var(--md-border)]">
      <FileDiff
        fileDiff={fileDiff}
        disableWorkerPool
        options={{
          diffStyle: 'split',
          themeType: 'system',
          theme: { light: 'github-light', dark: 'github-dark' },
          overflow: 'wrap',
          disableFileHeader: true,
          hunkSeparators: 'simple',
        }}
      />
    </div>
  );
}
