import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * One address per environment: the installed app is `2233`, development is
 * `2234`. Both are the page — there, this dev server; in production, the daemon
 * serving its own built assets — so the shape of the two is the same and only
 * the number has to be remembered.
 *
 * `strictPort` because the fallback would be to take the next port, which is
 * the daemon's.
 */
const PAGE_PORT = 2234;

/**
 * The daemon behind it, which nothing types: dev talks to it only through the
 * proxy below. It is a port away from the page so the pair stays legible, and
 * `MD_PORT` moves it — the daemon's own dev script reads the same variable and
 * the same default.
 */
const DAEMON = `http://127.0.0.1:${process.env.MD_PORT ?? '2235'}`;

export default defineConfig({
  plugins: [react({ compiler: true }), tailwindcss()],
  optimizeDeps: {
    exclude: ['@xlsama/md'],
  },
  server: {
    port: PAGE_PORT,
    strictPort: true,
    open: true,
    proxy: {
      '/api': { target: DAEMON, changeOrigin: false },
      '/raw': { target: DAEMON, changeOrigin: false },
      '/ws': { target: DAEMON, ws: true, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
