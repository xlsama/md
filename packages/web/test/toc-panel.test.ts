import { describe, expect, test } from 'bun:test';
import {
  AUTO_PREF,
  manualPref,
  readTocPref,
  resolveTocOpen,
  tocPrefValue,
  tocView,
} from '../src/lib/toc-panel.ts';

describe('readTocPref', () => {
  test('an absent value leaves the outline in auto mode', () => {
    expect(readTocPref(null)).toEqual({ manual: false });
    expect(readTocPref('')).toEqual({ manual: false });
    expect(readTocPref('yes')).toEqual({ manual: false });
  });

  test('reads back the value a previous toggle wrote', () => {
    expect(readTocPref('1')).toEqual({ manual: true, open: true });
    expect(readTocPref('0')).toEqual({ manual: true, open: false });
  });
});

describe('tocPrefValue', () => {
  test('auto mode persists nothing', () => {
    expect(tocPrefValue(AUTO_PREF)).toBeNull();
  });

  test('round-trips a manual choice', () => {
    for (const open of [true, false]) {
      const pref = manualPref(open);
      expect(readTocPref(tocPrefValue(pref))).toEqual(pref);
    }
  });
});

describe('resolveTocOpen', () => {
  test('auto mode follows the viewport', () => {
    expect(resolveTocOpen(AUTO_PREF, true)).toBe(true);
    expect(resolveTocOpen(AUTO_PREF, false)).toBe(false);
  });

  test('a manual choice wins at any width', () => {
    expect(resolveTocOpen(manualPref(false), true)).toBe(false);
    expect(resolveTocOpen(manualPref(true), false)).toBe(true);
  });
});

describe('tocView', () => {
  test('a closed outline is collapsed at any width', () => {
    expect(tocView(false, true)).toBe('collapsed');
    expect(tocView(false, false)).toBe('collapsed');
  });

  test('an open outline docks on wide viewports and floats on narrow ones', () => {
    expect(tocView(true, true)).toBe('docked');
    expect(tocView(true, false)).toBe('popover');
  });
});

describe('state machine', () => {
  test('a viewport change only moves an auto outline', () => {
    let pref = AUTO_PREF;
    expect(tocView(resolveTocOpen(pref, true), true)).toBe('docked');
    expect(tocView(resolveTocOpen(pref, false), false)).toBe('collapsed');

    // The user expands on a narrow viewport: a popover, and manual from now on.
    pref = manualPref(true);
    expect(tocView(resolveTocOpen(pref, false), false)).toBe('popover');
    // Growing past the breakpoint keeps it open, now docked.
    expect(tocView(resolveTocOpen(pref, true), true)).toBe('docked');
    // Collapsing on a wide viewport sticks even though auto would dock.
    pref = manualPref(false);
    expect(tocView(resolveTocOpen(pref, true), true)).toBe('collapsed');
  });
});
