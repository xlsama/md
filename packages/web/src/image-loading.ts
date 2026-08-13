import { icons } from './lib/icons.ts';
import {
  ImageOutcomeMemo,
  classifyImage,
  isCurrentFailure,
  type ImageLoadState,
} from './lib/image-status.ts';

/** Attribute the stylesheet keys the skeleton and the failure card off. */
const STATE_ATTR = 'data-md-img';
/** Meowdown wraps every rendered image in this element. */
const WRAPPER = '.md-image-resizable';
/** Custom property holding the `image-off` glyph used by the failure card. */
const ICON_VAR = '--md-image-off';

/**
 * Inlines the offline `image-off` icon data as a `mask-image` URL.
 *
 * `currentColor` cannot resolve inside an image used as a mask, so it becomes a
 * plain opaque fill — the mask only cares about the alpha channel, and CSS
 * paints the actual color through it.
 */
function iconDataUrl(): string {
  const icon = icons['image-off'];
  const width = icon.width ?? 24;
  const height = icon.height ?? 24;
  const body = icon.body.replaceAll('currentColor', '#000');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** The URL actually being fetched; `currentSrc` empties out on failure. */
function currentSource(img: HTMLImageElement): string {
  return img.currentSrc === '' ? img.src : img.currentSrc;
}

function apply(img: HTMLImageElement, state: ImageLoadState): void {
  const target: Element = img.closest(WRAPPER) ?? img;
  if (target.getAttribute(STATE_ATTR) !== state) target.setAttribute(STATE_ATTR, state);
  if (state === 'failed') {
    const title = `图片加载失败：${currentSource(img)}`;
    if (target.getAttribute('title') !== title) target.setAttribute('title', title);
    return;
  }
  if (target.hasAttribute('title')) target.removeAttribute('title');
}

/**
 * Gives every `<img>` in the editor a shimmer skeleton while it loads and a
 * styled card instead of the browser's broken-image glyph when it fails.
 *
 * Meowdown renders images through a ProseMirror mark view that is destroyed and
 * rebuilt whenever the document reparses, so anything we write onto an image is
 * routinely thrown away and a per-element listener attached after the fact
 * would miss the events entirely. Hence three cooperating pieces, none of which
 * touch meowdown itself:
 *
 * - `load` / `error` are listened for on the host in the **capture** phase.
 *   Neither event bubbles, but capture still visits ancestors on the way down,
 *   so one pair of listeners covers every image the editor will ever render,
 *   whenever it appears.
 * - A `MutationObserver` re-applies the state after each rebuild. Its callback
 *   runs in the microtask right after the mutation and before paint, so a
 *   rebuilt image is never painted unstyled.
 * - Outcomes are memoised per URL, so a rebuild for an image the browser
 *   already has — or for a URL we have watched 404 — restores the final state
 *   directly instead of flashing the skeleton on every keystroke.
 * - A failure is confirmed a task after the event that reported it, against the
 *   source the element is pointing at by then. Nothing else distinguishes "this
 *   picture is broken" from "this element was briefly pointed somewhere else",
 *   and the second must never paint.
 *
 * The state lives in `data-md-img`, which is deliberately outside the
 * observer's `attributeFilter`, so writing it cannot feed back into the
 * observer and loop.
 */
export function watchImageLoading(host: HTMLElement): () => void {
  const memo = new ImageOutcomeMemo();
  /** The source each element last errored on — see `isCurrentFailure`. */
  const failures = new WeakMap<HTMLImageElement, string>();
  host.style.setProperty(ICON_VAR, iconDataUrl());

  const onLoad = (event: Event): void => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement)) return;
    failures.delete(img);
    memo.record(currentSource(img), 'loaded');
    apply(img, 'loaded');
  };

  const onError = (event: Event): void => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement)) return;
    const failed = currentSource(img);
    if (failed === '') return;
    failures.set(img, failed);
    // Not painted yet, and not remembered either. An element whose source is
    // rewritten in the same tick — the resolved form of a relative path — errors
    // on the value it held in between, and taking that at face value is what
    // showed the failure card before the shimmer. A task later the element has
    // settled on the source it actually means to load, and only then is the
    // error worth believing.
    queueMicrotask(() => {
      if (!isCurrentFailure(failures.get(img), currentSource(img))) return;
      memo.record(failed, 'failed');
      apply(img, 'failed');
    });
  };

  const rescan = (): void => {
    for (const img of host.querySelectorAll('img')) {
      const src = currentSource(img);
      apply(
        img,
        classifyImage(
          {
            src,
            complete: img.complete,
            naturalWidth: img.naturalWidth,
            errored: isCurrentFailure(failures.get(img), src),
          },
          memo
        )
      );
    }
  };

  host.addEventListener('load', onLoad, true);
  host.addEventListener('error', onError, true);
  const observer = new MutationObserver(rescan);
  observer.observe(host, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  });
  rescan();

  return () => {
    host.removeEventListener('load', onLoad, true);
    host.removeEventListener('error', onError, true);
    observer.disconnect();
  };
}
