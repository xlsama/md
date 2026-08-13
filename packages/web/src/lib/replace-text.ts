import type { TypedEditor } from '@meowdown/core';

/** The part of a ProseMirror document the search below actually reads. */
export interface TextTree {
  descendants(visitor: (node: { isText: boolean; text?: string }, pos: number) => void): void;
}

/**
 * Every place `needle` occurs as literal text in the document.
 *
 * Matches are confined to single text nodes on purpose: a URL that ProseMirror
 * split across marks is one the editor is mid-edit on, and skipping it (the
 * caller simply replaces nothing) beats splicing text across mark boundaries.
 */
export function findTextRanges(doc: TextTree, needle: string): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  if (needle === '') return ranges;
  doc.descendants((node, pos) => {
    if (!node.isText || node.text === undefined) return;
    let index = node.text.indexOf(needle);
    while (index !== -1) {
      ranges.push({ from: pos + index, to: pos + index + needle.length });
      index = node.text.indexOf(needle, index + needle.length);
    }
  });
  return ranges;
}

/**
 * Replaces every literal occurrence of `needle` in the editor with `next`, as
 * one undoable edit. Answers how many places changed — zero when the text is
 * not there any more, which is what makes callers safe against the document
 * having moved on (switched, edited, undone) since they looked.
 *
 * Applied back to front so earlier replacements cannot shift the positions of
 * later ones.
 */
export function replaceTextInEditor(editor: TypedEditor, needle: string, next: string): number {
  const { view } = editor;
  const ranges = findTextRanges(view.state.doc, needle);
  if (ranges.length === 0) return 0;
  let tr = view.state.tr;
  for (const range of [...ranges].reverse()) {
    tr = tr.insertText(next, range.from, range.to);
  }
  view.dispatch(tr);
  return ranges.length;
}
