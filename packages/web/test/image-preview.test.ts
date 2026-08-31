import { describe, expect, test } from 'bun:test';
import {
  GLIDE_MAX_LAUNCH,
  MAX_SCALE,
  clampPan,
  clampScale,
  decayVelocity,
  easeOutCubic,
  fitScale,
  glideDistance,
  interpolate,
  isFitted,
  isPannable,
  isSettled,
  isVectorSource,
  launchVelocity,
  rubberBand,
  rubberPan,
  scalePercent,
  stepIndex,
  toggledScale,
  wheelZoomFactor,
  zoomAt,
  type Transform,
} from '../src/lib/image-preview.ts';

const stage = { width: 1000, height: 800 };

describe('fitScale', () => {
  test('a picture wider than the window is shrunk to its width', () => {
    expect(fitScale({ width: 2000, height: 800 }, stage)).toBe(0.5);
  });

  test('the tighter axis wins', () => {
    expect(fitScale({ width: 2000, height: 3200 }, stage)).toBe(0.25);
  });

  test('a small picture is shown at its own size rather than blown up', () => {
    expect(fitScale({ width: 100, height: 80 }, stage)).toBe(1);
  });

  test('a vector picture is enlarged to fill the space instead', () => {
    expect(fitScale({ width: 400, height: 400 }, stage, true)).toBe(2);
  });

  test('and not past the ceiling', () => {
    expect(fitScale({ width: 100, height: 80 }, stage, true)).toBe(MAX_SCALE);
  });

  test('an unmeasured stage answers 1 instead of 0', () => {
    expect(fitScale({ width: 100, height: 80 }, { width: 0, height: 0 })).toBe(1);
  });
});

describe('clampScale', () => {
  test('magnification stops at the ceiling', () => {
    expect(clampScale(40, 0.5)).toBe(MAX_SCALE);
  });

  test('a picture too big to fit above the floor may still fit', () => {
    expect(clampScale(0.02, 0.02)).toBe(0.02);
  });

  test('the floor holds for everything else', () => {
    expect(clampScale(0.001, 0.5)).toBe(0.1);
  });
});

describe('wheelZoomFactor', () => {
  test('scrolling up magnifies and scrolling down shrinks', () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
  });

  test('opposite notches undo each other', () => {
    expect(wheelZoomFactor(-50) * wheelZoomFactor(50)).toBeCloseTo(1, 10);
  });

  test('a mouse reporting lines moves more than one reporting pixels', () => {
    expect(wheelZoomFactor(3, 1)).toBeLessThan(wheelZoomFactor(3, 0));
  });

  test('one enormous delta cannot jump the whole range', () => {
    expect(wheelZoomFactor(100000)).toBe(wheelZoomFactor(220));
  });
});

describe('zoomAt', () => {
  /** Where a picture point sits on the stage under a transform. */
  const project = (t: Transform, point: { x: number; y: number }) => ({
    x: stage.width / 2 + point.x * t.scale + t.x,
    y: stage.height / 2 + point.y * t.scale + t.y,
  });

  test('the point under the cursor does not move', () => {
    const before: Transform = { scale: 1, x: 0, y: 0 };
    const anchor = { x: 700, y: 300 };
    // The picture point currently under the anchor.
    const point = { x: anchor.x - stage.width / 2, y: anchor.y - stage.height / 2 };
    const after = zoomAt(before, 2.5, anchor, stage, 1);
    expect(after.scale).toBe(2.5);
    expect(project(after, point).x).toBeCloseTo(anchor.x, 6);
    expect(project(after, point).y).toBeCloseTo(anchor.y, 6);
  });

  test('the anchor still holds when the requested scale is clamped', () => {
    const before: Transform = { scale: 4, x: 0, y: 0 };
    const anchor = { x: 100, y: 100 };
    const point = { x: (anchor.x - stage.width / 2) / 4, y: (anchor.y - stage.height / 2) / 4 };
    const after = zoomAt(before, 100, anchor, stage, 1);
    expect(after.scale).toBe(MAX_SCALE);
    expect(project(after, point).x).toBeCloseTo(anchor.x, 6);
  });

  test('zooming about the centre leaves a centred picture centred', () => {
    const after = zoomAt({ scale: 1, x: 0, y: 0 }, 2, { x: 500, y: 400 }, stage, 1);
    expect(after.x).toBe(0);
    expect(after.y).toBe(0);
  });
});

describe('clampPan', () => {
  const image = { width: 2000, height: 1600 };

  test('an axis the picture does not overflow is pinned to the centre', () => {
    const clamped = clampPan({ scale: 0.25, x: 300, y: -200 }, image, stage);
    expect(clamped.x).toBe(0);
    expect(clamped.y).toBe(0);
  });

  test('an overflowing axis may be dragged only as far as its own edge', () => {
    const clamped = clampPan({ scale: 1, x: 9999, y: 0 }, image, stage);
    expect(clamped.x).toBe(500);
  });

  test('a pan already inside the bounds is left alone', () => {
    expect(clampPan({ scale: 1, x: 120, y: -80 }, image, stage)).toEqual({
      scale: 1,
      x: 120,
      y: -80,
    });
  });
});

describe('isPannable', () => {
  test('a fitted picture is not draggable', () => {
    expect(isPannable({ width: 2000, height: 1600 }, stage, 0.5)).toBe(false);
  });

  test('overflowing either axis is enough', () => {
    expect(isPannable({ width: 2000, height: 400 }, stage, 0.6)).toBe(true);
  });
});

describe('toggledScale', () => {
  test('a fitted picture goes to actual pixels', () => {
    expect(toggledScale(0.25, 0.25)).toBe(1);
  });

  test('a zoomed picture goes back to the fit', () => {
    expect(toggledScale(3, 0.25)).toBe(0.25);
  });

  test('a picture already at actual pixels doubles instead of standing still', () => {
    expect(toggledScale(1, 1)).toBe(2);
  });

  test('so does a vector picture already fitted above 1:1', () => {
    expect(toggledScale(1.5, 1.5)).toBe(3);
  });
});

describe('isFitted', () => {
  test('rounding noise still counts as fitted', () => {
    expect(isFitted(0.30000000004, 0.3)).toBe(true);
  });

  test('a real difference does not', () => {
    expect(isFitted(0.31, 0.3)).toBe(false);
  });
});

describe('isVectorSource', () => {
  test('an svg file has no native resolution to respect', () => {
    expect(isVectorSource('/raw/assets/Flow.SVG?v=2')).toBe(true);
    expect(isVectorSource('data:image/svg+xml,%3Csvg%3E')).toBe(true);
  });

  test('a raster one does', () => {
    expect(isVectorSource('/raw/assets/shot.png')).toBe(false);
    expect(isVectorSource('/raw/assets/svg-notes.png')).toBe(false);
  });
});

describe('stepIndex', () => {
  test('the last picture wraps to the first', () => {
    expect(stepIndex(2, 1, 3)).toBe(0);
  });

  test('and the first back to the last', () => {
    expect(stepIndex(0, -1, 3)).toBe(2);
  });

  test('an empty gallery has nowhere to step', () => {
    expect(stepIndex(0, 1, 0)).toBe(0);
  });
});

describe('scalePercent', () => {
  test('reports the true pixel ratio', () => {
    expect(scalePercent(1)).toBe(100);
    expect(scalePercent(0.256)).toBe(26);
  });

  test('never reads as 0%', () => {
    expect(scalePercent(0.001)).toBe(1);
  });
});

describe('easeOutCubic', () => {
  test('starts and ends where it should', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });

  test('is most of the way there at the halfway mark', () => {
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 6);
  });

  test('clamps rather than overshooting past its window', () => {
    expect(easeOutCubic(1.4)).toBe(1);
    expect(easeOutCubic(-1)).toBe(0);
  });
});

describe('interpolate', () => {
  const from: Transform = { scale: 1, x: 0, y: 0 };
  const to: Transform = { scale: 4, x: 200, y: -100 };

  test('halfway between 1x and 4x is 2x, not 2.5x', () => {
    expect(interpolate(from, to, 0.5).scale).toBeCloseTo(2, 6);
  });

  test('the pan is plain and linear', () => {
    const half = interpolate(from, to, 0.5);
    expect(half.x).toBe(100);
    expect(half.y).toBe(-50);
  });

  test('the ends are exact', () => {
    expect(interpolate(from, to, 0)).toEqual(from);
    expect(interpolate(from, to, 1).scale).toBeCloseTo(4, 6);
  });
});

describe('rubberBand', () => {
  test('inside the bounds a drag is one-to-one', () => {
    expect(rubberBand(120, 200, 1000)).toBe(120);
    expect(rubberBand(-200, 200, 1000)).toBe(-200);
  });

  test('past them each pixel of travel buys less', () => {
    const first = rubberBand(220, 200, 1000) - 200;
    const later = rubberBand(420, 200, 1000) - rubberBand(400, 200, 1000);
    expect(first).toBeGreaterThan(later);
  });

  test('and never gets past its own ceiling', () => {
    expect(rubberBand(1e6, 200, 1000)).toBeLessThan(200 + 1000 * 0.35);
  });

  test('resistance is symmetric', () => {
    expect(rubberBand(-300, 200, 1000)).toBe(-rubberBand(300, 200, 1000));
  });
});

describe('rubberPan and isSettled', () => {
  const image = { width: 2000, height: 1600 };

  test('a drag past the edge is allowed, but resisted', () => {
    const pulled = rubberPan({ scale: 1, x: 900, y: 0 }, image, stage);
    expect(pulled.x).toBeGreaterThan(500);
    expect(pulled.x).toBeLessThan(900);
  });

  test('and is then known to need springing back', () => {
    expect(isSettled({ scale: 1, x: 600, y: 0 }, image, stage)).toBe(false);
    expect(isSettled({ scale: 1, x: 500, y: 0 }, image, stage)).toBe(true);
  });
});

describe('glide', () => {
  test('friction takes most of a flick within half a second', () => {
    expect(decayVelocity(1000, 0.5)).toBeLessThan(0.1 * 1000);
  });

  test('a frame moves the view by a little under the speed it is travelling at', () => {
    const frame = glideDistance(1000, 1 / 60);
    expect(frame).toBeLessThan(1000 / 60);
    expect(frame).toBeGreaterThan((1000 / 60) * 0.9);
  });

  test('and the whole flick travels a bounded distance', () => {
    expect(glideDistance(1000, 10)).toBeCloseTo(180, 3);
  });
});

describe('wheelZoomFactor with a pinch', () => {
  test('the same delta moves further as a pinch than as a wheel notch', () => {
    expect(wheelZoomFactor(-10, 0, true)).toBeGreaterThan(wheelZoomFactor(-10, 0, false));
  });

  test('a pinch is capped too', () => {
    expect(wheelZoomFactor(-9999, 0, true)).toBe(wheelZoomFactor(-48, 0, true));
  });
});

describe('launchVelocity', () => {
  test('an ordinary flick becomes its own speed', () => {
    const v = launchVelocity(120, 0, 0.1);
    expect(v?.x).toBeCloseTo(1200, 6);
  });

  test('a slow finish is not a throw', () => {
    expect(launchVelocity(4, 0, 0.1)).toBeNull();
  });

  test('two samples a millisecond apart are not evidence of anything', () => {
    expect(launchVelocity(40, 0, 0.001)).toBeNull();
  });

  test('an impossible speed is capped, direction kept', () => {
    const v = launchVelocity(300, 400, 0.01);
    expect(Math.hypot(v?.x ?? 0, v?.y ?? 0)).toBeCloseTo(GLIDE_MAX_LAUNCH, 6);
    expect((v?.y ?? 0) / (v?.x ?? 1)).toBeCloseTo(4 / 3, 6);
  });
});
