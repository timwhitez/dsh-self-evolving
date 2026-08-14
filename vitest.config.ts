import { defineConfig } from 'vitest/config'

// Fast CI: unit, property, schema, provenance, upstream-clean and byte-equality tests.
// Real Cordis Loader E2E lives in vitest.e2e.config.ts so it can run in a separate
// job with a longer timeout and a guaranteed-built DSH tree.
export default defineConfig({
  test: {
    // Several candidate-sdk builder tests mutate the shared candidate-baseline/
    // lib directory (rm -rf + tsc -b). Run files sequentially to avoid the
    // parallel-write race on that shared build output. The whole suite is fast
    // (<10s), so file-parallelism gives no meaningful speedup here.
    fileParallelism: false,
    include: [
      'packages/**/tests/**/*.test.ts',
      'benchmark-adapters/**/tests/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
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
