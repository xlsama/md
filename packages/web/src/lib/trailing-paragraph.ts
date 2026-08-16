import type { TypedEditor } from '@meowdown/core';
import type { Node as ProseMirrorNode } from '@prosekit/pm/model';
import { TextSelection } from '@prosekit/pm/state';

/** The part of the last rendered block the hit test below actually reads. */
export interface BlockBox {
  getBoundingClientRect(): { bottom: number };
}

/**
 * Whether a click at `clientY` landed under the text rather than in it.
 *
 * The editor stretches to fill its column and carries a tail of padding, so a
 * document always has empty space below its last block — clicking there is the
 * gesture this module answers. A missing block (an editor with nothing in it
 * yet) counts as "below": every click is under the text when there is none.
 */
export function isBelowLastBlock(last: BlockBox | null, clientY: number): boolean {
  return last === null || clientY > last.getBoundingClientRect().bottom;
}

/**
 * Whether the document already ends in a paragraph the caret can be put in
 * without adding anything. This is what keeps repeated clicks in the empty
 * space from stacking blank lines into the file.
 */
export function endsWithEmptyParagraph(doc: ProseMirrorNode): boolean {
  const last = doc.lastChild;
  return last !== null && last.type.name === 'paragraph' && last.content.size === 0;
}

/**
 * Puts the caret on an empty paragraph at the end of the document, appending
 * one first unless the document already ends in one.
 *
 * The new paragraph is a top-level one on purpose: the space below the text
 * belongs to the document, not to whatever list or code block the last line
 * happens to be inside, so a click there leaves that structure rather than
 * continuing it.
 */
export function focusTrailingParagraph(editor: TypedEditor): void {
  const { view } = editor;
  const { state } = view;
  const tr = endsWithEmptyParagraph(state.doc)
    ? state.tr
    : state.tr.insert(state.doc.content.size, editor.schema.nodes.paragraph.create());
  const end = TextSelection.near(tr.doc.resolve(tr.doc.content.size), -1);
  view.dispatch(tr.setSelection(end).scrollIntoView());
  view.focus();
}
