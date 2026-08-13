import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS, type Settings } from '@xlsama/md/protocol';
import {
  committableForm,
  formErrors,
  formPatch,
  hasErrors,
  isFormDirty,
  readCachedSettings,
  toForm,
} from '../src/lib/settings.ts';

const custom: Settings = {
  theme: 'dark',
  format: { autocorrect: false, oxfmt: true },
  assetsDir: '图片',
  linkEmbeds: false,
  saveDebounceMs: 800,
  sidebarOpen: true,
  sidebarWidth: 320,
};

describe('readCachedSettings', () => {
  test('an empty or broken mirror falls back to the defaults', () => {
    expect(readCachedSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(readCachedSettings('not json')).toEqual(DEFAULT_SETTINGS);
    expect(readCachedSettings('null')).toEqual(DEFAULT_SETTINGS);
    expect(readCachedSettings('[]')).toEqual(DEFAULT_SETTINGS);
  });

  test('round-trips a full configuration', () => {
    expect(readCachedSettings(JSON.stringify(custom))).toEqual(custom);
  });

  test('keeps the fields it can read and defaults the rest', () => {
    expect(readCachedSettings(JSON.stringify({ theme: 'light', saveDebounceMs: 12 }))).toEqual({
      ...DEFAULT_SETTINGS,
      theme: 'light',
    });
  });
});

describe('toForm', () => {
  test('flattens the settings and leaves sidebarOpen behind', () => {
    expect(toForm(custom)).toEqual({
      theme: 'dark',
      autocorrect: false,
      oxfmt: true,
      assetsDir: '图片',
      linkEmbeds: false,
      saveDebounceMs: '800',
    });
  });
});

describe('isFormDirty', () => {
  test('an untouched form is clean', () => {
    expect(isFormDirty(toForm(custom), custom)).toBe(false);
  });

  test('sidebarOpen changing behind the dialog does not dirty it', () => {
    expect(isFormDirty(toForm(custom), { ...custom, sidebarOpen: false })).toBe(false);
  });

  test('every field the form owns marks it dirty', () => {
    const dirty = [
      { theme: 'light' as const },
      { autocorrect: true },
      { oxfmt: false },
      { assetsDir: 'assets' },
      { linkEmbeds: true },
      { saveDebounceMs: '900' },
    ];
    for (const patch of dirty) {
      expect(isFormDirty({ ...toForm(custom), ...patch }, custom)).toBe(true);
    }
  });

  test('whitespace around an unchanged number is not a change', () => {
    expect(isFormDirty({ ...toForm(custom), saveDebounceMs: ' 800 ' }, custom)).toBe(false);
  });
});

describe('formErrors', () => {
  test('a valid form has none', () => {
    expect(hasErrors(formErrors(toForm(custom)))).toBe(false);
  });

  test('the image folder has to be a single segment', () => {
    for (const assetsDir of ['', ' ', '.', '..', 'a/b', 'a\\b', ' assets']) {
      expect(`${assetsDir}: ${String(hasErrors(formErrors({ ...toForm(custom), assetsDir })))}`).toBe(
        `${assetsDir}: true`
      );
    }
  });

  test('the debounce has to be a whole number in range', () => {
    for (const saveDebounceMs of ['', '0', '99', '5001', '250.5', 'soon']) {
      expect(
        `${saveDebounceMs}: ${String(hasErrors(formErrors({ ...toForm(custom), saveDebounceMs })))}`
      ).toBe(`${saveDebounceMs}: true`);
    }
    for (const saveDebounceMs of ['100', '500', '5000']) {
      expect(
        `${saveDebounceMs}: ${String(hasErrors(formErrors({ ...toForm(custom), saveDebounceMs })))}`
      ).toBe(`${saveDebounceMs}: false`);
    }
  });
});

describe('committableForm', () => {
  test('a valid form is handed back untouched', () => {
    const form = { ...toForm(custom), assetsDir: 'img', saveDebounceMs: '900' };
    expect(committableForm(form, custom)).toBe(form);
  });

  test('a half-typed field keeps the value that is in effect', () => {
    expect(committableForm({ ...toForm(custom), assetsDir: '' }, custom).assetsDir).toBe('图片');
    expect(committableForm({ ...toForm(custom), saveDebounceMs: '1' }, custom).saveDebounceMs).toBe(
      '800'
    );
  });

  test('the fields beside it are still written', () => {
    const form = { ...toForm(custom), saveDebounceMs: '', oxfmt: false, assetsDir: 'img' };
    expect(committableForm(form, custom)).toEqual({
      ...toForm(custom),
      oxfmt: false,
      assetsDir: 'img',
    });
  });
});

describe('formPatch', () => {
  test('rebuilds the nested shape the daemon expects', () => {
    expect(formPatch(toForm(custom))).toEqual({
      theme: 'dark',
      format: { autocorrect: false, oxfmt: true },
      assetsDir: '图片',
      linkEmbeds: false,
      saveDebounceMs: 800,
    });
  });
});
