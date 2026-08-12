import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const DAEMON = `http://127.0.0.1:${process.env.MD_PORT ?? '2233'}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    exclude: ['mdopen'],
  },
  server: {
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
