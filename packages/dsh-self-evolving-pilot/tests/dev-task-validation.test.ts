import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '@dsh-self-evolving/search'
import {
  runPilotLoop,
  validateDevTaskIds,
  type PilotCapabilities,
  type PilotConfig,
} from '../src/index.js'

function config(devTaskIds: string[]): PilotConfig {
  return {
    K: 2,
    B_eval: 1,
    params: DEFAULT_PARAMS,
    devTaskIds,
    masterSeed: 42n,
  }
}

function countingCapabilities(counter: { calls: number }): PilotCapabilities {
  return {
    async propose() {
      counter.calls += 1
      return []
    },
    async build() {
      counter.calls += 1
      return null
    },
    async evaluate() {
      counter.calls += 1
      return { reward: 1, costUsd: 0.01, wallSec: 1 }
    },
  }
}

async function expectRejectedBeforeExternalWork(devTaskIds: string[], pattern: RegExp) {
  const counter = { calls: 0 }
  await expect(
    runPilotLoop(
      'baseline',
      'baseline source',
      'sha256:baseline',
      config(devTaskIds),
      countingCapabilities(counter),
    ),
  ).rejects.toThrow(pattern)
  expect(counter.calls).toBe(0)
}

describe('pilot development task inventory validation', () => {
  it('rejects an empty inventory before evaluator dispatch', async () => {
    await expectRejectedBeforeExternalWork([], /non-empty array/)
  })

  it('rejects blank, padded, and NUL-containing task ids', async () => {
    await expectRejectedBeforeExternalWork([''], /not a valid non-empty task id/)
    await expectRejectedBeforeExternalWork([' task-a'], /not a valid non-empty task id/)
    await expectRejectedBeforeExternalWork(['task\0a'], /not a valid non-empty task id/)
  })

  it('rejects duplicate task ids before external work', async () => {
    await expectRejectedBeforeExternalWork(['task-a', 'task-a'], /duplicate development task id/)
  })

  it('accepts a non-empty unique inventory', () => {
    expect(() => validateDevTaskIds(['task-a', 'task-b'])).not.toThrow()
  })
})
