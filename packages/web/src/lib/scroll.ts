/**
 * The editor's scroll container is the one the reader actually scrolls — the
 * window never moves — so it is the element the router's scroll cache tracks.
 * The id gives it a stable selector: without one the cache would key it by its
 * `nth-child` path, which the sidebar and the conflict banner can change.
 */
export const EDITOR_SCROLL_ID = 'md-editor';

export const EDITOR_SCROLL_SELECTOR = `[data-scroll-restoration-id="${EDITOR_SCROLL_ID}"]`;

/**
 * How long a restored offset keeps being re-asserted, in animation frames.
 *
 * A document does not reach its final height the moment it is parsed: images,
 * link cards and highlighted code all land later, and meowdown scrolls the
 * (start-of-document) selection into view of its own accord. Re-asserting for
 * about half a second outlives all of that.
 */
const SETTLE_FRAMES = 30;

/** Anything the reader does with the container hands the scroll back to them. */
const ABORT_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/**
 * How long an outline jump takes.
 *
 * Deliberately not `scrollIntoView({ behavior: 'smooth' })`: the native
 * animation slows down the further it has to travel, so jumping to the end of a
 * long document drifts for the better part of a second. A fixed, short duration
 * reads as "one motion" no matter the distance.
 */
const JUMP_MS = 180;

/** A gap above the heading, so it does not sit flush against the top edge. */
export const JUMP_GUTTER = 16;

/**
 * One scroll driver per container: a second one takes over from the first
 * rather than the two fighting frame by frame — an outline jump during the
 * half second a restore is still settling, for instance.
 */
const drivers = new WeakMap<HTMLElement, () => void>();

function noop(): void {
  // Nothing to release, nothing to cancel.
}

function claim(el: HTMLElement, stop: () => void): () => void {
  drivers.get(el)?.();
  drivers.set(el, stop);
  return () => {
    if (drivers.get(el) === stop) drivers.delete(el);
  };
}

function watchUser(el: HTMLElement, stop: () => void, on: boolean): void {
  for (const event of ABORT_EVENTS) {
    if (on) el.addEventListener(event, stop, { passive: true });
    else el.removeEventListener(event, stop);
  }
}

export function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

/** Where the tween sits `elapsed` ms in; exactly `to` once the time is up. */
export function tweenScrollTop(
  from: number,
  to: number,
  elapsed: number,
  duration = JUMP_MS
): number {
  if (elapsed >= duration || duration <= 0) return to;
  return from + (to - from) * easeOut(Math.max(elapsed, 0) / duration);
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Scrolls `el` to `target` over a fixed, short span, and gets out of the way
 * the moment the reader touches the container themselves.
 */
export function jumpScrollTop(el: HTMLElement, target: number): void {
  const to = Math.max(0, Math.min(target, el.scrollHeight - el.clientHeight));
  const from = el.scrollTop;
  if (reducedMotion() || Math.abs(to - from) < 2) {
    drivers.get(el)?.();
    el.scrollTop = to;
    return;
  }

  let raf = 0;
  let release: () => void = noop;
  const stop = (): void => {
    cancelAnimationFrame(raf);
    watchUser(el, stop, false);
    release();
  };
  release = claim(el, stop);

  const started = performance.now();
  const tick = (now: number): void => {
    const elapsed = now - started;
    el.scrollTop = tweenScrollTop(from, to, elapsed);
    if (elapsed >= JUMP_MS) {
      stop();
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  watchUser(el, stop, true);
  raf = requestAnimationFrame(tick);
}

export interface ScrollBox {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Whether the container still has to be nudged to sit at `target`.
 *
 * A target beyond the current content is compared against where it would clamp,
 * so a document that is genuinely shorter than it used to be settles at its own
 * end instead of being nudged forever. One pixel of slack absorbs the
 * fractional scroll offsets a zoomed page produces.
 */
export function offTarget(box: ScrollBox, target: number): boolean {
  if (target <= 0) return false;
  const reachable = Math.min(target, Math.max(0, box.scrollHeight - box.clientHeight));
  return Math.abs(box.scrollTop - reachable) > 1;
}

/**
 * Puts `el` back at `target` and keeps it there while the document settles.
 * Returns a canceller; it is also called for you when the reader scrolls.
 */
export function restoreScrollTop(el: HTMLElement, target: number): () => void {
  // A document switch outranks whatever was moving the previous one.
  drivers.get(el)?.();
  el.scrollTop = target;
  if (target <= 0) return noop;

  let frames = SETTLE_FRAMES;
  let raf = 0;
  let release: () => void = noop;
  const stop = (): void => {
    cancelAnimationFrame(raf);
    watchUser(el, stop, false);
    release();
  };
  release = claim(el, stop);

  const tick = (): void => {
    if (offTarget(el, target)) el.scrollTop = target;
    frames -= 1;
    if (frames <= 0) {
      stop();
      return;
    }
    raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);
  watchUser(el, stop, true);
  return stop;
}
