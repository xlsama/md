import { describe, expect, test } from 'bun:test';
import { AUTO_PREF, manualPref, readTocPref, tocPrefValue, tocView } from '../src/lib/toc-panel.ts';

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

describe('tocView', () => {
  test('a wide viewport docks the outline until the user collapses it', () => {
    expect(tocView(AUTO_PREF, true, false)).toBe('docked');
    expect(tocView(manualPref(true), true, false)).toBe('docked');
    expect(tocView(manualPref(false), true, false)).toBe('collapsed');
  });

  test('a narrow viewport shows nothing but the button until it is hovered', () => {
    for (const pref of [AUTO_PREF, manualPref(true), manualPref(false)]) {
      expect(tocView(pref, false, false)).toBe('collapsed');
      expect(tocView(pref, false, true)).toBe('popover');
    }
  });

  test('hovering does not disturb the docked panel', () => {
    expect(tocView(AUTO_PREF, true, true)).toBe('docked');
    expect(tocView(manualPref(false), true, true)).toBe('collapsed');
  });
});

describe('state machine', () => {
  test('a preference set on a wide viewport waits for the next wide one', () => {
    let pref = AUTO_PREF;
    expect(tocView(pref, true, false)).toBe('docked');
    expect(tocView(pref, false, false)).toBe('collapsed');

    // Collapsing on a wide viewport sticks even though auto would dock.
    pref = manualPref(false);
    expect(tocView(pref, true, false)).toBe('collapsed');
    // Narrowing puts the outline back on its button, hover and all...
    expect(tocView(pref, false, true)).toBe('popover');
    // ...and widening again returns to the panel the user had collapsed.
    expect(tocView(pref, true, false)).toBe('collapsed');
  });
});
