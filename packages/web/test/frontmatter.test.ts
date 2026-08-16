import { describe, expect, test } from 'bun:test';
import {
  addField,
  isFreeKey,
  parseInput,
  readFrontmatter,
  removeField,
  renameField,
  setField,
  setListField,
} from '../src/lib/frontmatter.ts';

describe('readFrontmatter', () => {
  test('reads scalars as text fields', () => {
    const model = readFrontmatter('name: wizard\ncount: 3\ndraft: true');
    expect(model.unsupported).toBe(false);
    expect(model.fields).toEqual([
      { key: 'name', kind: 'text', value: 'wizard' },
      { key: 'count', kind: 'text', value: '3' },
      { key: 'draft', kind: 'text', value: 'true' },
    ]);
  });

  test('reads a scalar sequence as a list field', () => {
    const model = readFrontmatter('tags:\n  - a\n  - b');
    expect(model.fields).toEqual([{ key: 'tags', kind: 'list', items: ['a', 'b'] }]);
  });

  test('reads a flow sequence as a list field too', () => {
    expect(readFrontmatter('tags: [a, b]').fields).toEqual([
      { key: 'tags', kind: 'list', items: ['a', 'b'] },
    ]);
  });

  test('an empty value reads as empty text, not as a missing field', () => {
    expect(readFrontmatter('name:').fields).toEqual([{ key: 'name', kind: 'text', value: '' }]);
  });

  test('keeps a nested map as raw source, dedented to its own left edge', () => {
    const model = readFrontmatter('name: a\nnested:\n  x: 1\n  y: 2');
    expect(model.fields[1]).toEqual({ key: 'nested', kind: 'raw', source: 'x: 1\ny: 2' });
  });

  test('an empty block has no fields and is still editable', () => {
    expect(readFrontmatter('')).toEqual({ fields: [], unsupported: false });
  });

  test('a non-mapping block is unsupported', () => {
    expect(readFrontmatter('- a\n- b').unsupported).toBe(true);
    expect(readFrontmatter('just a string').unsupported).toBe(true);
    expect(readFrontmatter('a: [').unsupported).toBe(true);
  });
});

describe('parseInput', () => {
  test('reads values the way YAML would', () => {
    expect(parseInput('42')).toBe(42);
    expect(parseInput('true')).toBe(true);
    expect(parseInput('hello')).toBe('hello');
    expect(parseInput('2026-08-16')).toBe('2026-08-16');
    expect(parseInput('[a, b]')).toEqual(['a', 'b']);
  });

  test('keeps text that would restructure the block as a literal string', () => {
    expect(parseInput('a: b')).toBe('a: b');
    expect(parseInput('line one\nline two')).toBe('line one\nline two');
  });

  test('an emptied field becomes null, which prints as a bare key', () => {
    expect(parseInput('')).toBeNull();
  });
});

describe('editing', () => {
  test('setField rewrites one value and leaves the rest byte-exact', () => {
    const body = "name: wizard\n# a comment\ndescription: 'quoted'\ntags:\n  - a\n  - b";
    expect(setField(body, 'description', 'plain')).toBe(
      'name: wizard\n# a comment\ndescription: plain\ntags:\n  - a\n  - b'
    );
  });

  test('setField appends an unknown key', () => {
    expect(setField('name: a', 'draft', 'true')).toBe('name: a\ndraft: true');
  });

  test('setField quotes a value that would otherwise parse as structure', () => {
    expect(setField('name: a', 'name', 'x: y')).toBe('name: "x: y"');
  });

  test('a long value stays on one line', () => {
    const long = 'Generate an interactive bash wizard that walks a human through steps only they can perform, which is a sentence well past eighty columns.';
    expect(setField('description: x', 'description', long)).toBe(`description: ${long}`);
  });

  test('setListField writes a block sequence', () => {
    expect(setListField('name: a', 'tags', ['x', 'y'])).toBe('name: a\ntags:\n  - x\n  - y');
  });

  test('renameField keeps the row in place', () => {
    expect(renameField('a: 1\nb: 2\nc: 3', 'b', 'z')).toBe('a: 1\nz: 2\nc: 3');
  });

  test('renameField refuses a collision or an empty name', () => {
    expect(renameField('a: 1\nb: 2', 'a', 'b')).toBe('a: 1\nb: 2');
    expect(renameField('a: 1', 'a', '  ')).toBe('a: 1');
  });

  test('removeField drops the row, and the last one empties the block', () => {
    expect(removeField('a: 1\nb: 2', 'a')).toBe('b: 2');
    expect(removeField('a: 1', 'a')).toBe('');
  });

  test('addField starts an empty property, including in an empty block', () => {
    expect(addField('', 'name')).toBe('name:');
    expect(addField('a: 1', 'b')).toBe('a: 1\nb:');
    expect(addField('a: 1', 'a')).toBe('a: 1');
  });

  test('clearing a value leaves a bare key rather than an empty string', () => {
    expect(setField('name: wizard', 'name', '')).toBe('name:');
  });

  test('setListField drops blank items', () => {
    expect(setListField('', 'tags', ['x', '  ', 'y'])).toBe('tags:\n  - x\n  - y');
  });

  test('an unsupported block is never rewritten', () => {
    expect(setField('- a\n- b', 'name', 'x')).toBe('- a\n- b');
    expect(removeField('a: [', 'a')).toBe('a: [');
  });

  test('isFreeKey rejects taken and blank names', () => {
    expect(isFreeKey('a: 1', 'b')).toBe(true);
    expect(isFreeKey('a: 1', 'a')).toBe(false);
    expect(isFreeKey('a: 1', ' ')).toBe(false);
  });
});
