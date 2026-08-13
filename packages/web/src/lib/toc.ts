import { JUMP_GUTTER, type ScrollBox } from './scroll.ts';

export interface TocEntry {
  /** Heading level, 1-6. */
  level: number;
  /** Heading text with inline markdown syntax stripped. */
  text: string;
  /** 0-based index among all headings, matching DOM order in the editor. */
  index: number;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const ATX = /^(#{1,6})\s+(.*)$/;

function stripInline(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, label?: string) =>
      (label ?? target).trim()
    )
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*\*|___)(.+?)\1/g, '$2')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*#+\s*$/, '')
    .trim();
}

/**
 * Extracts the ATX heading outline of a markdown document.
 *
 * Fenced code blocks are skipped so that a `# comment` inside a shell snippet
 * never shows up in the outline. A leading `---` frontmatter block is skipped
 * too. Setext headings are intentionally not supported: meowdown always
 * serializes headings in ATX form.
 */
export function extractToc(markdown: string): TocEntry[] {
  const lines = markdown.split('\n');
  const entries: TocEntry[] = [];
  let fence: string | null = null;
  let start = 0;

  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
    if (end > 0) start = end + 1;
  }

  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch?.[1] !== undefined) {
      const marker = fenceMatch[1];
      if (fence === null) {
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        // A closing fence must use the same character and be at least as long,
        // so a ``` line inside a ```` block does not end it.
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue;

    const match = ATX.exec(line);
    if (match?.[1] === undefined) continue;
    const text = stripInline(match[2] ?? '');
    if (text === '') continue;
    entries.push({ level: match[1].length, text, index: entries.length });
  }

  return entries;
}

/**
 * Where the reading line sits below the top of the viewport. A heading counts
 * as reached once it crosses that line — slightly below where an outline jump
 * parks it, so the heading you just jumped to is the one that lights up.
 */
const READING_LINE = JUMP_GUTTER + 8;

/**
 * Which heading the reader is under, given each heading's offset from the top
 * of the document.
 *
 * The last heading to have crossed the reading line wins. Above the first one
 * the answer is still that first heading, so the outline is never left without
 * a mark; at the very bottom it is the last, which a final section shorter than
 * the viewport would otherwise never claim. `-1` only for a document with no
 * headings at all.
 */
export function activeHeading(tops: readonly number[], box: ScrollBox): number {
  if (tops.length === 0) return -1;
  const max = box.scrollHeight - box.clientHeight;
  if (max > 1 && box.scrollTop >= max - 1) return tops.length - 1;

  const line = box.scrollTop + READING_LINE;
  let active = 0;
  for (let i = 0; i < tops.length; i++) {
    if ((tops[i] ?? 0) > line) break;
    active = i;
  }
  return active;
}

/** Cheap equality check so the store can skip no-op TOC updates. */
export function sameToc(a: readonly TocEntry[], b: readonly TocEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, i) => entry.level === b[i]?.level && entry.text === b[i]?.text);
}
