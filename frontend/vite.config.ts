import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        // The execution log stream is a WebSocket served under /api
        // (GET /api/execution/:id/stream), so this proxy must upgrade too —
        // without `ws` the socket silently fails to connect in dev while
        // every plain HTTP call keeps working.
        ws: true,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-utils/setup.ts'],
    server: {
      // react-design-kit's compiled ESM output omits the .js extension on
      // its own relative imports (dist/index.js imports './Button', not
      // './Button.js') — invalid under strict Node ESM resolution, which is
      // what Vitest uses for anything left external. Inlining forces it
      // through Vite's own (extension-tolerant) resolver instead, matching
      // how the real app already consumes it via `vite build`/`vite dev`.
      // No test imported from this package until useMultiViewSelection's
      // tests, which is why this never surfaced before.
      deps: { inline: ['react-design-kit'] },
    },
  },
});
