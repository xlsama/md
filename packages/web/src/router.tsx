import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { App } from './app.tsx';
import { EDITOR_SCROLL_SELECTOR } from './lib/scroll.ts';
import { locationScrollKey, validateFileSearch } from './lib/route.ts';

/**
 * One route, no generated route tree.
 *
 * The app is a single screen served at `/`; the router is here for two things
 * only — putting the open document in the address bar as `?file=`, and the
 * per-document scroll memory that hangs off that parameter — so the file-based
 * router and its codegen step would be all cost and no benefit.
 */
const rootRoute = createRootRoute();

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: validateFileSearch,
  component: App,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute]),
  // Turns on the cache that snapshots scroll offsets before a navigation and
  // persists them to sessionStorage on `pagehide`, which is what survives a
  // reload. The restore it performs on its own is early — the document arrives
  // over the WebSocket a moment later — so `editor.tsx` re-applies the offset
  // once the text is in; see the container's `data-scroll-restoration-id`.
  scrollRestoration: true,
  getScrollRestorationKey: locationScrollKey,
  // Names the editor container as a scroll-to-top target. That keeps the
  // cache from carrying the previous document's offset over to a file being
  // opened for the first time, which is the router's default for elements it
  // considers persistent chrome.
  scrollToTopSelectors: [EDITOR_SCROLL_SELECTOR],
  scrollRestorationBehavior: 'instant',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
