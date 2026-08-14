import { defineConfig } from 'vitest/config'

// Fast CI: unit, property, schema, provenance, upstream-clean and byte-equality tests.
// Real Cordis Loader E2E lives in vitest.e2e.config.ts so it can run in a separate
// job with a longer timeout and a guaranteed-built DSH tree.
export default defineConfig({
  test: {
    include: ['packages/**/tests/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/tests/**/*.e2e.ts',
      '**/deepseek-harness/**',
      '**/harbor/**',
      '**/tb/**',
    ],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    testTimeout: 30_000,
  },
})
