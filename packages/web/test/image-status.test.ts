import { describe, expect, test } from 'bun:test';
import {
  ImageOutcomeMemo,
  RetryBudget,
  classifyImage,
  isCurrentFailure,
  type ImageProbe,
} from '../src/lib/image-status.ts';

function probe(overrides: Partial<ImageProbe> = {}): ImageProbe {
  return {
    src: 'https://cdn.example/a.png',
    complete: false,
    naturalWidth: 0,
    errored: false,
    ...overrides,
  };
}

describe('classifyImage', () => {
  test('an unfinished, unknown image is loading', () => {
    expect(classifyImage(probe(), new ImageOutcomeMemo())).toBe('loading');
  });

  test('finished with pixels is loaded', () => {
    const state = classifyImage(
      probe({ complete: true, naturalWidth: 800 }),
      new ImageOutcomeMemo()
    );
    expect(state).toBe('loaded');
  });

  test('a confirmed error on the current source is a failure', () => {
    expect(classifyImage(probe({ complete: true, errored: true }), new ImageOutcomeMemo())).toBe(
      'failed'
    );
  });

  test('finished without pixels, but never seen to fail, is still loading', () => {
    // `complete` goes true in the gap between two sources as well, so on its own
    // it says nothing about whether the picture is broken.
    expect(classifyImage(probe({ complete: true }), new ImageOutcomeMemo())).toBe('loading');
  });

  test('an element with no source is never reported as failed', () => {
    expect(classifyImage(probe({ src: '', complete: true }), new ImageOutcomeMemo())).toBe(
      'loading'
    );
  });

  test('a remembered success skips the skeleton on a rebuilt element', () => {
    const memo = new ImageOutcomeMemo();
    memo.record('https://cdn.example/a.png', 'loaded');
    expect(classifyImage(probe(), memo)).toBe('loaded');
  });

  test('a remembered failure shows the placeholder immediately', () => {
    const memo = new ImageOutcomeMemo();
    memo.record('https://cdn.example/a.png', 'failed');
    expect(classifyImage(probe(), memo)).toBe('failed');
  });

  test('live pixels beat a stale failure memory', () => {
    const memo = new ImageOutcomeMemo();
    memo.record('https://cdn.example/a.png', 'failed');
    expect(classifyImage(probe({ complete: true, naturalWidth: 12 }), memo)).toBe('loaded');
  });

  test('memory is per URL', () => {
    const memo = new ImageOutcomeMemo();
    memo.record('https://cdn.example/a.png', 'failed');
    expect(classifyImage(probe({ src: 'https://cdn.example/b.png' }), memo)).toBe('loading');
  });
});

/**
 * The paste sequence the fix is about: an image that appears, is briefly
 * pointed at one source, and settles on another. It has to shimmer from the
 * first frame — never «加载失败» first — and only a failure that is still
 * current when it is confirmed may paint.
 */
describe('a newly inserted image', () => {
  const RESOLVED = 'http://127.0.0.1:2233/raw/notes/assets/shot.png';
  const INTERIM = 'http://127.0.0.1:2233/assets/shot.png';

  test('starts as a shimmer, not as a failure card', () => {
    const memo = new ImageOutcomeMemo();
    // The element exists and has a source, but nothing has happened to it yet.
    expect(classifyImage(probe({ src: RESOLVED }), memo)).toBe('loading');
    // …and it stays a shimmer even once the browser calls the element complete,
    // which it does in the moment between two sources.
    expect(classifyImage(probe({ src: RESOLVED, complete: true }), memo)).toBe('loading');
  });

  test('an error on the source it no longer has is dropped', () => {
    // The interim source really did 404 — but the element has moved on, so the
    // failure is not this element's any more.
    expect(isCurrentFailure(INTERIM, RESOLVED)).toBe(false);
    expect(classifyImage(probe({ src: RESOLVED, complete: true, errored: false }), new ImageOutcomeMemo())).toBe(
      'loading'
    );
  });

  test('an error that is still current does paint, and is remembered', () => {
    expect(isCurrentFailure(RESOLVED, RESOLVED)).toBe(true);
    const memo = new ImageOutcomeMemo();
    expect(classifyImage(probe({ src: RESOLVED, complete: true, errored: true }), memo)).toBe(
      'failed'
    );
    memo.record(RESOLVED, 'failed');
    // A rebuilt element for the same URL skips the skeleton rather than
    // re-flashing it on every keystroke.
    expect(classifyImage(probe({ src: RESOLVED }), memo)).toBe('failed');
  });

  test('the picture wins the moment it has pixels, whatever was remembered', () => {
    const memo = new ImageOutcomeMemo();
    memo.record(RESOLVED, 'failed');
    expect(
      classifyImage(probe({ src: RESOLVED, complete: true, naturalWidth: 200, errored: true }), memo)
    ).toBe('loaded');
  });
});

describe('isCurrentFailure', () => {
  test('an element that never errored has no failure', () => {
    expect(isCurrentFailure(undefined, 'https://cdn.example/a.png')).toBe(false);
  });

  test('a blank recorded source is never current', () => {
    expect(isCurrentFailure('', '')).toBe(false);
  });
});

describe('ImageOutcomeMemo', () => {
  test('records and reads back an outcome', () => {
    const memo = new ImageOutcomeMemo();
    expect(memo.get('a')).toBeUndefined();
    memo.record('a', 'loaded');
    expect(memo.get('a')).toBe('loaded');
    memo.record('a', 'failed');
    expect(memo.get('a')).toBe('failed');
    expect(memo.size).toBe(1);
  });

  test('ignores a blank source', () => {
    const memo = new ImageOutcomeMemo();
    memo.record('', 'failed');
    expect(memo.size).toBe(0);
    expect(memo.get('')).toBeUndefined();
  });

  test('evicts the oldest entry past the limit', () => {
    const memo = new ImageOutcomeMemo(2);
    memo.record('a', 'loaded');
    memo.record('b', 'loaded');
    memo.record('c', 'loaded');
    expect(memo.size).toBe(2);
    expect(memo.get('a')).toBeUndefined();
    expect(memo.get('c')).toBe('loaded');
  });

  test('re-recording refreshes a URL so it is not the next evicted', () => {
    const memo = new ImageOutcomeMemo(2);
    memo.record('a', 'loaded');
    memo.record('b', 'loaded');
    memo.record('a', 'loaded');
    memo.record('c', 'loaded');
    expect(memo.get('a')).toBe('loaded');
    expect(memo.get('b')).toBeUndefined();
  });
});

describe('RetryBudget', () => {
  test('hands out numbered attempts, then refuses', () => {
    const budget = new RetryBudget(2);
    expect(budget.take('a')).toBe(1);
    expect(budget.take('a')).toBe(2);
    expect(budget.take('a')).toBeNull();
    // The budget is per URL, not global.
    expect(budget.take('b')).toBe(1);
  });

  test('a blank source never gets a retry', () => {
    const budget = new RetryBudget(2);
    expect(budget.take('')).toBeNull();
  });

  test('evicts the oldest URL past the limit, which resets its count', () => {
    const budget = new RetryBudget(1, 2);
    expect(budget.take('a')).toBe(1);
    expect(budget.take('b')).toBe(1);
    expect(budget.take('c')).toBe(1);
    // `a` was evicted to make room, so a new failure starts a fresh budget.
    expect(budget.take('a')).toBe(1);
  });
});
