// Flat eslint config. Kept minimal for Gate 0; tightened per-phase as the TCB grows.
// Upstream trees are excluded — they are read-only pinned checkouts (AGENTS.md rule 1).
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'deepseek-harness/**',
      'harbor/**',
      'tb/**',
      '**/node_modules/**',
      '**/lib/**',
      '**/.tsbuildinfo',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // RSI code must not paper over Loader/type defects with `any`.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'warn',
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Allow intentional discards via a leading underscore.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
)
