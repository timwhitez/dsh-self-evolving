import { describe, expect, it } from 'vitest'
import { verifyV011ControllerIdentityBinding } from '../src/v011-audit.js'

const BASELINE = `sha256:${'1'.repeat(64)}`
const CHILD = `sha256:${'2'.repeat(64)}`

function built(candidateId: string) {
  return {
    candidateId,
    sourceDigest: candidateId,
    capsuleDigest: `sha256:${'3'.repeat(64)}`,
    buildManifestDigest: `sha256:${'4'.repeat(64)}`,
  }
}

function identityPayload(candidateId: string) {
  return {
    candidateId,
    sourceDigest: candidateId,
    capsuleDigest: `sha256:${'3'.repeat(64)}`,
    buildManifestDigest: `sha256:${'4'.repeat(64)}`,
  }
}

describe('V011 disk-to-controller identity audit (issue #198)', () => {
  it('accepts an exactly bound baseline root and generated child', () => {
    const candidates = {
      [BASELINE]: { candidateId: BASELINE, canonicalParent: null },
      [CHILD]: { candidateId: CHILD, canonicalParent: BASELINE },
    }
    const events = [
      { type: 'candidate.admitted', payload: identityPayload(BASELINE) },
      { type: 'candidate.admitted', payload: identityPayload(CHILD) },
      { type: 'build.completed', payload: identityPayload(CHILD) },
    ]
    expect(
      verifyV011ControllerIdentityBinding({
        label: 'baseline',
        built: built(BASELINE),
        expectedParent: null,
        requireBuildReceipt: false,
        candidates,
        events,
      }),
    ).toEqual([])
    expect(
      verifyV011ControllerIdentityBinding({
        label: 'generation 1',
        built: built(CHILD),
        expectedParent: BASELINE,
        requireBuildReceipt: true,
        candidates,
        events,
      }),
    ).toEqual([])
  })

  it('rejects a self-consistent disk chain that names a different controller candidate', () => {
    const diskOnly = `sha256:${'5'.repeat(64)}`
    const reasons = verifyV011ControllerIdentityBinding({
      label: 'baseline',
      built: built(diskOnly),
      expectedParent: null,
      requireBuildReceipt: false,
      candidates: { [BASELINE]: { candidateId: BASELINE, canonicalParent: null } },
      events: [{ type: 'candidate.admitted', payload: identityPayload(BASELINE) }],
    })
    expect(reasons.join('\n')).toMatch(/controller candidate|admission event/)
  })

  it('rejects a generated child whose journal build receipt changes one identity field', () => {
    const reasons = verifyV011ControllerIdentityBinding({
      label: 'generation 1',
      built: built(CHILD),
      expectedParent: BASELINE,
      requireBuildReceipt: true,
      candidates: {
        [BASELINE]: { candidateId: BASELINE, canonicalParent: null },
        [CHILD]: { candidateId: CHILD, canonicalParent: BASELINE },
      },
      events: [
        { type: 'candidate.admitted', payload: identityPayload(CHILD) },
        {
          type: 'build.completed',
          payload: { ...identityPayload(CHILD), capsuleDigest: `sha256:${'9'.repeat(64)}` },
        },
      ],
    })
    expect(reasons.join('\n')).toMatch(/build receipt/)
  })
})
