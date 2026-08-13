import type { Theme } from 'mdopen/protocol';

export type ResolvedTheme = 'light' | 'dark';

export const DARK_QUERY = '(prefers-color-scheme: dark)';

/** What is actually on screen, once `system` has been resolved. */
export function resolveTheme(theme: Theme, system: ResolvedTheme): ResolvedTheme {
  return theme === 'system' ? system : theme;
}

/**
 * The value the two-state toggle writes: always the opposite of what is
 * currently rendered, so a user on `system` starts from the scheme they can
 * see rather than from an arbitrary default.
 */
export function toggledTheme(theme: Theme, system: ResolvedTheme): ResolvedTheme {
  return resolveTheme(theme, system) === 'dark' ? 'light' : 'dark';
}

export function systemTheme(): ResolvedTheme {
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

/**
 * Pins the color scheme on the document element.
 *
 * Every color in the app — ours, meowdown's, @pierre's — is a `light-dark()`
 * pair resolved against the *used* `color-scheme`, so one attribute is enough
 * to flip all three (see `index.css`). `system` removes the attribute and hands
 * the decision back to `prefers-color-scheme`.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.dataset.theme = theme;
}
