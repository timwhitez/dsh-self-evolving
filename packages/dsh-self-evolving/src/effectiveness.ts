import type { V011AdmissionReceipt, V011LoaderProbeReceipt } from '@dsh-self-evolving/candidate-sdk'

export const ENGINEERING_EFFECT_FIXTURE = 'dsh-self-evolving.fixed-replay-effect.v2' as const

export type EffectMode = 'solve' | 'propose'

export interface EffectModeContract {
  targetModes: EffectMode[]
  preservedModes: EffectMode[]
}

export interface EffectRoute {
  provider: 'deepseek-official'
  endpoint: 'https://api.deepseek.com/v1'
  model: 'deepseek-v4-flash'
  wireApi: 'responses'
  reasoningEffort: 'high'
  contextWindow: 1_048_576
  store: false
}

export interface EffectUsage {
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  reasoningTokens: number
}

export interface EffectAdmission {
  receipt: V011AdmissionReceipt
  loader: { solve: V011LoaderProbeReceipt; propose: V011LoaderProbeReceipt }
}

export interface EngineeringEffectReceipt {
  schemaVersion: 2
  fixture: typeof ENGINEERING_EFFECT_FIXTURE
  runId: string
  route: EffectRoute
  proposalGatewayReceipts: Array<{
    requestId: string
    requestHash: string
    responseHash: string
    routeHash: string
  }>
  usage: EffectUsage
  modeContract: EffectModeContract
  pricing: {
    currency: 'USD'
    unitTokens: 1_000_000
    cacheHitInputUsd: 0.0028
    cacheMissInputUsd: 0.14
    outputUsd: 0.28
  }
  estimatedCostUsd: number
  baseline: {
    candidateDigest: `sha256:${string}`
    admissionDigest: `sha256:${string}`
    solvePromptSections: number
    proposePromptSections: number
    solveComponents: number
    proposeComponents: number
  }
  child: {
    candidateDigest: `sha256:${string}`
    admissionDigest: `sha256:${string}`
    solvePromptSections: number
    proposePromptSections: number
    solveComponents: number
    proposeComponents: number
  }
  deltas: {
    solvePromptSections: number
    proposePromptSections: number
    solveComponents: number
    proposeComponents: number
    solveReplayChanged: boolean
    proposeReplayChanged: boolean
  }
  status: 'ENGINEERING_EFFECT_VERIFIED' | 'NO_MEASURABLE_ENGINEERING_EFFECT'
  claimBoundary: 'MEASURABLE_FIXED_REPLAY_RUNTIME_EFFECT_ONLY_NOT_BENCHMARK_IMPROVEMENT'
}

function admissionDigest(receipt: V011AdmissionReceipt): `sha256:${string}` {
  return receipt.stageReceipts.offlineCapsule
}

function measurement(admission: EffectAdmission) {
  return {
    candidateDigest: admission.receipt.candidateDigest,
    admissionDigest: admissionDigest(admission.receipt),
    solvePromptSections: admission.loader.solve.promptSections.length,
    proposePromptSections: admission.loader.propose.promptSections.length,
    solveComponents: admission.loader.solve.componentInventory.length,
    proposeComponents: admission.loader.propose.componentInventory.length,
  }
}

export function evaluateEngineeringEffect(input: {
  runId: string
  route: EffectRoute
  proposalGatewayReceipts: EngineeringEffectReceipt['proposalGatewayReceipts']
  usage: EffectUsage
  modeContract: EffectModeContract
  baseline: EffectAdmission
  child: EffectAdmission
}): EngineeringEffectReceipt {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.runId)) {
    throw new Error('effectiveness: invalid run id')
  }
  if (!input.baseline.receipt.admitted || !input.child.receipt.admitted) {
    throw new Error('effectiveness: baseline and child must both be admitted')
  }
  if (input.proposalGatewayReceipts.length === 0) {
    throw new Error('effectiveness: real proposal gateway receipt is required')
  }
  const targets = new Set(input.modeContract.targetModes)
  const preserved = new Set(input.modeContract.preservedModes)
  if (targets.size === 0 || [...targets].some((mode) => preserved.has(mode))) {
    throw new Error(
      'effectiveness: target modes must be non-empty and disjoint from preserved modes',
    )
  }
  const baseline = measurement(input.baseline)
  const child = measurement(input.child)
  const deltas = {
    solvePromptSections: child.solvePromptSections - baseline.solvePromptSections,
    proposePromptSections: child.proposePromptSections - baseline.proposePromptSections,
    solveComponents: child.solveComponents - baseline.solveComponents,
    proposeComponents: child.proposeComponents - baseline.proposeComponents,
    solveReplayChanged:
      input.child.loader.solve.replayDigest !== input.baseline.loader.solve.replayDigest,
    proposeReplayChanged:
      input.child.loader.propose.replayDigest !== input.baseline.loader.propose.replayDigest,
  }
  const verified =
    baseline.candidateDigest !== child.candidateDigest &&
    [...targets].every((mode) => deltas[`${mode}ReplayChanged`]) &&
    [...preserved].every((mode) => !deltas[`${mode}ReplayChanged`])
  const pricing = {
    currency: 'USD' as const,
    unitTokens: 1_000_000 as const,
    cacheHitInputUsd: 0.0028 as const,
    cacheMissInputUsd: 0.14 as const,
    outputUsd: 0.28 as const,
  }
  const estimatedCostUsd =
    (input.usage.inputTokens * pricing.cacheMissInputUsd +
      input.usage.cacheReadTokens * pricing.cacheHitInputUsd +
      input.usage.outputTokens * pricing.outputUsd) /
    pricing.unitTokens
  return {
    schemaVersion: 2,
    fixture: ENGINEERING_EFFECT_FIXTURE,
    runId: input.runId,
    route: input.route,
    proposalGatewayReceipts: input.proposalGatewayReceipts.map((row) => ({ ...row })),
    usage: { ...input.usage },
    modeContract: {
      targetModes: [...targets],
      preservedModes: [...preserved],
    },
    pricing,
    estimatedCostUsd,
    baseline,
    child,
    deltas,
    status: verified ? 'ENGINEERING_EFFECT_VERIFIED' : 'NO_MEASURABLE_ENGINEERING_EFFECT',
    claimBoundary: 'MEASURABLE_FIXED_REPLAY_RUNTIME_EFFECT_ONLY_NOT_BENCHMARK_IMPROVEMENT',
  }
}
