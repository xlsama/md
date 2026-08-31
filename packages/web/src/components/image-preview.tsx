import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { IconName } from '../lib/icons.ts';
import {
  GLIDE_MIN_SPEED,
  TWEEN_MS,
  ZOOM_STEP,
  clampPan,
  decayVelocity,
  easeOutCubic,
  fitScale,
  fitTransform,
  glideDistance,
  interpolate,
  isFitted,
  isPannable,
  isSettled,
  isVectorSource,
  launchVelocity,
  rubberPan,
  scalePercent,
  toggledScale,
  wheelZoomFactor,
  zoomAt,
  type Point,
  type Size,
  type Transform,
} from '../lib/image-preview.ts';
import { basename } from '../lib/paths.ts';
import { useStore, type PreviewImage } from '../store.ts';
import { Icon } from './icon.tsx';

/**
 * Room kept clear around the *fitted* picture so the chrome never sits on it:
 * wide enough for the arrows at the sides, tall enough for the name above and
 * the toolbar below. Only the fit respects this — a zoomed picture runs to the
 * edges of the window, which is the whole point of zooming.
 */
const FIT_INSET_X = 60;
const FIT_INSET_Y = 64;

/** Travel below this is a click that wobbled, not a drag. */
const DRAG_SLOP = 4;

/** How far back a flick's velocity is measured. */
const VELOCITY_WINDOW_MS = 90;

const EMPTY_SIZE: Size = { width: 0, height: 0 };

const NO_PAN: Point = { x: 0, y: 0 };

function stageCenter(stage: Size): Point {
  return { x: stage.width / 2, y: stage.height / 2 };
}

/** The space a fitted picture is allowed to occupy inside a stage of `stage`. */
function fitArea(stage: Size): Size {
  return { width: stage.width - FIT_INSET_X * 2, height: stage.height - FIT_INSET_Y * 2 };
}

/**
 * The corner radius, in the picture's own coordinates.
 *
 * Everything on the picture is scaled by the transform, a border radius
 * included, so a fixed value would grow into a porthole at 4×. Dividing it
 * back out keeps the painted corner the same 10 CSS pixels at every zoom.
 */
function cornerRadius(scale: number): string {
  return `${10 / Math.max(scale, 0.01)}px`;
}

/** What the top bar calls the picture: its alt text, else its file name. */
function displayName(image: PreviewImage): string {
  const alt = image.alt.trim();
  if (alt !== '') return alt;
  const name = basename(image.src.split(/[?#]/)[0] ?? '');
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/**
 * Every scrollable ancestor of `node`, with where each is scrolled to.
 *
 * Handing focus back to a contenteditable makes the browser — and ProseMirror
 * — bring the selection into view, and `preventScroll` does not cover that: it
 * only stops the scroll that focusing *itself* would cause. So the positions
 * are noted on the way in and put back on the way out, and closing the
 * lightbox gives back exactly the page it covered.
 */
interface ScrollMark {
  node: Element;
  top: number;
  left: number;
}

function scrollMarks(node: HTMLElement): ScrollMark[] {
  const marks: ScrollMark[] = [];
  for (let el: Element | null = node; el !== null; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth) {
      marks.push({ node: el, top: el.scrollTop, left: el.scrollLeft });
    }
  }
  return marks;
}

/** How many frames the marks are held. See {@link restoreScroll}. */
const SCROLL_HOLD_FRAMES = 3;

/**
 * Puts the noted positions back, and keeps putting them back for a few frames.
 *
 * Once is not enough: ProseMirror brings its selection into view a beat after
 * it regains focus, not during the `focus()` call, so a single assignment is
 * simply overwritten. Three frames covers it and then stops — this is a nudge,
 * not a scroll lock.
 */
function restoreScroll(marks: ScrollMark[]): void {
  let left = SCROLL_HOLD_FRAMES;
  const put = (): void => {
    for (const mark of marks) {
      mark.node.scrollTop = mark.top;
      mark.node.scrollLeft = mark.left;
    }
    left -= 1;
    if (left > 0) requestAnimationFrame(put);
  };
  put();
}

/** Readers who have asked for less motion get the destination, not the journey. */
function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** What the frame loop is currently doing, if anything. */
type Motion =
  | { kind: 'tween'; from: Transform; to: Transform; start: number; duration: number }
  | { kind: 'glide'; vx: number; vy: number; at: number };

function ChromeButton({
  icon,
  label,
  onClick,
  disabled = false,
  className = '',
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`pointer-events-auto flex cursor-pointer items-center justify-center rounded-full text-white/70 transition-[background-color,color,transform] duration-150 hover:bg-white/15 hover:text-white active:scale-95 disabled:cursor-not-allowed disabled:opacity-30 ${className}`}
    >
      <Icon name={icon} className="size-4" />
    </button>
  );
}

function TextButton({
  label,
  title,
  onClick,
  active = false,
}: {
  label: string;
  title: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`cursor-pointer rounded-full px-2.5 py-1 text-xs tabular-nums transition-[background-color,color,transform] duration-150 hover:bg-white/15 hover:text-white active:scale-95 ${
        active ? 'text-white' : 'text-white/65'
      }`}
    >
      {label}
    </button>
  );
}

/**
 * The open lightbox.
 *
 * The view is deliberately *not* React state. A drag or a wheel produces
 * events far faster than a component can usefully re-render, and routing each
 * one through a render is exactly what makes a picture lag behind the pointer.
 * So the transform lives in a ref, every input writes to it, and one animation
 * frame paints it onto the element — a single style write per frame, no matter
 * how many events arrived. React is told only what the chrome needs: the
 * magnification and whether there is anything to drag, and only when those
 * change.
 *
 * The same frame loop drives the three things that make the surface feel
 * physical rather than nailed down: a named move is tweened, a drag past the
 * edge rubber-bands, and a flick glides to a stop.
 */
function PreviewLayer({ images, index }: { images: PreviewImage[]; index: number }) {
  const closePreview = useStore((s) => s.closePreview);
  const stepPreview = useStore((s) => s.stepPreview);
  const image = images[index];

  const overlayRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  /** Natural pixel size of the picture on show, or null until it has loaded. */
  const [natural, setNatural] = useState<Size | null>(null);
  /** The stage box, mirrored into state for the parts of the render that need it. */
  const [stage, setStage] = useState<Size>(EMPTY_SIZE);
  const [dragging, setDragging] = useState(false);
  /** What the chrome shows. Written by the frame loop, only when it changes. */
  const [chrome, setChrome] = useState({ scale: 1, pannable: false });

  // The authoritative view, plus the measurements the gesture handlers read at
  // the moment they fire — a wheel listener is bound once and must never act
  // on a stale window.
  const view = useRef<Transform>(fitTransform(1));
  const naturalRef = useRef<Size | null>(null);
  const stageSize = useRef<Size>(EMPTY_SIZE);
  /** Whether the picture on show may be enlarged past its authored size. */
  const vectorRef = useRef(false);

  const motionRef = useRef<Motion | null>(null);
  const frameRef = useRef(0);

  /** The stage box and the fit scale for it, as of right now. */
  const measure = useCallback((): { stage: Size; fit: number } => {
    const box = stageSize.current;
    const size = naturalRef.current;
    return { stage: box, fit: size === null ? 1 : fitScale(size, fitArea(box), vectorRef.current) };
  }, []);

  /** Writes the current view onto the element. The only place that touches it. */
  const paint = useCallback((): void => {
    const node = imgRef.current;
    if (node === null) return;
    const { scale, x, y } = view.current;
    node.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${scale})`;
    node.style.borderRadius = cornerRadius(scale);
  }, []);

  /** Tells React what the toolbar and the cursor need, and nothing more. */
  const syncChrome = useCallback((): void => {
    const size = naturalRef.current;
    const scale = view.current.scale;
    const pannable = size !== null && isPannable(size, stageSize.current, scale);
    setChrome((current) =>
      scalePercent(current.scale) === scalePercent(scale) && current.pannable === pannable
        ? current
        : { scale, pannable }
    );
  }, []);

  /**
   * Advances whatever the loop is doing by one frame.
   *
   * A tween walks its own clock and then stops. A glide integrates its
   * velocity, loses some of it to friction, and dies either when it runs out
   * of speed or when it reaches an edge — an axis that hits the boundary loses
   * its momentum there rather than grinding along it.
   */
  const advance = useCallback((active: Motion, now: number): void => {
    const size = naturalRef.current;
    const box = stageSize.current;
    if (size === null) {
      motionRef.current = null;
      return;
    }
    if (active.kind === 'tween') {
      const t = (now - active.start) / active.duration;
      view.current = interpolate(active.from, active.to, easeOutCubic(t));
      if (t >= 1) {
        view.current = active.to;
        motionRef.current = null;
      }
      return;
    }
    const dt = Math.min((now - active.at) / 1000, 0.05);
    const moved = {
      scale: view.current.scale,
      x: view.current.x + glideDistance(active.vx, dt),
      y: view.current.y + glideDistance(active.vy, dt),
    };
    const held = clampPan(moved, size, box);
    const vx = held.x === moved.x ? decayVelocity(active.vx, dt) : 0;
    const vy = held.y === moved.y ? decayVelocity(active.vy, dt) : 0;
    view.current = held;
    motionRef.current =
      Math.hypot(vx, vy) < GLIDE_MIN_SPEED ? null : { kind: 'glide', vx, vy, at: now };
  }, []);

  /** Books the next frame, unless one is already booked. */
  const schedule = useCallback((): void => {
    if (frameRef.current !== 0) return;
    frameRef.current = requestAnimationFrame((now) => {
      frameRef.current = 0;
      const active = motionRef.current;
      if (active !== null) advance(active, now);
      paint();
      syncChrome();
      if (motionRef.current !== null) schedule();
    });
  }, [advance, paint, syncChrome]);

  /** Puts the view somewhere immediately, cancelling whatever it was doing. */
  const set = useCallback(
    (next: Transform): void => {
      motionRef.current = null;
      view.current = next;
      schedule();
    },
    [schedule]
  );

  /** Moves the view somewhere over {@link TWEEN_MS}, from wherever it is now. */
  const glideTo = useCallback(
    (next: Transform): void => {
      if (prefersReducedMotion()) {
        set(next);
        return;
      }
      motionRef.current = {
        kind: 'tween',
        from: view.current,
        to: next,
        start: performance.now(),
        duration: TWEEN_MS,
      };
      schedule();
    },
    [schedule, set]
  );

  /**
   * Zoom by `factor` about `anchor`, then shift by `pan`, then hold the result
   * inside the window. Every continuous gesture goes through here.
   */
  const zoomBy = useCallback(
    (factor: number, anchor: Point | null, pan: Point = NO_PAN, rubber = false): void => {
      const size = naturalRef.current;
      if (size === null) return;
      const { stage: box, fit } = measure();
      const at = anchor ?? stageCenter(box);
      const zoomed = zoomAt(view.current, factor, at, box, fit);
      const moved = { ...zoomed, x: zoomed.x + pan.x, y: zoomed.y + pan.y };
      set(rubber ? rubberPan(moved, size, box) : clampPan(moved, size, box));
    },
    [measure, set]
  );

  /**
   * Where the view is *heading*: the end of a tween in flight, or simply where
   * it is. Named moves compose against this rather than against the painted
   * position, so two presses of `+` inside one frame are two steps rather than
   * one — the second would otherwise re-derive from a picture that has not
   * moved yet and quietly replace the first.
   */
  const pending = useCallback((): Transform => {
    const active = motionRef.current;
    return active !== null && active.kind === 'tween' ? active.to : view.current;
  }, []);

  /** The same, to an absolute magnification, and animated: a named move. */
  const zoomTo = useCallback(
    (scale: number, anchor: Point | null = null): void => {
      const size = naturalRef.current;
      if (size === null) return;
      const { stage: box, fit } = measure();
      const at = anchor ?? stageCenter(box);
      const base = pending();
      glideTo(clampPan(zoomAt(base, scale / base.scale, at, box, fit), size, box));
    },
    [glideTo, measure, pending]
  );

  /** One notch of the toolbar's `−` / `+`, or of the keys behind them. */
  const zoomStep = useCallback(
    (factor: number): void => {
      zoomTo(pending().scale * factor);
    },
    [pending, zoomTo]
  );

  const refit = useCallback((): void => {
    if (naturalRef.current === null) return;
    glideTo(fitTransform(measure().fit));
  }, [glideTo, measure]);

  // A new picture starts from scratch: nothing about the last one's size or
  // magnification says anything about this one.
  useEffect(() => {
    naturalRef.current = null;
    vectorRef.current = images[index] !== undefined && isVectorSource(images[index].src);
    setNatural(null);
    set(fitTransform(1));
  }, [images, index, set]);

  // The stage owns the geometry, so it is measured rather than assumed — the
  // first paint, a resized window and a rotated phone all arrive here. A reader
  // still looking at the fitted view expects it to keep fitting; one who has
  // zoomed in expects their magnification kept and only the pan corrected.
  useEffect(() => {
    const node = stageRef.current;
    if (node === null) return undefined;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box === undefined) return;
      const before = stageSize.current;
      const after = { width: box.width, height: box.height };
      stageSize.current = after;
      setStage(after);
      const size = naturalRef.current;
      if (size === null) return;
      const vector = vectorRef.current;
      set(
        isFitted(view.current.scale, fitScale(size, fitArea(before), vector))
          ? fitTransform(fitScale(size, fitArea(after), vector))
          : clampPan(view.current, size, after)
      );
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [set]);

  // Wheel is bound by hand because React registers its own `onWheel`
  // passively: `preventDefault` from there does nothing, and the document
  // behind the overlay would scroll while the picture zoomed.
  useEffect(() => {
    const node = stageRef.current;
    if (node === null) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      // A trackpad pinch reaches the page as a wheel with the zoom modifier
      // held; it is a different gesture and gets its own sensitivity.
      zoomBy(wheelZoomFactor(event.deltaY, event.deltaMode, event.ctrlKey), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      node.removeEventListener('wheel', onWheel);
    };
  }, [zoomBy]);

  // Nothing may be left running once the overlay is gone.
  useEffect(
    () => () => {
      if (frameRef.current !== 0) cancelAnimationFrame(frameRef.current);
    },
    []
  );

  // Whatever React just committed, the picture still belongs where the view
  // says — the transform is not a prop, so this is what keeps a re-render (a
  // new size, a new label) from painting a frame of the old position.
  useLayoutEffect(paint);

  // The overlay takes the keyboard while it is open and hands it back on the
  // way out — in practice to the editor, with its selection intact and the
  // page exactly where it was. See `scrollMarks`.
  useEffect(() => {
    const previous = document.activeElement;
    overlayRef.current?.focus({ preventScroll: true });
    return () => {
      if (!(previous instanceof HTMLElement)) return;
      const marks = scrollMarks(previous);
      previous.focus({ preventScroll: true });
      restoreScroll(marks);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      switch (event.key) {
        case 'Escape':
          closePreview();
          break;
        case 'ArrowLeft':
          stepPreview(-1);
          break;
        case 'ArrowRight':
          stepPreview(1);
          break;
        case '+':
        case '=':
          zoomStep(ZOOM_STEP);
          break;
        case '-':
        case '_':
          zoomStep(1 / ZOOM_STEP);
          break;
        case '0':
          refit();
          break;
        case '1':
          zoomTo(1);
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [closePreview, refit, stepPreview, zoomStep, zoomTo]);

  /** Live pointers, so one finger pans and two pinch. */
  const pointers = useRef(new Map<number, Point>());
  /** Spread and midpoint of the previous two-finger frame. */
  const pinch = useRef<{ spread: number; center: Point } | null>(null);
  /** Where the gesture started, and whether it has become a drag. */
  const gesture = useRef<{ start: Point; moved: boolean; onBackdrop: boolean } | null>(null);
  /** Recent pointer samples, for the flick that may follow. */
  const trail = useRef<{ at: number; x: number; y: number }[]>([]);

  const stagePoint = useCallback((event: { clientX: number; clientY: number }): Point => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (rect === undefined) return { x: event.clientX, y: event.clientY };
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const point = stagePoint(event);
    // Read before capturing: from here on every pointer event is retargeted to
    // the stage, so this is the last chance to know what was actually under
    // the finger — which decides whether letting go dismisses the box.
    const onBackdrop = event.target === event.currentTarget;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, point);
    if (pointers.current.size === 1) {
      gesture.current = { start: point, moved: false, onBackdrop };
      trail.current = [{ at: performance.now(), x: point.x, y: point.y }];
      // Grabbing a gliding picture stops it dead, the way catching a spun
      // wheel does.
      motionRef.current = null;
    }
    pinch.current = null;
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const live = pointers.current;
    const previous = live.get(event.pointerId);
    if (previous === undefined) return;
    const point = stagePoint(event);
    live.set(event.pointerId, point);
    const active = gesture.current;
    if (
      active !== null &&
      Math.hypot(point.x - active.start.x, point.y - active.start.y) > DRAG_SLOP
    ) {
      active.moved = true;
    }

    if (live.size >= 2) {
      const [a, b] = [...live.values()];
      if (a === undefined || b === undefined) return;
      const spread = Math.hypot(a.x - b.x, a.y - b.y);
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const last = pinch.current;
      pinch.current = { spread, center };
      // Two fingers zoom and drag at once: the spread is the factor, the
      // midpoint's travel is the pan, and both land in one move.
      if (last !== null && last.spread > 0) {
        zoomBy(
          spread / last.spread,
          center,
          { x: center.x - last.center.x, y: center.y - last.center.y },
          true
        );
      }
      return;
    }

    const size = naturalRef.current;
    if (size === null) return;
    const now = performance.now();
    trail.current.push({ at: now, x: point.x, y: point.y });
    while (trail.current.length > 2 && now - (trail.current[0]?.at ?? now) > VELOCITY_WINDOW_MS) {
      trail.current.shift();
    }
    // Panning a picture that already fits would only fight the bounds, and
    // that gesture is a click waiting to happen instead.
    if (!isPannable(size, stageSize.current, view.current.scale)) return;
    zoomBy(1, null, { x: point.x - previous.x, y: point.y - previous.y }, true);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size > 0) return;
    setDragging(false);
    pinch.current = null;
    const active = gesture.current;
    gesture.current = null;
    releaseDrag();
    // Clicking the empty space around the picture dismisses the box — the
    // gesture readers try first, and the only reason a drag has to be told
    // apart from a click at all.
    if (active !== null && !active.moved && active.onBackdrop) closePreview();
  };

  /** What happens to the picture the instant the hand comes off it. */
  function releaseDrag(): void {
    const size = naturalRef.current;
    const box = stageSize.current;
    const samples = trail.current;
    trail.current = [];
    if (size === null) return;
    // Dragged past the edge: the rubber band lets go.
    if (!isSettled(view.current, size, box) || prefersReducedMotion()) {
      glideTo(clampPan(view.current, size, box));
      return;
    }
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (first === undefined || last === undefined) return;
    // Otherwise the flick carries on, if it was one.
    const launch = launchVelocity(last.x - first.x, last.y - first.y, (last.at - first.at) / 1000);
    if (launch === null) return;
    motionRef.current = { kind: 'glide', vx: launch.x, vy: launch.y, at: performance.now() };
    schedule();
  }

  if (image === undefined) return null;
  const fit = natural === null ? 1 : fitScale(natural, fitArea(stage), isVectorSource(image.src));

  return (
    <motion.div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      tabIndex={-1}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
      // Dark in both themes: the chrome floats over a black ground, and a
      // light toolbar there would read as a hole rather than as a control.
      className="fixed inset-0 z-[60] bg-black/80 outline-none backdrop-blur-[2px]"
    >
      <div
        ref={stageRef}
        className="absolute inset-0 overflow-hidden"
        style={{
          touchAction: 'none',
          cursor: chrome.pannable ? (dragging ? 'grabbing' : 'grab') : 'default',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(event) => {
          if (natural === null) return;
          const target = toggledScale(pending().scale, fit);
          if (isFitted(target, fit)) refit();
          else zoomTo(target, stagePoint(event));
        }}
      >
        {/* The entrance lives on a wrapper rather than on the picture: motion
            drives `transform` itself, and animating the picture would overwrite
            the pan and zoom the frame loop writes. The wrapper is
            pointer-transparent so a click beside the picture still reaches the
            stage. */}
        <motion.div
          className="pointer-events-none absolute inset-0"
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: natural === null ? 0 : 1, scale: natural === null ? 0.97 : 1 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        >
          <img
            ref={imgRef}
            key={image.src}
            src={image.src}
            alt={image.alt}
            draggable={false}
            onLoad={(event) => {
              const el = event.currentTarget;
              const loaded = { width: el.naturalWidth, height: el.naturalHeight };
              naturalRef.current = loaded;
              setNatural(loaded);
              set(fitTransform(fitScale(loaded, fitArea(stageSize.current), vectorRef.current)));
            }}
            className="pointer-events-auto absolute top-1/2 left-1/2 max-w-none origin-center transform-gpu will-change-transform select-none"
            style={{ width: natural?.width, height: natural?.height }}
          />
        </motion.div>
      </div>

      {/* Chrome. Pointer-transparent by default so the stage keeps receiving
          the drags and the click-to-dismiss; each control opts back in.

          It also carries its own ground. Resting on the backdrop was enough
          until a picture was magnified past the window — from then on the
          thing behind the toolbar is the picture, and a bright one swallowed
          it whole. So: a scrim at each end, and dark pills on top of that,
          which read the same over a white diagram and a black photograph. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/60 via-black/25 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-black/60 via-black/25 to-transparent" />

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start gap-3 p-3">
        <div className="min-w-0 flex-1 truncate pt-2 pl-1 text-xs text-white/75">
          {displayName(image)}
          {natural !== null && (
            <span className="ml-2 text-white/45 tabular-nums">
              {natural.width}×{natural.height}
            </span>
          )}
        </div>
        <ChromeButton
          icon="x"
          label="关闭（Esc）"
          onClick={closePreview}
          className="size-8 bg-black/60 ring-1 ring-white/15 backdrop-blur-xl"
        />
      </div>

      {images.length > 1 && (
        <>
          <ChromeButton
            icon="chevron-left"
            label="上一张（←）"
            onClick={() => {
              stepPreview(-1);
            }}
            className="absolute top-1/2 left-3 size-10 -translate-y-1/2 bg-black/60 ring-1 ring-white/15 backdrop-blur-xl"
          />
          <ChromeButton
            icon="chevron-right"
            label="下一张（→）"
            onClick={() => {
              stepPreview(1);
            }}
            className="absolute top-1/2 right-3 size-10 -translate-y-1/2 bg-black/60 ring-1 ring-white/15 backdrop-blur-xl"
          />
        </>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-4">
        <div className="pointer-events-auto flex items-center gap-0.5 rounded-full bg-black/60 p-1 ring-1 ring-white/15 backdrop-blur-xl">
          <ChromeButton
            icon="zoom-out"
            label="缩小（-）"
            disabled={natural === null}
            onClick={() => {
              zoomStep(1 / ZOOM_STEP);
            }}
            className="size-7"
          />
          <span className="min-w-13 text-center text-xs text-white/80 tabular-nums">
            {scalePercent(chrome.scale)}%
          </span>
          <ChromeButton
            icon="zoom-in"
            label="放大（+）"
            disabled={natural === null}
            onClick={() => {
              zoomStep(ZOOM_STEP);
            }}
            className="size-7"
          />
          <span className="mx-1 h-4 w-px bg-white/15" />
          <TextButton
            label="适应"
            title="适应窗口（0）"
            onClick={refit}
            active={isFitted(chrome.scale, fit)}
          />
          <TextButton
            label="1:1"
            title="原始大小（1）"
            onClick={() => {
              zoomTo(1);
            }}
            active={isFitted(chrome.scale, 1)}
          />
          {images.length > 1 && (
            <>
              <span className="mx-1 h-4 w-px bg-white/15" />
              <span className="px-2 text-xs text-white/50 tabular-nums">
                {index + 1} / {images.length}
              </span>
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
}

/** Mounts the lightbox while `preview` is open, and animates it out when it closes. */
export function ImagePreview() {
  const preview = useStore((s) => s.preview);
  return (
    <AnimatePresence>
      {preview !== null && (
        <PreviewLayer key="image-preview" images={preview.images} index={preview.index} />
      )}
    </AnimatePresence>
  );
}
