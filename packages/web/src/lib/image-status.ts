/**
 * Pure decision logic behind the editor's image placeholders.
 *
 * The DOM side lives in `src/image-loading.ts`; everything that is merely a
 * decision — «is this image still loading?», «have we seen this URL fail
 * before?» — is here so it can be unit-tested without a browser.
 */

export type ImageLoadState = 'loading' | 'loaded' | 'failed';

/** A settled outcome: the two states worth remembering across re-renders. */
export type ImageOutcome = Exclude<ImageLoadState, 'loading'>;

/** The bits of `HTMLImageElement` the classifier reads. */
export interface ImageProbe {
  /** Absolute URL the element points at, or `''` when it has no source yet. */
  src: string;
  complete: boolean;
  naturalWidth: number;
  /**
   * Whether an `error` event was seen *for this element, on the source it is
   * pointing at now*. See {@link isCurrentFailure}.
   */
  errored: boolean;
}

/**
 * Whether an `error` we saw still describes what the element is showing.
 *
 * An `<img>` can be pointed at more than one URL in quick succession — a
 * relative source being rewritten to its resolved form, a mark view rebuilt
 * onto a different document's directory — and the source it briefly held may
 * well 404. That error is real, but it is about a URL the reader was never
 * meant to see, so believing it paints the failure card over an image that is
 * about to load perfectly well: the flash of «加载失败» before the shimmer.
 *
 * Tying the verdict to the source that produced it means a rewrite silently
 * retires the old failure, and only an error on the current source counts.
 */
export function isCurrentFailure(erroredSrc: string | undefined, currentSrc: string): boolean {
  return erroredSrc !== undefined && erroredSrc !== '' && erroredSrc === currentSrc;
}

const DEFAULT_LIMIT = 256;

/**
 * Bounded per-URL memory of load outcomes.
 *
 * ProseMirror rebuilds an image's view whenever the document reparses, which
 * happens on ordinary keystrokes. Without this memory every rebuild would
 * restart the skeleton for images the browser already has, and a broken URL
 * would re-flash its placeholder. Eviction is insertion-ordered so a long
 * editing session cannot grow the map without bound.
 */
export class ImageOutcomeMemo {
  private readonly limit: number;
  private readonly entries = new Map<string, ImageOutcome>();

  constructor(limit: number = DEFAULT_LIMIT) {
    this.limit = Math.max(1, limit);
  }

  get size(): number {
    return this.entries.size;
  }

  get(src: string): ImageOutcome | undefined {
    return this.entries.get(src);
  }

  /** Records `outcome` for `src` and refreshes its place in the eviction queue. */
  record(src: string, outcome: ImageOutcome): void {
    if (src === '') return;
    this.entries.delete(src);
    this.entries.set(src, outcome);
    if (this.entries.size <= this.limit) return;
    const oldest = this.entries.keys().next();
    if (oldest.done !== true) this.entries.delete(oldest.value);
  }
}

/**
 * Bounded per-URL retry budget.
 *
 * A first `error` is not proof that a URL is broken: a freshly pasted document
 * often points at images the far end is still producing (Feishu's `asynccode`
 * endpoints answer the first request with a failure and the retry with the
 * picture), and a flaky network fails once and then works. Painting the
 * failure card on that first error is exactly the flash being fixed here — so
 * an error only becomes a verdict once the URL has used up its retries.
 *
 * The budget is keyed by URL rather than element on purpose: mark views are
 * rebuilt constantly, and a per-element count would reset with every rebuild
 * and retry forever. Bounded the same way as {@link ImageOutcomeMemo}.
 */
export class RetryBudget {
  private readonly max: number;
  private readonly limit: number;
  private readonly attempts = new Map<string, number>();

  constructor(max: number, limit: number = DEFAULT_LIMIT) {
    this.max = max;
    this.limit = Math.max(1, limit);
  }

  /**
   * Spends one attempt for `src`. Answers the attempt number (1-based) while
   * the budget lasts, and `null` once it is spent — at which point the failure
   * is worth believing.
   */
  take(src: string): number | null {
    if (src === '') return null;
    const used = this.attempts.get(src) ?? 0;
    if (used >= this.max) return null;
    this.attempts.delete(src);
    this.attempts.set(src, used + 1);
    if (this.attempts.size > this.limit) {
      const oldest = this.attempts.keys().next();
      if (oldest.done !== true) this.attempts.delete(oldest.value);
    }
    return used + 1;
  }
}

/**
 * Which placeholder (if any) an `<img>` should be showing right now.
 *
 * Live pixels win over everything: `complete` with a non-zero `naturalWidth`
 * means the browser is already painting the image, so a stale `failed` memo
 * must not hide it. Then a confirmed error on this element's *current* source,
 * then a remembered outcome for the same URL — which is what lets an element
 * rebuilt for a picture the browser already has skip the skeleton.
 *
 * Everything else is `loading`, and that is the important half of the rule: a
 * source nobody has watched fail starts as a shimmer and stays one until it
 * either paints or errors. `complete` alone is not evidence of failure — an
 * element can report it in the gap between two sources — and treating it as
 * such is what made a freshly pasted image flash its failure card first.
 */
export function classifyImage(probe: ImageProbe, memo: ImageOutcomeMemo): ImageLoadState {
  if (probe.complete && probe.naturalWidth > 0) return 'loaded';
  if (probe.errored) return 'failed';
  return memo.get(probe.src) ?? 'loading';
}
