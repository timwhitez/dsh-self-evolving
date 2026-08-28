import { canonicalV011, digestV011 } from '@dsh-self-evolving/candidate-sdk'
import { describe, expect, it } from 'vitest'
import {
  engineeringEffectRouteHash,
  evaluateEngineeringEffect,
  type EffectAdmission,
  type EffectRoute,
} from '../src/index.js'

const sha = (character: string) => `sha256:${character.repeat(64)}` as const

const effectRoute: EffectRoute = {
  provider: 'deepseek-official',
  endpoint: 'https://api.deepseek.com/v1',
  model: 'deepseek-v4-flash',
  wireApi: 'responses',
  reasoningEffort: 'high',
  contextWindow: 1_048_576,
  store: false,
}

function boundReceipt(runId = 'effect-v1'): {
  requestId: string
  runId: string
  requestHash: string
  responseHash: string
  routeHash: string
} {
  return {
    requestId: 'r1',
    runId,
    requestHash: sha('1'),
    responseHash: sha('2'),
    routeHash: engineeringEffectRouteHash(effectRoute),
  }
}

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
  const solve = loader('solve')
  const propose = loader('propose')
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
        // Stage digests are digests of the actual probe records (issue #87).
        loaderSolve: digestV011(canonicalV011(solve)),
        loaderPropose: digestV011(canonicalV011(propose)),
        fixedReplay: sha('a'),
        offlineCapsule: sha(character),
      },
      capsuleDigest: sha('b'),
      admitted: true,
    },
    loader: { solve, propose },
  }
}

function childWithPreservedPropose(): EffectAdmission {
  const base = admission('f', true)
  const preservedProbe = {
    ...admission('e', false).loader.propose,
    candidateId: sha('f'),
  }
  return {
    ...base,
    receipt: {
      ...base.receipt,
      stageReceipts: {
        ...base.receipt.stageReceipts,
        loaderPropose: digestV011(canonicalV011(preservedProbe)),
      },
    },
    loader: { solve: base.loader.solve, propose: preservedProbe },
  }
}

describe('low-consumption engineering effectiveness gate', () => {
  it('requires a target-mode change while preserving the preregistered control mode', () => {
    const receipt = evaluateEngineeringEffect({
      runId: 'effect-v1',
      route: effectRoute,
      proposalGatewayReceipts: [boundReceipt()],
      usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 5, reasoningTokens: 2 },
      modeContract: { targetModes: ['solve'], preservedModes: ['propose'] },
      baseline: admission('e', false),
      child: childWithPreservedPropose(),
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
      route: effectRoute,
      proposalGatewayReceipts: [boundReceipt('effect-v1-no-change')],
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
      route: effectRoute,
      proposalGatewayReceipts: [boundReceipt('effect-v2-preservation-drift')],
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
    route: effectRoute,
    proposalGatewayReceipts: [boundReceipt('effect-v2')],
    usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 5, reasoningTokens: 2 },
    modeContract: { targetModes: ['solve'], preservedModes: ['propose'] },
    baseline: admission('e', false),
    child: childWithPreservedPropose(),
  })

  it('binds admissionDigest to the complete receipt, not the capsule sums alone', () => {
    const original = evaluateEngineeringEffect(baseInput())
    // Mutate a NON-probe stage so the probe bindings stay valid: the policy
    // digest is not cross-checked, but it feeds admissionDigest.
    const mutated = childWithPreservedPropose()
    mutated.receipt.stageReceipts.policy = sha('z')
    const input = baseInput()
    input.child = mutated
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
      {
        requestId: 'r1',
        runId: 'effect-v2',
        requestHash: 'garbage',
        responseHash: sha('2'),
        routeHash: engineeringEffectRouteHash(effectRoute),
      },
    ]
    expect(() => evaluateEngineeringEffect(input)).toThrow(/not bound to this run and locked route/)
  })

  it('rejects a foreign-run receipt set even with well-formed hashes (issue #214)', () => {
    const input = baseInput()
    input.proposalGatewayReceipts = [boundReceipt('some-other-run')]
    expect(() => evaluateEngineeringEffect(input)).toThrow(/not bound to this run and locked route/)
  })

  it('rejects a receipt set collected against a different locked route (issue #214)', () => {
    const input = baseInput()
    const otherRoute = { ...effectRoute, model: 'deepseek-v4-lite' } as const
    input.proposalGatewayReceipts = [
      {
        requestId: 'r1',
        runId: 'effect-v2',
        requestHash: sha('1'),
        responseHash: sha('2'),
        routeHash: engineeringEffectRouteHash(otherRoute),
      },
    ]
    expect(() => evaluateEngineeringEffect(input)).toThrow(/not bound to this run and locked route/)
  })

  it('rejects rows without a request id or with an empty one (issue #214)', () => {
    const input = baseInput()
    input.proposalGatewayReceipts = [{ ...boundReceipt('effect-v2'), requestId: '' }]
    expect(() => evaluateEngineeringEffect(input)).toThrow(/not bound to this run and locked route/)
  })
})
