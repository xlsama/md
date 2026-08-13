import { describe, expect, test } from 'bun:test';
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '@xlsama/md/protocol';
import { dragSidebar, SIDEBAR_COLLAPSE_WIDTH, sidebarShown } from '../src/lib/sidebar.ts';

describe('dragSidebar', () => {
  test('follows the pointer between the two limits', () => {
    expect(dragSidebar(256, 40)).toEqual({ width: 296, collapse: false });
    expect(dragSidebar(256, -40)).toEqual({ width: 216, collapse: false });
  });

  test('stops at the limits instead of running past them', () => {
    expect(dragSidebar(256, 9999).width).toBe(SIDEBAR_MAX_WIDTH);
    expect(dragSidebar(256, -100).width).toBe(SIDEBAR_MIN_WIDTH);
  });

  test('a trackpad’s fractional pointer still lands on a whole pixel', () => {
    // The settings schema stores integers; a fractional width would fail to save.
    expect(dragSidebar(256, 40.58)).toEqual({ width: 297, collapse: false });
  });

  test('a pull well past the minimum becomes a close', () => {
    // Narrower than the tree can be, but not yet far enough to mean it.
    expect(dragSidebar(256, -(256 - SIDEBAR_COLLAPSE_WIDTH))).toEqual({
      width: SIDEBAR_MIN_WIDTH,
      collapse: false,
    });
    expect(dragSidebar(256, -(256 - SIDEBAR_COLLAPSE_WIDTH) - 1)).toEqual({
      width: SIDEBAR_MIN_WIDTH,
      collapse: true,
    });
  });

  test('the collapse point is clear of the minimum width', () => {
    expect(SIDEBAR_COLLAPSE_WIDTH).toBeLessThan(SIDEBAR_MIN_WIDTH);
  });
});

describe('sidebarShown', () => {
  test('a closed tree stays closed however wide the window is', () => {
    expect(sidebarShown(false, false, false)).toBe(false);
    expect(sidebarShown(false, true, true)).toBe(false);
  });

  test('a narrow window folds an open tree away', () => {
    expect(sidebarShown(true, false, false)).toBe(true);
    expect(sidebarShown(true, true, false)).toBe(false);
  });

  test('the reader can have it back, narrow window and all', () => {
    expect(sidebarShown(true, true, true)).toBe(true);
  });

  test('widening the window restores what was folded away', () => {
    // The preference was never written to, so there is nothing to restore from.
    const open = true;
    expect(sidebarShown(open, true, false)).toBe(false);
    expect(sidebarShown(open, false, false)).toBe(true);
  });
});
