import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { assertV011, canonicalV011, digestV011 } from '@dsh-self-evolving/candidate-sdk'
import {
  readRefBytes,
  type ObjectRef,
  type ObjectStore,
  type V011MaterializationReceipt,
} from '@dsh-self-evolving/core'
import type { StableProposal } from './engine.js'

export interface V011MaterializationAuthority {
  stableProposal: StableProposal
  materialization: V011MaterializationReceipt
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function objectRef(digest: string, bytes: Uint8Array, mediaType: string): ObjectRef {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error('v0.1.1 materialization authority: malformed object digest')
  }
  return {
    algorithm: 'sha256',
    digest: digest.slice('sha256:'.length),
    size: bytes.byteLength,
    mediaType,
    label: 'DEV_OBSERVED',
  }
}

async function assertStoredBytes(
  store: ObjectStore,
  digest: string,
  expected: Uint8Array,
  mediaType: string,
): Promise<void> {
  const stored = await readRefBytes(store, objectRef(digest, expected, mediaType))
  if (!Buffer.from(stored).equals(Buffer.from(expected))) {
    throw new Error('v0.1.1 materialization authority: object-store bytes mismatch')
  }
}

export async function verifyV011MaterializationAuthority(input: {
  store: ObjectStore
  value: unknown
  actionRoot?: string
}): Promise<V011MaterializationAuthority> {
  if (
    !isRecord(input.value) ||
    !exactKeys(input.value, ['stableProposal', 'materialization']) ||
    !isRecord(input.value['stableProposal']) ||
    !isRecord(input.value['materialization'])
  ) {
    throw new Error('v0.1.1 materialization authority: invalid wrapper')
  }
  const stable = input.value['stableProposal']
  if (
    !exactKeys(stable, [
      'proposalId',
      'parentCandidateId',
      'hypothesis',
      'sourceDiff',
      'evidenceRefs',
      'artifactDigest',
    ]) ||
    !['proposalId', 'parentCandidateId', 'hypothesis', 'sourceDiff', 'artifactDigest'].every(
      (key) => typeof stable[key] === 'string' && stable[key].length > 0,
    ) ||
    !Array.isArray(stable['evidenceRefs']) ||
    stable['evidenceRefs'].some(
      (reference) =>
        typeof reference !== 'string' || !/^object:sha256:[0-9a-f]{64}$/.test(reference),
    )
  ) {
    throw new Error('v0.1.1 materialization authority: invalid stable proposal')
  }
  const materialization = input.value['materialization'] as unknown as V011MaterializationReceipt
  await assertV011('materialization-receipt', materialization)
  const canonical = canonicalV011(materialization)
  const artifactDigest = digestV011(canonical)
  if (
    stable['artifactDigest'] !== artifactDigest ||
    stable['proposalId'] !== materialization.proposalId ||
    stable['parentCandidateId'] !== materialization.parentDigest
  ) {
    throw new Error('v0.1.1 materialization authority: stable proposal binding mismatch')
  }
  let sourceDiff: unknown
  try {
    sourceDiff = JSON.parse(stable['sourceDiff'] as string)
  } catch (cause) {
    throw new Error('v0.1.1 materialization authority: invalid stable sourceDiff', { cause })
  }
  if (
    !isRecord(sourceDiff) ||
    !exactKeys(sourceDiff, ['slot', 'operations']) ||
    typeof sourceDiff['slot'] !== 'string' ||
    canonicalV011(sourceDiff['operations']) !== canonicalV011(materialization.operations) ||
    (input.actionRoot !== undefined &&
      resolve(sourceDiff['slot']) !==
        resolve(input.actionRoot, 'children', materialization.proposalId))
  ) {
    throw new Error('v0.1.1 materialization authority: sourceDiff binding mismatch')
  }

  const materializationBytes = Buffer.from(canonical)
  await assertStoredBytes(
    input.store,
    artifactDigest,
    materializationBytes,
    'application/vnd.dsh-self-evolving.materialization-receipt+json',
  )
  const installedAnalysis = await readFile(join(sourceDiff['slot'], 'analysis.json'))
  if (digestV011(installedAnalysis) !== materialization.analysisDigest) {
    throw new Error('v0.1.1 materialization authority: installed analysis digest mismatch')
  }
  const storedAnalysis = await readRefBytes(
    input.store,
    objectRef(
      materialization.analysisDigest,
      installedAnalysis,
      'application/vnd.dsh-self-evolving.analysis+json',
    ),
  )
  if (!Buffer.from(storedAnalysis).equals(installedAnalysis)) {
    throw new Error('v0.1.1 materialization authority: analysis CAS bytes mismatch')
  }
  const analysis = JSON.parse(installedAnalysis.toString('utf8')) as Record<string, unknown>
  await assertV011('analysis', analysis)
  if (analysis['falsifiableHypothesis'] !== stable['hypothesis']) {
    throw new Error('v0.1.1 materialization authority: hypothesis binding mismatch')
  }
  return {
    stableProposal: stable as unknown as StableProposal,
    materialization,
  }
}
