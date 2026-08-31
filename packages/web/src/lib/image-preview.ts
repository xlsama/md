/**
 * Pure geometry behind the image lightbox.
 *
 * The DOM side lives in `src/components/image-preview.tsx`; everything that is
 * merely arithmetic — «how big does this picture start out?», «where does the
 * point under the cursor end up after a zoom?» — is here so it can be
 * unit-tested without a browser.
 *
 * One model underlies all of it: the picture is drawn at its natural pixel
 * size with its centre on the stage's centre, and then transformed by
 * `scale` about that centre followed by a `(x, y)` translation. A point `p`
 * measured from the picture's centre therefore lands on the stage at
 * `stageCentre + p * scale + (x, y)`, and every function below is a
 * consequence of that one line.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** `translate(x, y) scale(scale)` about the stage centre. */
export interface Transform extends Point {
  scale: number;
}

/** Below this the picture is a speck; above it, a wall of pixels. */
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8;

/** What one press of the toolbar's `−` / `+` is worth. */
export const ZOOM_STEP = 1.25;

/**
 * How much of a wheel notch becomes zoom.
 *
 * Exponential rather than additive so a notch is worth the same *proportion*
 * at every magnification — the alternative crawls when zoomed out and lurches
 * when zoomed in.
 */
const WHEEL_SENSITIVITY = 0.0022;

/** Pixels a `deltaMode` of lines / pages stands for. */
const LINE_PIXELS = 16;
const PAGE_PIXELS = 400;

/**
 * A trackpad pinch arrives as a wheel event with the platform's zoom modifier
 * set, in much smaller increments — the same sensitivity would make the
 * gesture feel dead, so it gets its own.
 */
const PINCH_SENSITIVITY = 0.01;

/**
 * A single event is capped before it becomes zoom: some mice report one
 * enormous delta per notch, and an uncapped exponent turns that into a jump
 * from «fits the window» to «one pixel fills the screen».
 */
const MAX_WHEEL_PIXELS = 220;
const MAX_PINCH_PIXELS = 48;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Whether a source has no native resolution to respect.
 *
 * A vector picture is drawn at whatever size it is given, so «actual size» is
 * an accident of how the file was authored — a 1060-wide diagram in a
 * 1600-wide window is not «already as big as it should be», it is small. A
 * raster picture is the opposite: past its own pixels there is nothing left to
 * show but interpolation.
 */
export function isVectorSource(src: string): boolean {
  const path = (src.split(/[?#]/)[0] ?? '').toLowerCase();
  return path.endsWith('.svg') || path.startsWith('data:image/svg+xml');
}

/**
 * The scale at which the picture fills the space it is given.
 *
 * Capped at 1 unless the source is vector: a 48px icon blown up to fill the
 * window is a mess of interpolation, and nobody opened a lightbox to see that.
 */
export function fitScale(image: Size, area: Size, upscale = false): number {
  if (image.width <= 0 || image.height <= 0) return 1;
  if (area.width <= 0 || area.height <= 0) return 1;
  const cover = Math.min(area.width / image.width, area.height / image.height);
  return upscale ? Math.min(MAX_SCALE, cover) : Math.min(1, cover);
}

/**
 * Keeps a scale inside the usable range.
 *
 * `fit` is the floor rather than {@link MIN_SCALE} when a picture is so much
 * larger than the window that fitting it already means going below the floor —
 * a wall-sized diagram must still be allowed to fit.
 */
export function clampScale(scale: number, fit: number): number {
  return clamp(scale, Math.min(MIN_SCALE, fit), MAX_SCALE);
}

/** The starting view: fitted, centred, untouched. */
export function fitTransform(fit: number): Transform {
  return { scale: fit, x: 0, y: 0 };
}

/**
 * Turns one wheel event into the factor its notch is worth.
 *
 * `pinch` is for the trackpad gesture the browser reports as a modified wheel;
 * it is a different input with a different scale, not a louder version of the
 * same one.
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0, pinch = false): number {
  const perUnit = deltaMode === 1 ? LINE_PIXELS : deltaMode === 2 ? PAGE_PIXELS : 1;
  const cap = pinch ? MAX_PINCH_PIXELS : MAX_WHEEL_PIXELS;
  const pixels = clamp(deltaY * perUnit, -cap, cap);
  return Math.exp(-pixels * (pinch ? PINCH_SENSITIVITY : WHEEL_SENSITIVITY));
}

/**
 * Zooms by `factor` while pinning the picture point under `anchor`.
 *
 * This is the whole difference between a lightbox that feels like a map and
 * one that feels like a slideshow: the pixel you are pointing at is the pixel
 * that stays put, so zooming into a corner of a diagram needs no panning
 * afterwards. `anchor` is in stage coordinates (origin at the stage's
 * top-left).
 */
export function zoomAt(
  transform: Transform,
  factor: number,
  anchor: Point,
  stage: Size,
  fit: number
): Transform {
  const scale = clampScale(transform.scale * factor, fit);
  // A clamped scale means the effective factor is not the requested one, and
  // the anchor has to be held against what actually happened.
  const applied = transform.scale === 0 ? 1 : scale / transform.scale;
  const dx = anchor.x - stage.width / 2;
  const dy = anchor.y - stage.height / 2;
  return {
    scale,
    x: dx * (1 - applied) + transform.x * applied,
    y: dy * (1 - applied) + transform.y * applied,
  };
}

/** Whether the picture is currently bigger than the stage on either axis. */
export function isPannable(image: Size, stage: Size, scale: number): boolean {
  return image.width * scale > stage.width + 1 || image.height * scale > stage.height + 1;
}

/**
 * Keeps the picture from being dragged out of the window.
 *
 * An axis the picture does not overflow is pinned to the centre rather than
 * merely bounded, so a fitted picture cannot be nudged off-centre at all and
 * zooming back out always lands square in the middle.
 */
export function clampPan(transform: Transform, image: Size, stage: Size): Transform {
  const limit = panLimits(image, stage, transform.scale);
  return {
    scale: transform.scale,
    x: clampAxis(transform.x, limit.x),
    y: clampAxis(transform.y, limit.y),
  };
}

/** An axis with no overflow to spend is centred, not merely bounded. */
function clampAxis(offset: number, limit: number): number {
  return limit <= 0 ? 0 : clamp(offset, -limit, limit);
}

/** Scales within this of each other count as the same view. */
const SCALE_EPSILON = 1e-3;

export function isFitted(scale: number, fit: number): boolean {
  return Math.abs(scale - fit) < SCALE_EPSILON;
}

/**
 * Where a double-click goes.
 *
 * Away from the fitted view it always returns to it — the reader is done
 * inspecting. From the fitted view it goes to actual pixels, except when that
 * would be no move at all (a picture already at or above 1:1), where doubling
 * is what was meant.
 */
export function toggledScale(scale: number, fit: number): number {
  if (!isFitted(scale, fit)) return fit;
  return clampScale(isFitted(fit, 1) || fit > 1 ? fit * 2 : 1, fit);
}

/** Wraps around, so the last picture's `→` is the first. */
export function stepIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((index + delta) % length) + length) % length;
}

/** What the toolbar reports: the true pixel ratio, not a fraction of the fit. */
export function scalePercent(scale: number): number {
  return Math.max(1, Math.round(scale * 100));
}

// ------------------------------------------------------------------ motion
//
// Everything below exists to make the view *move* rather than jump. Three
// mechanisms, each with one job:
//
// - A tween for anything the reader asked for by name — a button, a key, a
//   double-click. Those are decisions, not gestures, and a decision that
//   teleports the picture leaves the reader looking for where it went.
// - Rubber-banding while a drag is past the edge, so the boundary is felt
//   before it is hit instead of the picture simply going dead under the
//   finger.
// - A glide after the drag ends, so a flick keeps going and settles, the way
//   every other scrollable surface on the machine behaves.

/** How long a named move takes. Long enough to read, short enough not to wait. */
export const TWEEN_MS = 220;

/** Fast out of the gate, soft on arrival. */
export function easeOutCubic(t: number): number {
  const u = 1 - clamp(t, 0, 1);
  return 1 - u * u * u;
}

/**
 * The view a fraction `t` of the way from `from` to `to`.
 *
 * Scale is interpolated geometrically — halfway between 1× and 4× is 2×, not
 * 2.5× — because magnification is perceived as a ratio. Linear interpolation
 * of it is the difference between a zoom that reads as steady and one that
 * lunges at the start.
 */
export function interpolate(from: Transform, to: Transform, t: number): Transform {
  const e = clamp(t, 0, 1);
  return {
    scale: from.scale * (to.scale / from.scale) ** e,
    x: from.x + (to.x - from.x) * e,
    y: from.y + (to.y - from.y) * e,
  };
}

/** How far the view may be panned on each axis before it is off the picture. */
export function panLimits(image: Size, stage: Size, scale: number): Point {
  return {
    x: Math.max(0, (image.width * scale - stage.width) / 2),
    y: Math.max(0, (image.height * scale - stage.height) / 2),
  };
}

/** How much of the stage a drag can steal past the edge, at the limit. */
const RUBBER = 0.35;

/**
 * Resistance past the edge.
 *
 * Within the bounds the drag is one-to-one. Past them each further pixel of
 * travel buys less and less, approaching `RUBBER` of the stage and never
 * reaching it — so the edge announces itself through the hand rather than by
 * the picture suddenly refusing to move.
 */
export function rubberBand(offset: number, limit: number, extent: number): number {
  const over = Math.abs(offset) - limit;
  if (over <= 0) return offset;
  const give = extent * RUBBER;
  return Math.sign(offset) * (limit + (over * give) / (over + give));
}

/** {@link clampPan}'s forgiving cousin, for the length of a drag. */
export function rubberPan(transform: Transform, image: Size, stage: Size): Transform {
  const limit = panLimits(image, stage, transform.scale);
  return {
    scale: transform.scale,
    x: rubberBand(transform.x, limit.x, stage.width),
    y: rubberBand(transform.y, limit.y, stage.height),
  };
}

/** Whether a view is inside its bounds, i.e. has nothing to spring back from. */
export function isSettled(transform: Transform, image: Size, stage: Size): boolean {
  const limit = panLimits(image, stage, transform.scale);
  return Math.abs(transform.x) <= limit.x + 0.5 && Math.abs(transform.y) <= limit.y + 0.5;
}

/**
 * How long a flick keeps going: the velocity is multiplied by `e^(-dt/TAU)`
 * every frame, so it sheds about 90% of its speed in the first half-second and
 * a throw carries roughly a fifth of a second's worth of travel — far enough
 * to feel thrown, short enough that the picture never sails off on its own.
 */
const GLIDE_TAU = 0.18;

/** Below this a glide has stopped being motion and is just a rounding error. */
export const GLIDE_MIN_SPEED = 24;

/** A flick slower than this was a drag that happened to end while moving. */
export const GLIDE_MIN_LAUNCH = 90;

/**
 * And one faster than this is a measurement artefact, not a human arm: two
 * pointer samples a millisecond apart report a speed nobody produced, and
 * without a ceiling the picture would be thrown clear across the room.
 */
export const GLIDE_MAX_LAUNCH = 3600;

/** The shortest span of samples worth dividing by. */
const MIN_SAMPLE_SECONDS = 0.008;

/**
 * The velocity a released drag launches with, or null when there is no throw
 * in it — too slow to be meant, or too short a span to be measured.
 */
export function launchVelocity(dx: number, dy: number, seconds: number): Point | null {
  if (seconds < MIN_SAMPLE_SECONDS) return null;
  const speed = Math.hypot(dx, dy) / seconds;
  if (speed < GLIDE_MIN_LAUNCH) return null;
  const scale = Math.min(1, GLIDE_MAX_LAUNCH / speed) / seconds;
  return { x: dx * scale, y: dy * scale };
}

/** What is left of a velocity after `dt` seconds of friction. */
export function decayVelocity(velocity: number, dt: number): number {
  return velocity * Math.exp(-dt / GLIDE_TAU);
}

/** How far a velocity carries the view over `dt` seconds. */
export function glideDistance(velocity: number, dt: number): number {
  // The integral of the decay above, so the distance matches the speed the
  // frame actually ends at rather than the one it started with.
  return velocity * GLIDE_TAU * (1 - Math.exp(-dt / GLIDE_TAU));
}
