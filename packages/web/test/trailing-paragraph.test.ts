import { describe, expect, test } from 'bun:test';
import { markdownToDoc } from '@meowdown/core';
import type { Node as ProseMirrorNode } from '@prosekit/pm/model';
import { endsWithEmptyParagraph, isBelowLastBlock } from '../src/lib/trailing-paragraph.ts';

const box = (bottom: number) => ({ getBoundingClientRect: () => ({ bottom }) });

/** What one click in the empty space leaves behind, ready for the next one. */
const withTrailingParagraph = (doc: ProseMirrorNode): ProseMirrorNode =>
  doc.copy(doc.content.addToEnd(doc.type.schema.nodes.paragraph!.create()));

describe('isBelowLastBlock', () => {
  test('a click under the last block is in the empty space', () => {
    expect(isBelowLastBlock(box(400), 401)).toBe(true);
  });

  test('a click on the last block, or above it, is not', () => {
    expect(isBelowLastBlock(box(400), 400)).toBe(false);
    expect(isBelowLastBlock(box(400), 120)).toBe(false);
  });

  test('an editor with nothing rendered takes every click', () => {
    expect(isBelowLastBlock(null, 0)).toBe(true);
  });
});

describe('endsWithEmptyParagraph', () => {
  test('a document ending in text needs a paragraph appended', () => {
    expect(endsWithEmptyParagraph(markdownToDoc('# Title\n\n正文。\n'))).toBe(false);
  });

  test('the paragraph a previous click appended is the one to write in', () => {
    expect(endsWithEmptyParagraph(withTrailingParagraph(markdownToDoc('正文。\n')))).toBe(true);
  });

  // Markdown drops trailing blank lines, so a freshly loaded file never ends in
  // one: the first click in the empty space always has a paragraph to add.
  test('a file loaded from disk never ends in an empty paragraph', () => {
    expect(endsWithEmptyParagraph(markdownToDoc('正文。\n\n\n'))).toBe(false);
  });

  test('a list, a code block or a heading at the end is not one', () => {
    expect(endsWithEmptyParagraph(markdownToDoc('- 使用 md 打开 Markdown 文件\n'))).toBe(false);
    expect(endsWithEmptyParagraph(markdownToDoc('```ts\nconst a = 1;\n```\n'))).toBe(false);
    expect(endsWithEmptyParagraph(markdownToDoc('## 操作偏好\n'))).toBe(false);
  });

  test('an empty document already ends in one', () => {
    expect(endsWithEmptyParagraph(markdownToDoc(''))).toBe(true);
  });
});
