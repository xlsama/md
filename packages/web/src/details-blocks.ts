import chevronDown from '@iconify-icons/lucide/chevron-down';
import { definePlugin } from '@prosekit/core';
import { Plugin, PluginKey, type EditorState, type Selection } from '@prosekit/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@prosekit/pm/view';
import {
  detectDetailsMarker,
  pairDetails,
  type DetailsMarker,
  type DetailsRegion,
} from './lib/details-block.ts';

/**
 * Renders a `<details>` block as the fold it is meant to be.
 *
 * Like `link-blocks.ts`, and for the same reason: meowdown has no html node in
 * its schema — `markdownToDoc` sends every raw HTML block through
 * `convertParagraph` — so `<details>`, `<summary>` and the tags inside them
 * arrive as ordinary prose with nothing folded. Both of meowdown's conversion
 * switches are hard-coded inside the package, so a custom node could never be
 * produced when a file is opened and would be dropped on the way back out;
 * painting over the paragraphs meowdown did produce keeps the file on disk
 * byte-identical and costs nothing when it is saved.
 *
 * The tag paragraphs are collapsed to nothing and a header widget is drawn in
 * their place, the same technique link blocks use; the body is the run of
 * top-level blocks between them, hidden through a class while the fold is shut.
 *
 * Whether a block starts folded is the markdown's own `open` attribute, so the
 * document reads here the way it reads on GitHub. Toggling is view state and
 * never touches the document: a fold is a way of reading, and writing it back
 * would put a diff under an agent editing the same file.
 */

const SOURCE_CLASS = 'md-details-tag';
const BODY_CLASS = 'md-details-body';
const HIDDEN_CLASS = 'md-details-hidden';
const CARET_ATTR = 'data-md-details-caret';
const INDENT_VAR = '--md-details-indent';
/** How deep an indent still reads as nesting rather than as a runaway margin. */
const MAX_INDENT_DEPTH = 6;
/** A block with no `<summary>` still needs something to click. */
const FALLBACK_SUMMARY = '详细信息';

interface ToggleMeta {
  key: string;
}

function isToggleMeta(value: unknown): value is ToggleMeta {
  return typeof value === 'object' && value !== null && 'key' in value && typeof value.key === 'string';
}

/** Open state by region key; a key that is absent follows the markdown. */
type ExpandedState = Readonly<Record<string, boolean>>;

function indentOf(depth: number): string {
  return `${INDENT_VAR}:${Math.min(depth, MAX_INDENT_DEPTH) * 1.25}rem`;
}

/**
 * The disclosure chevron, built from the same `@iconify-icons/lucide` data the
 * React `Icon` component draws from — this widget is plain DOM, so the glyph is
 * assembled by hand rather than rendered. The body is a bundled constant, never
 * anything read from the document.
 */
function buildMarker(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'md-details-marker');
  svg.setAttribute('viewBox', `0 0 ${chevronDown.width ?? 24} ${chevronDown.height ?? 24}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = chevronDown.body;
  return svg;
}

function buildHeader(
  view: EditorView,
  key: PluginKey<ExpandedState>,
  region: DetailsRegion,
  expanded: boolean
): HTMLElement {
  const host = document.createElement('div');
  host.className = 'md-details-header';
  host.contentEditable = 'false';
  host.dataset.expanded = String(expanded);
  host.setAttribute('style', indentOf(region.depth));

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'md-details-toggle';
  button.setAttribute('aria-expanded', String(expanded));

  const marker = buildMarker();

  const label = document.createElement('span');
  label.className = 'md-details-summary';
  label.textContent = region.summary ?? FALLBACK_SUMMARY;
  if (region.summary === null) label.dataset.fallback = '';

  button.append(marker, label);
  // `mousedown` rather than `click`: ProseMirror would otherwise move the
  // selection into the very block being folded on the way to the click, which
  // is exactly what forces a fold back open.
  button.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const meta: ToggleMeta = { key: region.key };
    view.dispatch(view.state.tr.setMeta(key, meta));
  });
  host.append(button);
  return host;
}

interface BlockSpan {
  from: number;
  to: number;
}

/**
 * The document's top-level blocks paired into regions, with the positions the
 * decorations need.
 */
interface Scan {
  regions: DetailsRegion[];
  spans: BlockSpan[];
}

function scan(doc: EditorState['doc']): Scan {
  const markers: (DetailsMarker | null)[] = [];
  const spans: BlockSpan[] = [];
  doc.forEach((node, offset) => {
    markers.push(node.type.name === 'paragraph' ? detectDetailsMarker(node.textContent) : null);
    spans.push({ from: offset, to: offset + node.nodeSize });
  });
  return { regions: pairDetails(markers), spans };
}

/**
 * Whether a selection reaches into a span, by the same rule link blocks use:
 * the range is shrunk by one on each side so a caret sitting in the neighbouring
 * block — which reports exactly on the boundary — does not count as inside.
 */
function touches(selection: Selection, from: number, to: number): boolean {
  return selection.from <= to - 1 && selection.to >= from + 1;
}

function build(
  state: EditorState,
  key: PluginKey<ExpandedState>,
  scanned: Scan,
  expandedState: ExpandedState
): DecorationSet {
  const { regions, spans } = scanned;
  const decorations: Decoration[] = [];
  /**
   * Blocks already hidden by an enclosing fold. A shut fold hides everything
   * under it — nested headers and their bodies included — so the outermost one
   * wins and the regions inside it need no decorations of their own.
   *
   * Regions are ordered by their opening block, which puts every parent before
   * its children and makes one pass enough.
   */
  const hidden = new Set<number>();

  for (const region of regions) {
    const openSpan = spans[region.openIndex];
    const closeSpan = spans[region.closeIndex];
    if (openSpan === undefined || closeSpan === undefined) continue;

    /**
     * A fold the caret is inside stays open however it was toggled: hiding the
     * block being edited would strand the caret in `display: none`, where the
     * arrow keys walk through text nobody can see. Nesting takes care of
     * itself — a parent's span contains its children's, so a caret deep inside
     * opens every fold above it too.
     */
    const caretInside = touches(state.selection, openSpan.from, closeSpan.to);
    const insideShutFold = hidden.has(region.openIndex);
    const expanded =
      !insideShutFold && (caretInside || (expandedState[region.key] ?? region.open));

    if (!expanded) for (let i = region.openIndex + 1; i < region.closeIndex; i++) hidden.add(i);
    if (insideShutFold) continue;

    // The tag paragraphs stay in the document — the markdown is unchanged — so
    // they are collapsed to nothing and revealed again under the caret, which
    // is what keeps them editable.
    for (const span of [openSpan, closeSpan]) {
      decorations.push(
        Decoration.node(span.from, span.to, {
          class: SOURCE_CLASS,
          ...(touches(state.selection, span.from, span.to) ? { [CARET_ATTR]: '' } : {}),
        })
      );
    }

    decorations.push(
      Decoration.widget(openSpan.from, (view) => buildHeader(view, key, region, expanded), {
        // The open state is part of the key so a toggle rebuilds the header.
        // Unlike a link card there is nothing expensive to preserve: this is a
        // handful of static elements and one listener.
        key: `md-details:${region.key}:${String(expanded)}:${String(region.depth)}`,
        side: -1,
        ignoreSelection: true,
      })
    );

    const bodyStyle = indentOf(region.depth + 1);
    for (let i = region.openIndex + 1; i < region.closeIndex; i++) {
      const span = spans[i];
      if (span === undefined) continue;
      decorations.push(
        Decoration.node(span.from, span.to, {
          class: expanded ? BODY_CLASS : `${BODY_CLASS} ${HIDDEN_CLASS}`,
          style: bodyStyle,
        })
      );
    }
  }

  return DecorationSet.create(state.doc, decorations);
}

/**
 * Folding for the document at `docPath`.
 *
 * The path is what scopes the plugin — and with it the record of which folds
 * the reader has opened — to one file: `DetailsBlocks` in `editor.tsx` rebuilds
 * the extension when the path changes, so opening another file starts from the
 * markdown's own `open` attributes again. The formatter's idle write-back
 * replaces the document without touching the path, which is exactly right: a
 * save must not shut what the reader opened.
 */
export function defineDetailsBlocks(docPath: string | null) {
  const key = new PluginKey<ExpandedState>(`mdDetailsBlocks:${docPath ?? ''}`);
  // Scanning every top-level block on a pure selection change would be wasted
  // work, so the scan is kept until the document itself changes.
  let cachedDoc: EditorState['doc'] | null = null;
  let cachedScan: Scan = { regions: [], spans: [] };

  const scanOf = (doc: EditorState['doc']): Scan => {
    if (doc !== cachedDoc) {
      cachedDoc = doc;
      cachedScan = scan(doc);
    }
    return cachedScan;
  };

  return definePlugin(
    new Plugin<ExpandedState>({
      key,
      state: {
        init: (): ExpandedState => ({}),
        apply(tr, value): ExpandedState {
          const meta: unknown = tr.getMeta(key);
          if (!isToggleMeta(meta)) return value;
          const region = scanOf(tr.doc).regions.find((candidate) => candidate.key === meta.key);
          if (region === undefined) return value;
          return { ...value, [meta.key]: !(value[meta.key] ?? region.open) };
        },
      },
      props: {
        decorations(state) {
          const scanned = scanOf(state.doc);
          if (scanned.regions.length === 0) return null;
          return build(state, key, scanned, key.getState(state) ?? {});
        },
      },
    })
  );
}
