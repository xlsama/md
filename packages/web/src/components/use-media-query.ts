import { useEffect } from 'react';

/**
 * Reports a media query's state to `onChange` — once on mount, then on every
 * flip. `onChange` has to keep its identity across renders (a store setter
 * does), or the subscription is torn down and rebuilt on each one.
 */
export function useMediaQuery(query: string, onChange: (matches: boolean) => void): void {
  useEffect(() => {
    const media = window.matchMedia(query);
    const sync = () => {
      onChange(media.matches);
    };
    sync();
    media.addEventListener('change', sync);
    return () => {
      media.removeEventListener('change', sync);
    };
  }, [query, onChange]);
}
