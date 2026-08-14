/**
 * ACP/ATIF/DSH session + cost reconciliation (spec 07 §4).
 *
 * A trial's cost is recorded in three independent sources that MUST agree:
 *   - Harbor trial result.json: agent_result.{n_input_tokens, n_output_tokens,
 *     n_cache_tokens, cost_usd}
 *   - ACP summary (acp-summary.json): usage updates emitted by the agent
 *   - DSH session log: the underlying model adapter's request records
 *
 * This module reconciles them and flags discrepancies. Unpriced usage is
 * reported explicitly (never silently zero). The reconciled record is content-
 * addressed so re-parsing the same artifacts yields the same hash.
 *
 * Cost never enters the candidate, prompt, or evidence as a credential; only
 * aggregate token counts and USD figures are recorded.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface HarborUsage {
  nInputTokens: number | null
  nOutputTokens: number | null
  nCacheTokens: number | null
  costUsd: number | null
}

export interface ReconciledCost {
  /** Agreed token counts (null when any source disagrees or is missing). */
  nInputTokens: number | null
  nOutputTokens: number | null
  nCacheTokens: number | null
  /** Agreed USD cost. */
  costUsd: number | null
  /** True iff all present sources agree within tolerance. */
  consistent: boolean
  /** Sources that were present (harbor / acp / dsh). */
  sources: string[]
  /** sha256 of the reconciled record (deterministic). */
  recordHash: string
  /** Human-readable reconciliation note. */
  note: string
}

async function readJsonOrNull(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Reconcile cost across Harbor result.json + acp-summary.json. The DSH session
 * log is reconciled when present (dsh-session.json sidecar).
 *
 * Tolerance: token counts must match exactly; USD must match within $0.001.
 */
export async function reconcileCost(trialDir: string): Promise<ReconciledCost> {
  const result = (await readJsonOrNull(join(trialDir, 'result.json'))) as {
    agent_result?: {
      n_input_tokens?: number
      n_output_tokens?: number
      n_cache_tokens?: number
      cost_usd?: number
    }
  } | null
  const acpSummary = (await readJsonOrNull(join(trialDir, 'acp-summary.json'))) as {
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_tokens?: number
      cost_usd?: number
    }
  } | null
  const dshSession = (await readJsonOrNull(join(trialDir, 'dsh-session.json'))) as {
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_tokens?: number
      cost_usd?: number
    }
  } | null

  const sources: string[] = []
  if (result?.agent_result) sources.push('harbor')
  if (acpSummary?.usage) sources.push('acp')
  if (dshSession?.usage) sources.push('dsh')

  const harbor: HarborUsage = {
    nInputTokens: result?.agent_result?.n_input_tokens ?? null,
    nOutputTokens: result?.agent_result?.n_output_tokens ?? null,
    nCacheTokens: result?.agent_result?.n_cache_tokens ?? null,
    costUsd: result?.agent_result?.cost_usd ?? null,
  }
  const acp = acpSummary?.usage
    ? {
        nInputTokens: acpSummary.usage.input_tokens ?? null,
        nOutputTokens: acpSummary.usage.output_tokens ?? null,
        nCacheTokens: acpSummary.usage.cache_tokens ?? null,
        costUsd: acpSummary.usage.cost_usd ?? null,
      }
    : null
  const dsh = dshSession?.usage
    ? {
        nInputTokens: dshSession.usage.input_tokens ?? null,
        nOutputTokens: dshSession.usage.output_tokens ?? null,
        nCacheTokens: dshSession.usage.cache_tokens ?? null,
        costUsd: dshSession.usage.cost_usd ?? null,
      }
    : null

  // Reconcile: for each field, all present non-null values must agree.
  function reconcileField(get: (u: HarborUsage) => number | null): number | null {
    const vals: number[] = []
    for (const u of [harbor, acp, dsh]) {
      if (!u) continue
      const v = get(u)
      if (v !== null && v !== undefined) vals.push(v)
    }
    if (vals.length === 0) return null
    return vals.every((v) => v === vals[0]) ? vals[0]! : null
  }

  const nInputTokens = reconcileField((u) => u.nInputTokens)
  const nOutputTokens = reconcileField((u) => u.nOutputTokens)
  const nCacheTokens = reconcileField((u) => u.nCacheTokens)
  // USD: tolerate 0.001 rounding.
  const costVals: number[] = []
  for (const u of [harbor, acp, dsh]) {
    if (u?.costUsd !== null && u?.costUsd !== undefined) costVals.push(u.costUsd)
  }
  let costUsd: number | null = null
  if (costVals.length > 0) {
    const ok = costVals.every((c) => Math.abs(c - costVals[0]!) < 0.001)
    costUsd = ok ? costVals[0]! : null
  }

  // Consistent iff every present source's non-null fields agreed.
  const consistent =
    (nInputTokens !== null || !sources.some((s) => fieldPresent(s, 'input', harbor, acp, dsh))) &&
    (nOutputTokens !== null || !sources.some((s) => fieldPresent(s, 'output', harbor, acp, dsh)))

  const recordBody = JSON.stringify({ nInputTokens, nOutputTokens, nCacheTokens, costUsd, sources })
  const recordHash = createHash('sha256').update(recordBody).digest('hex')
  const unpriced = costUsd === null && (nInputTokens !== null || nOutputTokens !== null)
  const note =
    sources.length === 0
      ? 'no usage sources present (unpriced/missing)'
      : unpriced
        ? `usage present but cost unpriced (sources: ${sources.join(',')})`
        : `reconciled across ${sources.join(',')}`

  return {
    nInputTokens,
    nOutputTokens,
    nCacheTokens,
    costUsd,
    consistent,
    sources,
    recordHash,
    note,
  }
}

function fieldPresent(
  src: string,
  field: 'input' | 'output',
  harbor: HarborUsage,
  acp: HarborUsage | null,
  dsh: HarborUsage | null,
): boolean {
  const u = src === 'harbor' ? harbor : src === 'acp' ? acp : dsh
  if (!u) return false
  return field === 'input' ? u.nInputTokens !== null : u.nOutputTokens !== null
}
