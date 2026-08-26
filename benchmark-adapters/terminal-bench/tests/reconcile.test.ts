/**
 * Cost reconciliation tests (spec 07 §4: ACP/ATIF/DSH session/cost reconciliation).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reconcileCost } from '../src/index.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-recon-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function makeTrial(name: string, files: Record<string, string>): Promise<string> {
  const dir = join(root!, name)
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, rel)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return dir
}

describe('cost reconciliation', () => {
  it('agrees when harbor + acp report the same usage', async () => {
    const dir = await makeTrial('agree', {
      'result.json': JSON.stringify({
        agent_result: { n_input_tokens: 100, n_output_tokens: 50, cost_usd: 0.01 },
      }),
      'acp-summary.json': JSON.stringify({
        usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.01 },
      }),
    })
    const rec = await reconcileCost(dir)
    expect(rec.nInputTokens).toBe(100)
    expect(rec.nOutputTokens).toBe(50)
    expect(rec.costUsd).toBeCloseTo(0.01, 5)
    expect(rec.sources).toEqual(expect.arrayContaining(['harbor', 'acp']))
  })

  it('flags a discrepancy when sources disagree on tokens', async () => {
    const dir = await makeTrial('disagree', {
      'result.json': JSON.stringify({ agent_result: { n_input_tokens: 100 } }),
      'acp-summary.json': JSON.stringify({ usage: { input_tokens: 200 } }),
    })
    const rec = await reconcileCost(dir)
    expect(rec.nInputTokens).toBeNull()
    expect(rec.consistent).toBe(false)
  })

  it('reports unpriced usage explicitly when tokens present but no cost', async () => {
    const dir = await makeTrial('unpriced', {
      'result.json': JSON.stringify({ agent_result: { n_input_tokens: 100, n_output_tokens: 50 } }),
    })
    const rec = await reconcileCost(dir)
    expect(rec.nInputTokens).toBe(100)
    expect(rec.costUsd).toBeNull()
    expect(rec.note).toMatch(/unpriced/)
  })

  it('handles a trial with no usage sources (missing)', async () => {
    const dir = await makeTrial('empty', { 'result.json': JSON.stringify({}) })
    const rec = await reconcileCost(dir)
    expect(rec.sources).toEqual([])
    expect(rec.note).toMatch(/no usage sources/)
  })

  it('re-parse yields the same record hash', async () => {
    const dir = await makeTrial('repro', {
      'result.json': JSON.stringify({ agent_result: { n_input_tokens: 100, cost_usd: 0.01 } }),
    })
    const rec1 = await reconcileCost(dir)
    const rec2 = await reconcileCost(dir)
    expect(rec1.recordHash).toBe(rec2.recordHash)
  })

  it('consumes the installed-agent layout the normalizer prefers', async () => {
    // ACP evidence under agent/ was previously invisible to reconciliation.
    const dir = await makeTrial('agent-layout', {
      'result.json': JSON.stringify({
        agent_result: { n_input_tokens: 100, n_output_tokens: 50, cost_usd: 0.01 },
      }),
      'agent/acp-summary.json': JSON.stringify({
        usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.01 },
      }),
    })
    const rec = await reconcileCost(dir)
    expect(rec.sources).toContain('acp')
    expect(rec.consistent).toBe(true)
    expect(rec.note).toMatch(/reconciled across/)
  })

  it('flags an agent/ vs root copy conflict for the same source', async () => {
    const dir = await makeTrial('layout-conflict', {
      'result.json': JSON.stringify({ agent_result: { n_input_tokens: 100 } }),
      'agent/acp-summary.json': JSON.stringify({ usage: { input_tokens: 100 } }),
      'acp-summary.json': JSON.stringify({ usage: { input_tokens: 999 } }),
    })
    const rec = await reconcileCost(dir)
    expect(rec.consistent).toBe(false)
    expect(rec.note).toMatch(/different bytes/)
  })

  it('marks cache-token disagreement inconsistent even when tokens agree', async () => {
    const dir = await makeTrial('cache-conflict', {
      'result.json': JSON.stringify({
        agent_result: { n_input_tokens: 100, n_output_tokens: 50, n_cache_tokens: 10 },
      }),
      'acp-summary.json': JSON.stringify({
        usage: { input_tokens: 100, output_tokens: 50, cache_tokens: 20 },
      }),
    })
    const rec = await reconcileCost(dir)
    expect(rec.nInputTokens).toBe(100)
    expect(rec.nOutputTokens).toBe(50)
    expect(rec.nCacheTokens).toBeNull()
    expect(rec.consistent).toBe(false)
  })

  it('marks USD cost disagreement inconsistent even when tokens agree', async () => {
    const dir = await makeTrial('usd-conflict', {
      'result.json': JSON.stringify({
        agent_result: { n_input_tokens: 100, n_output_tokens: 50, cost_usd: 0.01 },
      }),
      'acp-summary.json': JSON.stringify({
        usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.05 },
      }),
    })
    const rec = await reconcileCost(dir)
    expect(rec.costUsd).toBeNull()
    expect(rec.consistent).toBe(false)
  })

  it('surfaces a corrupt source instead of silently dropping it', async () => {
    const dir = await makeTrial('corrupt-acp', {
      'result.json': JSON.stringify({ agent_result: { n_input_tokens: 100, n_output_tokens: 50 } }),
      'acp-summary.json': '{not valid json',
    })
    const rec = await reconcileCost(dir)
    expect(rec.sources).not.toContain('acp')
    expect(rec.consistent).toBe(false)
    expect(rec.note).toMatch(/not valid JSON/)
  })

  it('surfaces malformed negative or non-finite usage values as corrupt', async () => {
    const dir = await makeTrial('negative-usage', {
      'result.json': JSON.stringify({
        agent_result: { n_input_tokens: -5, n_output_tokens: 50, cost_usd: 0.01 },
      }),
    })
    const rec = await reconcileCost(dir)
    expect(rec.consistent).toBe(false)
    expect(rec.note).toMatch(/finite non-negative/)
  })
})
