/**
 * Golden candidate build test (spec 07 §3 Accept).
 *
 * Runs the deterministic builder on the real @dsh-self-evolving/candidate-baseline source
 * and asserts:
 *  - two clean builds produce an identical bundle hash (reproducible);
 *  - the source/bundle/capsule hashes are stable across runs (3-hash determinism);
 *  - the policy scan passes (baseline is clean);
 *  - the candidate.json validates against the schema.
 *
 * This is the Gate 1 "golden candidate 双次 clean build 三 hash 相同" evidence.
 * The "three hashes equal" is: source hash stable, bundle hash stable, capsule
 * hash stable — verified by running the builder twice and comparing.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildCandidate } from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const baselineRoot = resolve(here, '..', '..', 'candidate-baseline')
// Use the repo's pinned tsc.
const tscBin = resolve(here, '..', '..', '..', 'node_modules', '.bin', 'tsc')

const baselineSourceFiles = [
  'src/index.ts',
  'package.json',
  'candidate.json',
  'cordis.patch.yml',
  'tsconfig.json',
]

let scratch: string | undefined

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-build-'))
})

afterEach(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
  scratch = undefined
})

const BUILD_TIMEOUT = { timeout: 120_000 }

describe('golden candidate build (Gate 1)', () => {
  it(
    'two clean builds of candidate-baseline yield identical source/bundle/capsule hashes',
    BUILD_TIMEOUT,
    async () => {
      const receipt1 = await buildCandidate({
        sourceRoot: baselineRoot,
        sourceFiles: baselineSourceFiles,
        tscBin,
      })
      const receipt2 = await buildCandidate({
        sourceRoot: baselineRoot,
        sourceFiles: baselineSourceFiles,
        tscBin,
      })
      // The three hashes must be identical across two independent clean builds.
      expect(receipt1.sourceHash).toBe(receipt2.sourceHash)
      expect(receipt1.bundleHash).toBe(receipt2.bundleHash)
      expect(receipt1.capsuleHash).toBe(receipt2.capsuleHash)
      // Within a single receipt, double-build identity is asserted by the builder.
      expect(receipt1.doubleBuildIdentical).toBe(true)
      // Candidate id is well-formed.
      expect(receipt1.candidateId).toMatch(/^c_[a-z2-7]{26}$/)
    },
  )

  it(
    'candidate-baseline passes schema validation and policy scan during build',
    BUILD_TIMEOUT,
    async () => {
      const receipt = await buildCandidate({
        sourceRoot: baselineRoot,
        sourceFiles: baselineSourceFiles,
        tscBin,
      })
      expect(receipt.schemaValidation.valid).toBe(true)
      expect(receipt.scan.passed).toBe(true)
      expect(receipt.scan.hits.filter((h) => h.severity === 'reject')).toEqual([])
    },
  )

  it(
    'serializes concurrent clean builds of the same source root across callers',
    BUILD_TIMEOUT,
    async () => {
      const receipts = await Promise.all(
        Array.from({ length: 4 }, () =>
          buildCandidate({
            sourceRoot: baselineRoot,
            sourceFiles: baselineSourceFiles,
            tscBin,
          }),
        ),
      )
      expect(new Set(receipts.map((receipt) => receipt.bundleHash))).toHaveLength(1)
      expect(receipts.every((receipt) => receipt.doubleBuildIdentical)).toBe(true)
    },
  )
})
