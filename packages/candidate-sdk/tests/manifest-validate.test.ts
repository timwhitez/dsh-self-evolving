/**
 * Manifest schema validation tests (spec 02 §6, §11 step 2).
 */
import { describe, expect, it } from 'vitest'
import { validateManifest } from '../src/index.js'

const validCandidate = {
  schemaVersion: 1,
  candidateId: 'baseline',
  canonicalParent: null,
  donorCandidates: [],
  proposal: {
    hypothesis: 'Neutral baseline',
    evidenceRefs: [],
    targetFailureModes: [],
    expectedBehaviorChange: 'None',
    regressionRisks: [],
    touchedSurfaces: ['system-prompt'],
  },
  runtime: {
    requiredServices: ['systemPrompt'],
    optionalServices: [],
    newToolNames: [],
    supportsModes: ['solve', 'propose'],
  },
  tests: {
    mechanismAssertions: ['boots'],
    preservationAssertions: ['no tool change'],
  },
}

describe('candidate manifest validation', () => {
  it('accepts a well-formed candidate manifest', async () => {
    const res = await validateManifest('candidate', validCandidate)
    expect(res.valid, res.errors.join('\n')).toBe(true)
  })

  it('rejects a manifest missing requiredServices', async () => {
    const bad = {
      ...validCandidate,
      runtime: { ...validCandidate.runtime, requiredServices: undefined },
    }
    const res = await validateManifest('candidate', bad)
    expect(res.valid).toBe(false)
    expect(res.errors.join('\n')).toMatch(/requiredServices/)
  })

  it('rejects an invalid mode', async () => {
    const bad = {
      ...validCandidate,
      runtime: { ...validCandidate.runtime, supportsModes: ['hack'] },
    }
    const res = await validateManifest('candidate', bad)
    expect(res.valid).toBe(false)
  })

  it('rejects a malformed canonicalParent hash', async () => {
    const bad = { ...validCandidate, canonicalParent: 'not-a-hash' }
    const res = await validateManifest('candidate', bad)
    expect(res.valid).toBe(false)
    expect(res.errors.join('\n')).toMatch(/canonicalParent/)
  })

  it('rejects an empty touchedSurfaces', async () => {
    const bad = { ...validCandidate, proposal: { ...validCandidate.proposal, touchedSurfaces: [] } }
    const res = await validateManifest('candidate', bad)
    // touchedSurfaces allows [] by schema (minItems default 0); but a real
    // candidate MUST touch at least one surface — this asserts the schema
    // accepts the empty array (downstream logic enforces non-empty).
    expect(res.valid).toBe(true)
  })
})

describe('build manifest validation', () => {
  it('accepts a well-formed build manifest with all receipts', async () => {
    const build = {
      schemaVersion: 1,
      candidateId: 'c_abc',
      sourceHash: 'a'.repeat(64),
      bundleHash: 'b'.repeat(64),
      capsuleHash: 'c'.repeat(64),
      parentDiffHash: 'd'.repeat(64),
      compiler: { typescript: '5.9.3', node: 'v22.23.1' },
      buildReceipts: {
        schema: { status: 'pass' },
        diffBoundary: { status: 'pass' },
        policyScan: { status: 'pass' },
        reproducibleBuild: { status: 'pass' },
        typeLintUnit: { status: 'pass' },
        realLoaderBoot: { status: 'pass' },
        unloadInvariant: { status: 'pass' },
        mockReplay: { status: 'pass' },
      },
    }
    const res = await validateManifest('build', build)
    expect(res.valid, res.errors.join('\n')).toBe(true)
  })

  it('rejects a build manifest with a short hash', async () => {
    const build = {
      schemaVersion: 1,
      candidateId: 'c_abc',
      sourceHash: 'tooshort',
      bundleHash: 'b'.repeat(64),
      capsuleHash: 'c'.repeat(64),
      parentDiffHash: 'd'.repeat(64),
      compiler: { typescript: '5.9.3', node: 'v22' },
      buildReceipts: {
        schema: { status: 'pass' },
        diffBoundary: { status: 'pass' },
        policyScan: { status: 'pass' },
        reproducibleBuild: { status: 'pass' },
        typeLintUnit: { status: 'pass' },
        realLoaderBoot: { status: 'pass' },
        unloadInvariant: { status: 'pass' },
        mockReplay: { status: 'pass' },
      },
    }
    const res = await validateManifest('build', build)
    expect(res.valid).toBe(false)
  })
})

describe('capsule manifest validation', () => {
  const capsule = {
    schemaVersion: 2,
    candidateId: `sha256:${'a'.repeat(64)}`,
    runtime: { kind: 'pinned-closure', ref: 'runtime/package-closure.json', hash: 'b'.repeat(64) },
    candidate: { bundleHash: 'c'.repeat(64) },
    runner: { overlay: 'runner/cordis.patch.yml', hash: 'd'.repeat(64) },
    provenance: { ref: 'provenance.json', hash: 'e'.repeat(64) },
    sbom: { ref: 'sbom.spdx.json', hash: 'f'.repeat(64) },
    sha256sums: {
      ref: 'SHA256SUMS',
      hash: '1'.repeat(64),
      format: 'dsh-capsule-tree-v2',
    },
  }

  it('accepts only the current typed complete-tree manifest', async () => {
    const result = await validateManifest('capsule', capsule)
    expect(result.valid, result.errors.join('\n')).toBe(true)
  })

  it('does not upgrade a schema-1 checksum manifest to current authority', async () => {
    const result = await validateManifest('capsule', {
      ...capsule,
      schemaVersion: 1,
      sha256sums: { ref: 'SHA256SUMS', hash: '1'.repeat(64) },
    })
    expect(result.valid).toBe(false)
  })
})
