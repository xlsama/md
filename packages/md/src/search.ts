import path from 'node:path';
import type { SearchHit } from './protocol.ts';
import { relativeInRoot } from './files.ts';

export class RipgrepMissingError extends Error {
  constructor() {
    super('ripgrep (rg) not found in PATH — install it to enable full-text search');
    this.name = 'RipgrepMissingError';
  }
}

let cachedRgPath: string | null | undefined;

export function rgPath(): string | null {
  if (cachedRgPath === undefined) cachedRgPath = Bun.which('rg');
  return cachedRgPath ?? null;
}

export function hasRipgrep(): boolean {
  return rgPath() !== null;
}

const PREVIEW_LIMIT = 240;

function byteColumnToCharColumn(lineText: string, byteOffset: number): number {
  if (byteOffset <= 0) return 1;
  const bytes = Buffer.from(lineText, 'utf8');
  const prefix = bytes.subarray(0, Math.min(byteOffset, bytes.length)).toString('utf8');
  return prefix.length + 1;
}

interface RgMatchData {
  path?: { text?: string };
  lines?: { text?: string };
  line_number?: number;
  submatches?: { start?: number }[];
}

export async function search(root: string, query: string, limit = 200): Promise<SearchHit[]> {
  const rg = rgPath();
  if (!rg) throw new RipgrepMissingError();
  const trimmed = query.trim();
  if (!trimmed) return [];

  const proc = Bun.spawn({
    cmd: [
      rg,
      '--json',
      '--fixed-strings',
      '--smart-case',
      '--no-ignore',
      '--no-messages',
      '--max-count',
      '20',
      '--max-columns',
      '2000',
      '--glob',
      '*.md',
      '--glob',
      '*.markdown',
      '--glob',
      '!node_modules/**',
      '--glob',
      '!.*/**',
      '--',
      trimmed,
      root,
    ],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  const hits: SearchHit[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    if (hits.length >= limit) break;
    let parsed: { type?: string; data?: RgMatchData };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type !== 'match' || !parsed.data) continue;
    const data = parsed.data;
    const abs = data.path?.text;
    if (!abs) continue;
    const lineText = data.lines?.text ?? '';
    const start = data.submatches?.[0]?.start ?? 0;
    hits.push({
      path: relativeInRoot(root, path.resolve(root, abs)),
      line: data.line_number ?? 1,
      column: byteColumnToCharColumn(lineText, start),
      preview: lineText.replace(/\r?\n$/, '').slice(0, PREVIEW_LIMIT),
    });
  }
  return hits;
}
