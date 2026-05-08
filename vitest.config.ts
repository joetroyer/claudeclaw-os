import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'web/src/**/*.test.ts'],
    // Runs before any test module loads. Lets contract tests set env vars
    // that config.ts reads at import time without leaking real config.
    setupFiles: ['src/test-env-setup.ts'],
  },
});
