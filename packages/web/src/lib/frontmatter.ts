import type { TypedEditor } from '@meowdown/core';
import { Document, Pair, isMap, isNode, isScalar, isSeq, parseDocument, type YAMLMap } from 'yaml';

/**
 * The YAML frontmatter block, read as a table of properties.
 *
 * meowdown keeps the block as one verbatim string on the `doc` node (see
 * `frontmatter` in `@meowdown/core`), so the string — not this model — is the
 * source of truth. Every edit re-parses it, mutates the one node it touches and
 * prints the document back, which is what keeps the untouched lines byte-exact:
 * comments, quoting style and key order all survive an edit to a neighbour.
 */

export type FrontmatterValue =
  | { kind: 'text'; value: string }
  | { kind: 'list'; items: string[] }
  /** A nested map, or anything else a two-column table cannot honestly edit. */
  | { kind: 'raw'; source: string };

export type FrontmatterField = FrontmatterValue & { key: string };

export interface Frontmatter {
  fields: FrontmatterField[];
  /**
   * Set when the block is not a plain mapping — a bare list, a scalar, or YAML
   * that does not parse. The table shows the source read-only rather than
   * rewriting something it does not understand.
   */
  unsupported: boolean;
}

const EMPTY: Frontmatter = { fields: [], unsupported: false };

/**
 * The leading `---` block of a markdown document, as meowdown's own parser
 * delimits it: three dashes on their own line, a body, and a closing fence.
 * `null` when there is none — a `---` with no closing fence is a thematic rule.
 *
 * A copy of a rule that lives inside `@meowdown/core` and is not exported. It
 * is needed here because `setState` peels the block off but drops it (see
 * `writeAttr`), so the host has to put it back.
 */
const BLOCK = /^---[ \t]*\r?\n([\s\S]*?\n)?---[ \t]*(?:\r?\n|$)/;

export function frontmatterOf(markdown: string): string | null {
  const match = BLOCK.exec(markdown);
  if (match === null) return null;
  return (match[1] ?? '').replace(/\r?\n$/, '');
}

/** The block held on the document, or `null` when it has none. */
export function readAttr(editor: TypedEditor): string | null {
  const value: unknown = editor.state.doc.attrs.frontmatter;
  return typeof value === 'string' ? value : null;
}

/**
 * Writes the block onto the document as an ordinary undoable step, unless
 * `silent` — which loading a file is, since the load is not an edit.
 */
export function writeAttr(editor: TypedEditor, value: string | null, silent = false): void {
  editor.exec((state, dispatch) => {
    if (state.doc.attrs.frontmatter === value) return false;
    const tr = state.tr.setDocAttribute('frontmatter', value);
    dispatch?.(silent ? tr.setMeta('addToHistory', false) : tr);
    return true;
  });
}

export function readFrontmatter(body: string): Frontmatter {
  if (body.trim() === '') return EMPTY;

  const doc = parseDocument(body);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return { fields: [], unsupported: true };

  const fields: FrontmatterField[] = [];
  for (const item of doc.contents.items) {
    if (!isScalar(item.key)) return { fields: [], unsupported: true };
    fields.push({ key: String(item.key.value), ...readValue(item.value, body) });
  }
  return { fields, unsupported: false };
}

function readValue(value: unknown, body: string): FrontmatterValue {
  if (value === null || value === undefined) return { kind: 'text', value: '' };
  if (isScalar(value)) return { kind: 'text', value: displayValue(value.value) };
  if (isSeq(value) && value.items.every((item) => isScalar(item))) {
    return {
      kind: 'list',
      items: value.items.map((item) => (isScalar(item) ? displayValue(item.value) : '')),
    };
  }
  return { kind: 'raw', source: sourceOf(value, body) };
}

/**
 * A YAML scalar as the text the table shows for it. Everything the core schema
 * produces is a string, number, boolean or null; anything else would be a tag
 * we do not edit, and reads as empty rather than as `[object Object]`.
 */
export function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return '';
}

/**
 * The source text of a value, dedented to its own left edge: the slice starts
 * at the value, so its first line carries no indent while the rest still carry
 * the block's, and printing that verbatim reads as a stray step to the right.
 */
function sourceOf(node: unknown, body: string): string {
  const range = isNode(node) ? node.range : null;
  if (range === null || range === undefined) return '';
  const text = body.slice(range[0], range[1]).trimEnd();
  const indent = range[0] - (body.lastIndexOf('\n', range[0] - 1) + 1);
  if (indent === 0 || !text.includes('\n')) return text;
  const margin = new RegExp(`^ {0,${String(indent)}}`);
  return text
    .split('\n')
    .map((line, index) => (index === 0 ? line : line.replace(margin, '')))
    .join('\n');
}

/**
 * A value typed into the table, read the way YAML itself would read it: `42`
 * stays a number, `true` a boolean, `[a, b]` a list. Anything that parses to a
 * map — or does not parse at all — is kept as the literal text, so a stray `:`
 * becomes a quoted string instead of restructuring the block.
 *
 * An emptied field becomes `null`, which prints as a bare `key:` — the shape a
 * property with no value has when it is written by hand.
 */
export function parseInput(text: string): unknown {
  if (text === '') return null;
  if (text.includes('\n') || text.trim() === '') return text;
  let doc: Document.Parsed;
  try {
    doc = parseDocument(text);
  } catch {
    return text;
  }
  if (doc.errors.length > 0) return text;
  const node = doc.contents;
  if (isScalar(node)) return node.value;
  if (isSeq(node) && node.items.every((item) => isScalar(item))) return node.toJSON();
  return text;
}

/** Whether `key` can be added without colliding with an existing property. */
export function isFreeKey(body: string, key: string): boolean {
  if (key.trim() === '') return false;
  return !readFrontmatter(body).fields.some((field) => field.key === key);
}

export function setField(body: string, key: string, text: string): string {
  return edit(body, (doc, map) => {
    write(doc, map, key, parseInput(text));
  });
}

/** Blank items are dropped: an empty row in the editor is a row being typed. */
export function setListField(body: string, key: string, items: string[]): string {
  const kept = items.filter((item) => item.trim() !== '');
  return edit(body, (doc, map) => {
    write(
      doc,
      map,
      key,
      kept.map((item) => parseInput(item))
    );
  });
}

export function addField(body: string, key: string): string {
  return edit(body, (doc, map) => {
    if (findPair(map, key) === undefined) write(doc, map, key, null);
  });
}

function write(doc: Document, map: YAMLMap, key: string, value: unknown): void {
  const pair = findPair(map, key);
  const node = doc.createNode(value);
  if (pair === undefined) map.add(new Pair(doc.createNode(key), node));
  else pair.value = node;
}

/**
 * Renames a property in place. The pair is rewritten rather than deleted and
 * re-added so the property keeps its row — reordering the block on a rename
 * would be a second, unasked-for edit.
 */
export function renameField(body: string, from: string, to: string): string {
  if (from === to || to.trim() === '') return body;
  return edit(body, (doc, map) => {
    const pair = findPair(map, from);
    if (pair === undefined || findPair(map, to) !== undefined) return;
    pair.key = doc.createNode(to);
  });
}

export function removeField(body: string, key: string): string {
  return edit(body, (_doc, map) => {
    map.delete(key);
  });
}

function findPair(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((item) => isScalar(item.key) && String(item.key.value) === key);
}

/**
 * Re-prints the block after a mutation. Returns `body` untouched when the YAML
 * is not a mapping we can edit, so a caller never turns an unsupported block
 * into a rewritten one.
 *
 * `lineWidth: 0` is what keeps a long value on its own line: the printer's
 * default is to fold at 80 columns, which would rewrite lines nobody touched.
 */
function edit(body: string, mutate: (doc: Document, map: YAMLMap) => void): string {
  const doc = body.trim() === '' ? new Document({}) : parseDocument(body);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return body;
  mutate(doc, doc.contents);
  // An empty mapping prints as `{}`; the block it belongs to is simply empty.
  if (doc.contents.items.length === 0) return '';
  return doc.toString({ lineWidth: 0, nullStr: '' }).replace(/\n$/, '');
}
