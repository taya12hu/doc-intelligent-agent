import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/api/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    // Extraction tests use a fake provider; nothing here touches the network
    // or a database. If a test needs either, it belongs behind an explicit
    // `describe.skipIf(!process.env.X)` guard, not in the default run.
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      '@dia/shared': new URL('./packages/shared/src/index.ts', import.meta.url).pathname,
    },
  },
});
