import { describe, expect, test } from 'bun:test';
import {
  classifyExternal,
  resolveSaved,
  shouldReflow,
  type PendingFormatted,
  type ReflowState,
} from '../src/lib/sync.ts';

const pending: PendingFormatted = { path: 'a.md', content: '# A\n', hash: 'h2' };

function reflowState(overrides: Partial<ReflowState> = {}): ReflowState {
  return {
    pending,
    currentPath: 'a.md',
    dirty: false,
    saving: false,
    editorContent: '#A',
    ...overrides,
  };
}

describe('shouldReflow', () => {
  test('flows formatted text back when the editor is idle', () => {
    expect(shouldReflow(reflowState())).toBe(true);
  });

  test('never interrupts typing', () => {
    expect(shouldReflow(reflowState({ dirty: true }))).toBe(false);
    expect(shouldReflow(reflowState({ saving: true }))).toBe(false);
  });

  test('nothing staged, or staged for another document', () => {
    expect(shouldReflow(reflowState({ pending: null }))).toBe(false);
    expect(shouldReflow(reflowState({ currentPath: 'b.md' }))).toBe(false);
    expect(shouldReflow(reflowState({ currentPath: null }))).toBe(false);
  });

  test('no-op when the editor already holds the formatted text', () => {
    expect(shouldReflow(reflowState({ editorContent: '# A\n' }))).toBe(false);
  });
});

describe('resolveSaved', () => {
  const saved = { path: 'a.md', content: '# A\n', hash: 'h2' };

  test('formatted result differing from what we sent is staged, not applied', () => {
    const out = resolveSaved(
      { currentPath: 'a.md', sentContent: '#A', editedWhileSaving: false },
      saved
    );
    expect(out).toEqual({
      baseHash: 'h2',
      dirty: false,
      pending: { path: 'a.md', content: '# A\n', hash: 'h2' },
      resave: false,
    });
  });

  test('an unchanged round trip stages nothing', () => {
    const out = resolveSaved(
      { currentPath: 'a.md', sentContent: '# A\n', editedWhileSaving: false },
      saved
    );
    expect(out.pending).toBeNull();
    expect(out.dirty).toBe(false);
  });

  test('edits during the flight keep the document dirty and trigger a resave', () => {
    const out = resolveSaved(
      { currentPath: 'a.md', sentContent: '#A', editedWhileSaving: true },
      saved
    );
    expect(out).toEqual({ baseHash: 'h2', dirty: true, pending: null, resave: true });
  });

  test('an ack for a document we already left is inert', () => {
    const out = resolveSaved(
      { currentPath: 'b.md', sentContent: '#A', editedWhileSaving: true },
      saved
    );
    expect(out).toEqual({ baseHash: 'h2', dirty: false, pending: null, resave: false });
  });
});

describe('classifyExternal', () => {
  const base = { currentPath: 'a.md', baseHash: 'h1', dirty: false, editorContent: 'mine' };
  const msg = { path: 'a.md', content: 'disk', hash: 'h2' };

  test('other documents and already-known hashes are ignored', () => {
    expect(classifyExternal(base, { ...msg, path: 'b.md' })).toBe('ignore');
    expect(classifyExternal({ ...base, currentPath: null }, msg)).toBe('ignore');
    expect(classifyExternal(base, { ...msg, hash: 'h1' })).toBe('ignore');
  });

  test('identical text only rebases the hash', () => {
    expect(classifyExternal(base, { ...msg, content: 'mine' })).toBe('rebase');
    expect(classifyExternal({ ...base, dirty: true }, { ...msg, content: 'mine' })).toBe('rebase');
  });

  test('a clean editor takes the disk content, a dirty one raises a conflict', () => {
    expect(classifyExternal(base, msg)).toBe('refresh');
    expect(classifyExternal({ ...base, dirty: true }, msg)).toBe('conflict');
  });
});
