/**
 * Recognises the two paragraphs a `<details>` block is parsed into.
 *
 * meowdown hands raw HTML blocks to `convertParagraph` — there is no html node
 * in its schema, only `htmlComment` — so `<details>` arrives as ordinary prose
 * with the tags showing. Lezer does split the block at every blank line, which
 * is what makes this tractable: the opening tag (with its `<summary>`, when
 * they share a block) and the closing tag land in top-level paragraphs of their
 * own, and everything between them is the body.
 *
 * Like `link-block.ts` this works on plain text rather than on the document
 * tree, so it stays testable without a browser.
 */

export interface DetailsOpen {
  kind: 'open';
  /** The `open` attribute — whether the markdown itself asks for it expanded. */
  open: boolean;
  /** Plain-text `<summary>`, or `null` when the block does not name one. */
  summary: string | null;
}

export interface DetailsClose {
  kind: 'close';
}

export type DetailsMarker = DetailsOpen | DetailsClose;

const CLOSE_TAG = /^<\/details\s*>$/i;
const OPEN_TAG = /^<details(\s[^>]*?)?\s*>/i;
const SUMMARY = /^<summary(?:\s[^>]*?)?\s*>([\s\S]*)<\/summary\s*>$/i;
/** `open`, `open=""`, `open="open"` — a boolean attribute in any of its forms. */
const OPEN_ATTR = /(?:^|\s)open(?:\s|=|$)/i;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Reduces `<summary>` markup to the text a collapsed header shows.
 *
 * `<b>`, `<code>` and friends are common inside a summary and carry no meaning
 * once the header is a plain label, so the tags go and their text stays.
 */
function toPlainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, ref: string) => {
      if (ref.startsWith('#')) {
        const code = ref.startsWith('#x') || ref.startsWith('#X')
          ? Number.parseInt(ref.slice(2), 16)
          : Number.parseInt(ref.slice(1), 10);
        return Number.isNaN(code) ? match : String.fromCodePoint(code);
      }
      return ENTITIES[ref.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Classifies a top-level paragraph's text.
 *
 * Returns `null` for anything that is not exactly one of the two markers,
 * which deliberately includes the shapes this cannot fold safely:
 *
 * - `<details><summary>x</summary>body</details>` on one line, where hiding the
 *   paragraph would hide the body with it;
 * - an opening block that swallowed prose because no blank line followed the
 *   summary, for the same reason.
 *
 * Those keep rendering as the plain paragraphs they already are — no worse than
 * today, and nothing of the reader's text disappears.
 */
export function detectDetailsMarker(text: string): DetailsMarker | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  if (CLOSE_TAG.test(trimmed)) return { kind: 'close' };

  const opening = OPEN_TAG.exec(trimmed);
  if (opening === null) return null;
  const open = OPEN_ATTR.test(opening[1] ?? '');

  const rest = trimmed.slice(opening[0].length).trim();
  if (rest === '') return { kind: 'open', open, summary: null };

  const summary = SUMMARY.exec(rest);
  if (summary === null) return null;
  const label = toPlainText(summary[1] ?? '');
  return { kind: 'open', open, summary: label === '' ? null : label };
}

export interface DetailsRegion {
  /**
   * Identity that survives editing and the formatter's write-back, so a block
   * the reader opened does not snap shut under them. Position cannot do it —
   * every keystroke above moves it — and the summary alone cannot either, since
   * a document may well repeat one; together they are stable enough, and the
   * cost of a collision is a block remembering the wrong open state.
   */
  key: string;
  /** Index of the top-level block holding the opening tag. */
  openIndex: number;
  /** Index of the block holding the matching `</details>`. */
  closeIndex: number;
  /** How many `<details>` enclose this one, for the body's indent. */
  depth: number;
  open: boolean;
  summary: string | null;
}

/**
 * Matches openers to closers across one document's top-level blocks.
 *
 * Unbalanced markers are dropped rather than guessed at: an opener with no
 * closer is what a half-typed block looks like, and folding it would swallow
 * the rest of the document, while a stray closer has nothing to fold. Both keep
 * rendering as the plain paragraphs they are today.
 *
 * The returned regions are ordered by their opening block, which is what makes
 * the index in `key` reproducible.
 */
export function pairDetails(markers: readonly (DetailsMarker | null)[]): DetailsRegion[] {
  const stack: { index: number; marker: DetailsOpen }[] = [];
  const found: Omit<DetailsRegion, 'key'>[] = [];

  markers.forEach((marker, index) => {
    if (marker === null) return;
    if (marker.kind === 'open') {
      stack.push({ index, marker });
      return;
    }
    const opener = stack.pop();
    if (opener === undefined) return;
    found.push({
      openIndex: opener.index,
      closeIndex: index,
      depth: stack.length,
      open: opener.marker.open,
      summary: opener.marker.summary,
    });
  });

  return found
    .sort((a, b) => a.openIndex - b.openIndex)
    .map((region, index) => ({ ...region, key: `${index}:${region.summary ?? ''}` }));
}
