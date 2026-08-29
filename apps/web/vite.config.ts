import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Point at the SOURCE, not the workspace symlink. Vite does not
      // transform files under node_modules by default, and @dia/shared ships
      // TypeScript rather than a build — aliasing keeps the schema a single
      // source of truth without adding a build step to the shared package.
      '@dia/shared': resolve(here, '../../packages/shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    // Proxy in dev so the app can use relative /api URLs and never needs to
    // know where the API lives. One less environment variable to get wrong.
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL ?? 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
