import { describe, expect, it } from 'vitest'
import { validateProposalBatch } from '../src/index.js'

const parentDigest = `sha256:${'a'.repeat(64)}`

function child(sourceDiff: string) {
  return {
    proposalId: 'diff-classification',
    canonicalParentDigest: parentDigest,
    donorCandidates: [],
    hypothesis: 'Change production behavior and add focused regression coverage',
    evidenceRefs: ['evidence://dev/trace'],
    mechanismTests: ['new behavior is exercised'],
    preservationTests: ['existing behavior remains stable'],
    sourceDiff,
  }
}

function validate(sourceDiff: string) {
  return validateProposalBatch({ parentDigest, children: [child(sourceDiff)] })
}

describe('proposal diff file classification', () => {
  it('accepts a mixed production-and-test unified diff', () => {
    const diff = [
      'diff --git a/src/index.ts b/src/index.ts',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -1 +1,2 @@',
      '+export const changed = true',
      'diff --git a/tests/index.spec.ts b/tests/index.spec.ts',
      '--- /dev/null',
      '+++ b/tests/index.spec.ts',
      '@@ -0,0 +1 @@',
      '+expect(changed).toBe(true)',
    ].join('\n')

    expect(validate(diff).accepted).toHaveLength(1)
  })

  it('rejects root-level quoted test files containing spaces', () => {
    const diff = [
      'diff --git "a/root case.test.ts" "b/root case.test.ts"',
      '--- "a/root case.test.ts"',
      '+++ "b/root case.test.ts"',
      '@@ -1 +1,2 @@',
      '+expect(true).toBe(true)',
    ].join('\n')

    const result = validate(diff)
    expect(result.accepted).toEqual([])
    expect(result.rejected[0]?.reason).toMatch(/test-only/)
  })

  it('decodes quoted tabs and quoted tests-directory paths', () => {
    const diff = [
      'diff --git "a/tests/with\\tseparator.ts" "b/tests/with\\tseparator.ts"',
      '--- "a/tests/with\\tseparator.ts"',
      '+++ "b/tests/with\\tseparator.ts"',
      '@@ -1 +1,2 @@',
      '+expect(true).toBe(true)',
    ].join('\n')

    expect(validate(diff).rejected[0]?.reason).toMatch(/test-only/)
  })

  it('decodes Git octal UTF-8 escapes before classifying the path', () => {
    const escaped = '\\346\\265\\213\\350\\257\\225/root.spec.ts'
    const diff = [
      `diff --git "a/${escaped}" "b/${escaped}"`,
      `--- "a/${escaped}"`,
      `+++ "b/${escaped}"`,
      '@@ -1 +1,2 @@',
      '+expect(true).toBe(true)',
    ].join('\n')

    expect(validate(diff).rejected[0]?.reason).toMatch(/test-only/)
  })

  it('classifies a deleted test file from its non-dev-null side', () => {
    const diff = [
      'diff --git a/root.spec.ts b/root.spec.ts',
      'deleted file mode 100644',
      '--- a/root.spec.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-expect(true).toBe(true)',
    ].join('\n')

    expect(validate(diff).rejected[0]?.reason).toMatch(/test-only/)
  })

  it('accepts a metadata-only rename from a test path to production', () => {
    const diff = [
      'diff --git a/tests/old.ts b/src/new.ts',
      'similarity index 100%',
      'rename from tests/old.ts',
      'rename to src/new.ts',
    ].join('\n')

    expect(validate(diff).accepted).toHaveLength(1)
  })

  it('fails closed when a quoted file header cannot be parsed', () => {
    const diff = [
      'diff --git "a/tests/broken.test.ts" "b/tests/broken.test.ts"',
      '--- "a/tests/broken.test.ts',
      '+++ "b/tests/broken.test.ts"',
      '@@ -1 +1,2 @@',
      '+expect(true).toBe(true)',
    ].join('\n')

    const result = validate(diff)
    expect(result.accepted).toEqual([])
    expect(result.rejected[0]?.reason).toMatch(/malformed unified diff file header/)
  })

  it('accepts a production mode-only change from diff --git metadata', () => {
    const diff = [
      'diff --git a/src/index.ts b/src/index.ts',
      'old mode 100644',
      'new mode 100755',
    ].join('\n')

    expect(validate(diff).accepted).toHaveLength(1)
  })

  it('rejects a test-only mode change from diff --git metadata', () => {
    const diff = [
      'diff --git a/root.spec.ts b/root.spec.ts',
      'old mode 100644',
      'new mode 100755',
    ].join('\n')

    expect(validate(diff).rejected[0]?.reason).toMatch(/test-only/)
  })

  it('classifies binary changes without --- and +++ headers', () => {
    const productionDiff = [
      'diff --git a/src/model.bin b/src/model.bin',
      'index 1111111..2222222 100644',
      'Binary files a/src/model.bin and b/src/model.bin differ',
    ].join('\n')
    const testDiff = [
      'diff --git a/tests/model.bin b/tests/model.bin',
      'index 1111111..2222222 100644',
      'Binary files a/tests/model.bin and b/tests/model.bin differ',
    ].join('\n')

    expect(validate(productionDiff).accepted).toHaveLength(1)
    expect(validate(testDiff).rejected[0]?.reason).toMatch(/test-only/)
  })

  it('fails closed when file headers disagree with diff --git identity', () => {
    const diff = [
      'diff --git a/src/index.ts b/src/index.ts',
      '--- a/tests/index.test.ts',
      '+++ b/tests/index.test.ts',
      '@@ -1 +1,2 @@',
      '+expect(true).toBe(true)',
    ].join('\n')

    const result = validate(diff)
    expect(result.accepted).toEqual([])
    expect(result.rejected[0]?.reason).toMatch(/does not match diff --git path/)
  })

  it('fails closed on incomplete standalone file-header pairs', () => {
    const result = validate(['--- a/src/index.ts', '+export const changed = true'].join('\n'))

    expect(result.accepted).toEqual([])
    expect(result.rejected[0]?.reason).toMatch(/incomplete standalone/)
  })

  it('does not interpret hunk content beginning with header bytes as metadata', () => {
    const diff = [
      'diff --git a/src/index.ts b/src/index.ts',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -1 +1,2 @@',
      '--- this is removed source content, not a file header',
      '+export const changed = true',
    ].join('\n')

    expect(validate(diff).accepted).toHaveLength(1)
  })

  it('accepts a production-only unified diff', () => {
    const diff = [
      'diff --git a/src/index.ts b/src/index.ts',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -1 +1,2 @@',
      '+export const changed = true',
    ].join('\n')

    expect(validate(diff).accepted).toHaveLength(1)
  })
})
