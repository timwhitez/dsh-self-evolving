import { describe, expect, it } from 'vitest'
import { buildV011ProposalPrompt } from '../src/v011-runner.js'

describe('v0.1.1 proposal prompt contract', () => {
  it('requires NodeNext-safe namespace imports for nested components', () => {
    const prompt = buildV011ProposalPrompt({
      proposalId: 'p_11111111111111111111111111111111',
      parentDigest: `sha256:${'1'.repeat(64)}`,
      exportManifestDigest: `sha256:${'2'.repeat(64)}`,
      exportMerkleRoot: `sha256:${'3'.repeat(64)}`,
      capabilityCatalogDigest: `sha256:${'4'.repeat(64)}`,
      ancestorClusters: ['transient-tool-stop'],
      modeContract: { targetModes: ['solve'], preservedModes: ['propose'] },
      requiredParentEvidence: {
        schemaVersion: 1,
        parentCandidateDigest: `sha256:${'5'.repeat(64)}`,
        parentEvaluationActionId: 'eval:candidate:1',
        parentExternalJobId: 'stable-parent-job',
        analysisDigest: `sha256:${'6'.repeat(64)}`,
        mechanismOutcomeDigest: `sha256:${'7'.repeat(64)}`,
        normalizedTrialDigest: `sha256:${'8'.repeat(64)}`,
        trajectoryDigest: `sha256:${'9'.repeat(64)}`,
      },
      roots: {
        parent: '/input/parent',
        archive: '/input/archive',
        evidence: '/input/evidence',
        contracts: '/input/contracts',
        childTree: '/work/child/tree',
        slot: '/work/child',
      },
    })
    expect(prompt).toContain('import * as componentName')
    expect(prompt).toContain('relative `.js` specifier')
    expect(prompt).toContain('NodeNext extension')
    expect(prompt).toContain('Do not call ctx.onDispose')
    expect(prompt).toContain('do not read source files in tests')
    expect(prompt).toContain('must not import node:* built-ins')
    expect(prompt).toContain('admission policy scan')
    expect(prompt).toContain(`sha256:${'6'.repeat(64)}`)
    expect(prompt).toContain(`sha256:${'7'.repeat(64)}`)
    expect(prompt).toContain(`sha256:${'8'.repeat(64)}`)
    expect(prompt).toContain(`sha256:${'9'.repeat(64)}`)
    expect(prompt).toContain('selected failure cluster')
    expect(prompt).toContain('Runtime modes that MUST change: ["solve"]')
    expect(prompt).toContain(
      'Runtime modes that MUST remain behaviorally identical to the parent: ["propose"]',
    )
    expect(prompt).toContain('Gate every new runtime effect by config.mode')
  })
})
