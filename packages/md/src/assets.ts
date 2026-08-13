import fs from 'node:fs/promises';
import path from 'node:path';

export interface WebAssets {
  resolve: (rel: string) => Promise<string | null>;
}

// Populated only in single-file binaries: `scripts/gen-assets.ts` emits a module
// that imports every `web-dist` file with `type: 'file'` and registers the mapping
// here. Bun flattens and hashes those paths, so the original relative path is only
// recoverable through this table. Elsewhere (repo checkout, npm package) it stays
// empty and assets are read from disk.
let embedded: Record<string, string> | null = null;

export function setEmbeddedAssets(map: Record<string, string>): void {
  embedded = map;
}

export function webAssets(dist: string): WebAssets {
  const map = embedded;
  if (map) {
    return { resolve: async (rel) => map[rel] ?? null };
  }
  return {
    resolve: async (rel) => {
      const candidate = path.resolve(dist, rel);
      if (candidate !== dist && !candidate.startsWith(`${dist}${path.sep}`)) return null;
      const stat = await fs.stat(candidate).catch(() => null);
      return stat?.isFile() ? candidate : null;
    },
  };
}
