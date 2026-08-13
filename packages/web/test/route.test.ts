import { describe, expect, test } from 'bun:test';
import {
  decideWorkspace,
  readFileParam,
  scrollRestorationKey,
  validateFileSearch,
  type WorkspaceInput,
} from '../src/lib/route.ts';

describe('validateFileSearch', () => {
  test('keeps a workspace-relative path', () => {
    expect(validateFileSearch({ file: 'docs/alpha.md' })).toEqual({ file: 'docs/alpha.md' });
  });

  test('drops the key when there is no file', () => {
    expect(validateFileSearch({})).toEqual({});
    expect(validateFileSearch({ file: '' })).toEqual({});
  });

  test('ignores everything else in the URL', () => {
    expect(validateFileSearch({ file: 'a.md', theme: 'dark' })).toEqual({ file: 'a.md' });
  });

  test('a malformed parameter degrades to no file instead of throwing', () => {
    expect(validateFileSearch({ file: ['a.md', 'b.md'] })).toEqual({});
    expect(validateFileSearch({ file: 3 })).toEqual({});
  });
});

describe('readFileParam', () => {
  test('reads a string parameter', () => {
    expect(readFileParam({ file: 'a.md' })).toBe('a.md');
  });

  test('anything else reads as no file', () => {
    expect(readFileParam({})).toBeNull();
    expect(readFileParam({ file: '' })).toBeNull();
    expect(readFileParam({ file: 7 })).toBeNull();
    expect(readFileParam(null)).toBeNull();
    expect(readFileParam('file=a.md')).toBeNull();
  });
});

describe('scrollRestorationKey', () => {
  test('one bucket per document', () => {
    expect(scrollRestorationKey({ file: 'a.md' })).not.toBe(scrollRestorationKey({ file: 'b.md' }));
    expect(scrollRestorationKey({ file: 'a.md' })).toBe(scrollRestorationKey({ file: 'a.md' }));
  });

  test('an empty workspace still has a key', () => {
    expect(scrollRestorationKey({})).toBe(scrollRestorationKey({ file: '' }));
  });
});

const TREE = ['index.md', 'docs/alpha.md'];

function input(overrides: Partial<WorkspaceInput> = {}): WorkspaceInput {
  return {
    rootChanged: false,
    urlFile: null,
    focus: null,
    currentPath: null,
    dirty: false,
    exists: (path) => TREE.includes(path),
    ...overrides,
  };
}

describe('decideWorkspace', () => {
  test('a URL file beats the focus the daemon remembers', () => {
    expect(decideWorkspace(input({ urlFile: 'docs/alpha.md', focus: 'index.md' }))).toEqual({
      kind: 'open',
      path: 'docs/alpha.md',
    });
  });

  test('a URL file the workspace does not have falls back to the focus', () => {
    expect(decideWorkspace(input({ urlFile: 'gone.md', focus: 'index.md' }))).toEqual({
      kind: 'open',
      path: 'index.md',
    });
  });

  test('a URL file with nothing to fall back to opens nothing', () => {
    expect(decideWorkspace(input({ urlFile: 'gone.md' }))).toEqual({ kind: 'none' });
  });

  test('switching workspace drops the URL file and follows the new focus', () => {
    const action = decideWorkspace(
      input({ rootChanged: true, urlFile: 'index.md', focus: 'docs/alpha.md' })
    );
    expect(action).toEqual({ kind: 'open', path: 'docs/alpha.md' });
  });

  test('switching to a workspace without a focus closes the document', () => {
    expect(decideWorkspace(input({ rootChanged: true, currentPath: 'index.md' }))).toEqual({
      kind: 'close',
    });
  });

  test('reconnecting re-requests the open document', () => {
    expect(decideWorkspace(input({ currentPath: 'index.md' }))).toEqual({
      kind: 'resync',
      path: 'index.md',
    });
  });

  test('reconnecting leaves unsaved edits alone', () => {
    expect(decideWorkspace(input({ currentPath: 'index.md', dirty: true }))).toEqual({
      kind: 'none',
    });
  });

  test('the URL naming the open document is a resync, not a reload', () => {
    expect(decideWorkspace(input({ urlFile: 'index.md', currentPath: 'index.md' }))).toEqual({
      kind: 'resync',
      path: 'index.md',
    });
  });

  test('a focus always wins over the document already open', () => {
    expect(decideWorkspace(input({ focus: 'docs/alpha.md', currentPath: 'index.md' }))).toEqual({
      kind: 'open',
      path: 'docs/alpha.md',
    });
  });

  test('an empty workspace with nothing open does nothing', () => {
    expect(decideWorkspace(input())).toEqual({ kind: 'none' });
  });
});
