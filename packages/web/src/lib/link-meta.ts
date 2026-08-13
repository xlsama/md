import { linkMetaResponseSchema, type LinkMeta } from 'writedown/protocol';

/**
 * Module-level store for `/api/link-meta` answers.
 *
 * It lives outside React on purpose. Every card is drawn by a ProseMirror
 * widget that the editor throws away and rebuilds whenever the document
 * reparses — which includes the idle write-back of formatted text — so a cache
 * held inside a component would restart the skeleton each time. Keeping the
 * outcome here means a rebuilt card paints its final state immediately, the
 * same trick `lib/image-status.ts` plays for images.
 */

export type LinkMetaState =
  | { status: 'loading' }
  | { status: 'ready'; meta: LinkMeta }
  | { status: 'failed' };

const LOADING: LinkMetaState = { status: 'loading' };
const FAILED: LinkMetaState = { status: 'failed' };

const states = new Map<string, LinkMetaState>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Map<string, Set<() => void>>();

function publish(url: string, next: LinkMetaState): void {
  states.set(url, next);
  for (const listener of listeners.get(url) ?? []) listener();
}

async function request(url: string): Promise<LinkMetaState> {
  const res = await fetch(`/api/link-meta?url=${encodeURIComponent(url)}`);
  if (!res.ok) return FAILED;
  const parsed = linkMetaResponseSchema.safeParse(await res.json());
  if (!parsed.success || !parsed.data.ok) return FAILED;
  return { status: 'ready', meta: parsed.data.meta };
}

/**
 * Starts a fetch for `url` unless one is already running or finished.
 *
 * Requests are deduplicated by URL across the whole page, so a document that
 * links the same page twice — or a card that is rebuilt mid-flight — makes one
 * request.
 */
export function loadLinkMeta(url: string): void {
  if (states.has(url) || inflight.has(url)) return;
  states.set(url, LOADING);
  const task = request(url)
    .catch(() => FAILED)
    .then((next) => {
      publish(url, next);
    })
    .finally(() => {
      inflight.delete(url);
    });
  inflight.set(url, task);
}

/** Current state for `url`; `loading` until the first answer lands. */
export function readLinkMeta(url: string): LinkMetaState {
  return states.get(url) ?? LOADING;
}

export function subscribeLinkMeta(url: string, listener: () => void): () => void {
  const set = listeners.get(url) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(url, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(url);
  };
}
