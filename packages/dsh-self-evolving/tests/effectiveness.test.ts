import { describe, expect, it } from 'vitest'
import { evaluateEngineeringEffect, type EffectAdmission } from '../src/index.js'

const sha = (character: string) => `sha256:${character.repeat(64)}` as const

function admission(character: string, extra: boolean): EffectAdmission {
  const promptSections = extra
    ? ['candidate:baseline', 'candidate:bounded']
    : ['candidate:baseline']
  const componentInventory = extra ? ['candidate', 'candidate/nested'] : ['candidate']
  const loader = (mode: 'solve' | 'propose') => ({
    schemaVersion: 1 as const,
    mode,
    candidateId: sha(character),
    entries: ['candidate'],
    componentInventory,
    promptSections,
    replayDigest: sha(extra ? (mode === 'solve' ? 'c' : 'd') : mode === 'solve' ? 'a' : 'b'),
    leakedHandles: [],
  })
  return {
    receipt: {
      schemaVersion: 1,
      protocol: 'dsh-self-evolving-candidate-tree-v2',
      candidateDigest: sha(character),
      materializationDigest: sha('1'),
      capabilityCatalogDigest: sha('2'),
      stageReceipts: {
        containment: sha('3'),
        schema: sha('4'),
        policy: sha('5'),
        candidateTests: sha('6'),
        doubleBuild: sha('7'),
        loaderSolve: sha('8'),
        loaderPropose: sha('9'),
        fixedReplay: sha('a'),
        offlineCapsule: sha(character),
      },
      capsuleDigest: sha('b'),
      admitted: true,
    },
    loader: { solve: loader('solve'), propose: loader('propose') },
  }
}

describe('low-consumption engineering effectiveness gate', () => {
  it('requires a target-mode change while preserving the preregistered control mode', () => {
    const receipt = evaluateEngineeringEffect({
      runId: 'effect-v1',
      route: {
        provider: 'deepseek-official',
        endpoint: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-flash',
        wireApi: 'responses',
        reasoningEffort: 'high',
        contextWindow: 1_048_576,
        store: false,
      },
      proposalGatewayReceipts: [
        { requestId: 'r1', requestHash: sha('1'), responseHash: sha('2'), routeHash: sha('3') },
      ],
      usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 5, reasoningTokens: 2 },
      modeContract: { targetModes: ['solve'], preservedModes: ['propose'] },
      baseline: admission('e', false),
      child: {
        ...admission('f', true),
        loader: {
          solve: admission('f', true).loader.solve,
          // Preserved-mode probe replays the baseline digest but must still
          // carry the CHILD's admission identity.
          propose: { ...admission('e', false).loader.propose, candidateId: sha('f') },
        },
      },
    })
    expect(receipt.status).toBe('ENGINEERING_EFFECT_VERIFIED')
    expect(receipt.deltas).toMatchObject({
      solvePromptSections: 1,
      proposePromptSections: 0,
      solveComponents: 1,
      proposeComponents: 0,
      solveReplayChanged: true,
      proposeReplayChanged: false,
    })
  })

  it('does not call an admitted but behavior-identical child effective', () => {
    const receipt = evaluateEngineeringEffect({
      runId: 'effect-v1-no-change',
      route: {
        provider: 'deepseek-official',
        endpoint: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-flash',
        wireApi: 'responses',
        reasoningEffort: 'high',
        contextWindow: 1_048_576,
        store: false,
      },
      proposalGatewayReceipts: [
        { requestId: 'r1', requestHash: sha('1'), responseHash: sha('2'), routeHash: sha('3') },
      ],
      usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 5, reasoningTokens: 2 },
      modeContract: { targetModes: ['solve'], preservedModes: ['propose'] },
      baseline: admission('e', false),
      child: admission('f', false),
    })
    expect(receipt.status).toBe('NO_MEASURABLE_ENGINEERING_EFFECT')
  })

  it('rejects target improvement that also drifts the preserved mode', () => {
    const receipt = evaluateEngineeringEffect({
      runId: 'effect-v2-preservation-drift',
      route: {
        provider: 'deepseek-official',
        endpoint: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-flash',
        wireApi: 'responses',
        reasoningEffort: 'high',
        contextWindow: 1_048_576,
        store: false,
      },
      proposalGatewayReceipts: [
        { requestId: 'r1', requestHash: sha('1'), responseHash: sha('2'), routeHash: sha('3') },
      ],
      usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 5, reasoningTokens: 2 },
      modeContract: { targetModes: ['solve'], preservedModes: ['propose'] },
      baseline: admission('e', false),
      child: admission('f', true),
    })
    expect(receipt.status).toBe('NO_MEASURABLE_ENGINEERING_EFFECT')
  })
})

describe('engineering-effect evidence binding (issue #87)', () => {
  const baseInput = () => ({
    runId: 'effect-v2',
    route: {
      provider: 'deepseek-official',
      endpoint: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
      wireApi: 'responses',
      reasoningEffort: 'high',
      contextWindow: 1_048_576,
      store: false,
    },
    proposalGatewayReceipts: [
      { requestId: 'r1', requestHash: sha('1'), responseHash: sha('2'), routeHash: sha('3') },
    ],
    usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 5, reasoningTokens: 2 },
    modeContract: { targetModes: ['solve'], preservedModes: ['propose'] },
    baseline: admission('e', false),
    child: {
      ...admission('f', true),
      loader: {
        solve: admission('f', true).loader.solve,
        propose: { ...admission('e', false).loader.propose, candidateId: sha('f') },
      },
    },
  })

  it('binds admissionDigest to the complete receipt, not the capsule sums alone', () => {
    const original = evaluateEngineeringEffect(baseInput())
    const mutated = admission('f', true)
    mutated.receipt.stageReceipts.policy = sha('z')
    const input = baseInput()
    input.child = { ...input.child, receipt: mutated.receipt }
    const mutatedReceipt = evaluateEngineeringEffect(input)
    // The policy-stage change must alter the recorded admission digest even
    // though the capsule sums are identical.
    expect(mutatedReceipt.child.admissionDigest).not.toBe(original.child.admissionDigest)
  })

  it('rejects a Loader probe bound to a foreign admission', () => {
    const input = baseInput()
    input.child = {
      ...input.child,
      loader: {
        ...input.child.loader,
        solve: { ...input.child.loader.solve, candidateId: sha('impostor') },
      },
    }
    expect(() => evaluateEngineeringEffect(input)).toThrow(/not bound to its admission/)
  })

  it('rejects malformed gateway receipt hashes', () => {
    const input = baseInput()
    input.proposalGatewayReceipts = [
      { requestId: 'r1', requestHash: 'garbage', responseHash: sha('2'), routeHash: sha('3') },
    ]
    expect(() => evaluateEngineeringEffect(input)).toThrow(/well-formed sha256/)
  })
})
