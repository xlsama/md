import { listenForTweetHeight, matchEmbed, type EmbedDescriptor } from '@meowdown/core';
import { definePlugin } from '@prosekit/core';
import { Plugin, PluginKey, type EditorState } from '@prosekit/pm/state';
import { Decoration, DecorationSet } from '@prosekit/pm/view';
import { createRoot, type Root } from 'react-dom/client';
import { LinkCard } from './components/link-card.tsx';
import { detectLinkBlock } from './lib/link-block.ts';

/**
 * Renders a paragraph that holds nothing but a bare link as a rich block.
 *
 * This is a decoration layer, not a document node, and that is a deliberate
 * choice forced by meowdown: `markdownToDoc` dispatches Lezer block types
 * through a hard-coded switch and `docToMarkdown` through another, neither of
 * which takes handlers from outside the package. A custom node would therefore
 * never be produced when a file is opened, and — far worse — would be silently
 * dropped on the way back out, losing the URL on save. Leaving the paragraph
 * exactly as meowdown parsed it and painting over it keeps the markdown on disk
 * a plain URL, makes the round trip an identity, and costs nothing on save.
 *
 * YouTube and X links reuse meowdown's own `matchEmbed`, so the iframe, its
 * `md-embed-*` classes and the stylesheet that sizes them are shared with the
 * embeds meowdown renders for `![](url)`. Everything else gets a `LinkCard`.
 */

const SOURCE_CLASS = 'md-link-block';
const CARET_ATTR = 'data-md-link-caret';
/** How many detached copies of one URL's widget are worth keeping around. */
const POOL_PER_URL = 4;
const POOL_URLS = 128;

const pool = new Map<string, HTMLElement[]>();
/** Re-arms listeners that tear themselves down while a widget sits detached. */
const reactivate = new WeakMap<HTMLElement, () => void>();
/** The React root behind each card widget, kept so eviction can unmount it. */
const roots = new WeakMap<HTMLElement, Root>();

function buildEmbedIframe(embed: EmbedDescriptor): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.src = embed.src;
  iframe.title = embed.title;
  iframe.className = embed.className;
  iframe.dataset.testid = embed.testid;
  iframe.loading = 'lazy';
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  iframe.setAttribute('frameborder', '0');
  if (embed.allow !== undefined) iframe.allow = embed.allow;
  if (embed.allowFullscreen === true) iframe.allowFullscreen = true;
  return iframe;
}

function buildWidget(url: string): HTMLElement {
  const host = document.createElement('div');
  host.className = 'md-link-block-widget';
  host.contentEditable = 'false';

  const embed = matchEmbed(url);
  if (embed !== undefined) {
    host.dataset.kind = embed.kind;
    const iframe = buildEmbedIframe(embed);
    host.append(iframe);
    if (embed.kind === 'tweet') {
      // The helper stops listening once the iframe leaves the document, which
      // is exactly what happens while the widget waits in the pool.
      listenForTweetHeight(iframe);
      reactivate.set(host, () => {
        listenForTweetHeight(iframe);
      });
    }
    return host;
  }

  host.dataset.kind = 'card';
  const root = createRoot(host);
  roots.set(host, root);
  root.render(<LinkCard url={url} />);
  return host;
}

/**
 * Drops a URL's widgets for good.
 *
 * A `LinkCard` subscribes to the shared metadata store, and that subscription
 * lives as long as its React root does — so a bucket that is simply forgotten
 * leaves listeners attached to a URL nothing will ever render again, one per
 * copy, for the rest of the session. `unmount()` is what runs the effect
 * cleanups that remove them.
 *
 * A widget still in the document is skipped: it is in use, not leaked, and
 * ProseMirror owns that DOM — emptying it would blank a card the reader is
 * looking at. Eviction is least-recently-acquired, so this is the rare case.
 */
function releaseBucket(bucket: readonly HTMLElement[]): void {
  for (const element of bucket) {
    if (element.isConnected) continue;
    const root = roots.get(element);
    if (root === undefined) continue;
    roots.delete(element);
    // React refuses to unmount while it is rendering, and this runs from a
    // decoration callback; the microtask puts it safely after.
    queueMicrotask(() => {
      root.unmount();
    });
  }
}

/**
 * Hands out the DOM for one URL's widget, reusing a detached copy when there is
 * one.
 *
 * Reuse is the whole point: ProseMirror throws widgets away and rebuilds them
 * whenever the document is replaced — opening a file, and the idle write-back
 * of formatted text — and a fresh element would mean a remounted React tree
 * flashing its skeleton again, or a video restarting from zero. A URL that
 * appears twice in one document needs two live elements, hence a pool rather
 * than a single cached node.
 */
function acquireWidget(url: string): HTMLElement {
  const bucket = pool.get(url) ?? [];
  // Re-inserting moves the key to the end, which makes the map an LRU: the
  // entry evicted below is then the URL least recently asked for, never one
  // the reader is currently looking at.
  if (pool.delete(url)) pool.set(url, bucket);

  const free = bucket.find((element) => !element.isConnected);
  if (free !== undefined) {
    reactivate.get(free)?.();
    return free;
  }
  const created = buildWidget(url);
  if (bucket.length < POOL_PER_URL) {
    bucket.push(created);
    pool.set(url, bucket);
    if (pool.size > POOL_URLS) {
      const oldest = pool.keys().next();
      if (oldest.done !== true) {
        const evicted = pool.get(oldest.value) ?? [];
        pool.delete(oldest.value);
        releaseBucket(evicted);
      }
    }
  }
  return created;
}

interface BlockHit {
  from: number;
  to: number;
  url: string;
}

/** Top-level paragraphs only — a link inside a list or a quote stays inline. */
function findBlocks(doc: EditorState['doc']): BlockHit[] {
  const hits: BlockHit[] = [];
  doc.forEach((node, offset) => {
    if (node.type.name !== 'paragraph') return;
    const block = detectLinkBlock(node.textContent);
    if (block === null) return;
    hits.push({ from: offset, to: offset + node.nodeSize, url: block.url });
  });
  return hits;
}

function build(state: EditorState, hits: BlockHit[]): DecorationSet {
  const { from, to } = state.selection;
  const decorations: Decoration[] = [];
  for (const hit of hits) {
    // The source line is revealed while the caret is inside it, so the URL
    // stays editable; `index.css` ties the reveal to editor focus as well.
    const caretInside = from <= hit.to - 1 && to >= hit.from + 1;
    decorations.push(
      Decoration.node(hit.from, hit.to, {
        class: SOURCE_CLASS,
        ...(caretInside ? { [CARET_ATTR]: '' } : {}),
      }),
      Decoration.widget(hit.from, () => acquireWidget(hit.url), {
        // A stable key is what lets ProseMirror keep the existing DOM instead
        // of rebuilding it on every keystroke.
        key: `md-link-block:${hit.url}`,
        side: -1,
        ignoreSelection: true,
      })
    );
  }
  return DecorationSet.create(state.doc, decorations);
}

export function defineLinkBlocks() {
  const key = new PluginKey('mdLinkBlocks');
  // Scanning every top-level paragraph on a pure selection change would be
  // wasted work, so the hits are kept until the document itself changes.
  let cachedDoc: EditorState['doc'] | null = null;
  let cachedHits: BlockHit[] = [];

  return definePlugin(
    new Plugin({
      key,
      props: {
        decorations(state) {
          if (state.doc !== cachedDoc) {
            cachedDoc = state.doc;
            cachedHits = findBlocks(state.doc);
          }
          return cachedHits.length === 0 ? null : build(state, cachedHits);
        },
      },
    })
  );
}
