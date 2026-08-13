import { describe, expect, test } from 'bun:test';
import { resolveTheme, toggledTheme } from '../src/lib/theme.ts';

describe('resolveTheme', () => {
  test('system defers to the OS, a choice does not', () => {
    expect(resolveTheme('system', 'dark')).toBe('dark');
    expect(resolveTheme('system', 'light')).toBe('light');
    expect(resolveTheme('light', 'dark')).toBe('light');
    expect(resolveTheme('dark', 'light')).toBe('dark');
  });
});

describe('toggledTheme', () => {
  test('always flips what is on screen', () => {
    expect(toggledTheme('light', 'light')).toBe('dark');
    expect(toggledTheme('dark', 'light')).toBe('light');
  });

  test('on system, the flip starts from the OS scheme', () => {
    expect(toggledTheme('system', 'dark')).toBe('light');
    expect(toggledTheme('system', 'light')).toBe('dark');
  });
});
