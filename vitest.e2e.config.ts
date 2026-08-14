import { defineConfig } from 'vitest/config'

// Real Cordis Loader E2E. Runs in a dedicated job with a longer timeout and a
// guaranteed-built DSH tree, separate from fast unit/property/schema tests.
// These tests are NOT mock: they boot the real Loader and resolve real built
// @deepseek-ai/* packages, so they catch default-export unwrap, inject drops
// and lifecycle leaks that hand-rolled ctx.plugin() cannot.
export default defineConfig({
  test: {
    root: __dirname,
    include: ['packages/**/tests/**/*.e2e.ts', 'benchmark-adapters/**/tests/**/*.e2e.ts'],
    exclude: ['**/node_modules/**', '**/deepseek-harness/**', '**/harbor/**', '**/tb/**'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
