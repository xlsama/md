import { useEffect, useState } from 'react';
import { DARK_QUERY, systemTheme, type ResolvedTheme } from '../lib/theme.ts';

/**
 * The scheme the OS is asking for, kept current.
 *
 * In `system` mode the CSS follows `prefers-color-scheme` on its own; this is
 * for the parts that have to *know* — the toggle, which starts from whatever
 * the reader can see, and the label it shows.
 */
export function useSystemTheme(): ResolvedTheme {
  const [scheme, setScheme] = useState<ResolvedTheme>(systemTheme);

  useEffect(() => {
    const query = window.matchMedia(DARK_QUERY);
    const sync = () => {
      setScheme(query.matches ? 'dark' : 'light');
    };
    sync();
    query.addEventListener('change', sync);
    return () => {
      query.removeEventListener('change', sync);
    };
  }, []);

  return scheme;
}
