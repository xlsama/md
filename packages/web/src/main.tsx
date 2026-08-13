import { RouterProvider } from '@tanstack/react-router';
import { createRoot } from 'react-dom/client';
import { router } from './router.tsx';
import { useStore } from './store.ts';
import { applyTheme } from './lib/theme.ts';
import './index.css';

const container = document.getElementById('root');
if (container === null) throw new Error('missing #root');

// The forced theme is applied before the first render, from the mirror of the
// last known settings — the daemon's copy arrives a WebSocket round trip later,
// which is long enough to see a light page flash past in a dark app.
applyTheme(useStore.getState().settings.theme);

// Deliberately not wrapped in StrictMode: its double-mount would tear down and
// rebuild the ProseMirror editor instance, dropping the loaded document.
createRoot(container).render(<RouterProvider router={router} />);
