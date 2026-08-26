/**
 * ACP/ATIF/DSH session + cost reconciliation (spec 07 §4).
 *
 * A trial's cost is recorded in three independent sources that MUST agree:
 *   - Harbor trial result.json: agent_result.{n_input_tokens, n_output_tokens,
 *     n_cache_tokens, cost_usd}
 *   - ACP summary (acp-summary.json): usage updates emitted by the agent
 *   - DSH session log (dsh-session.json): the model adapter's request records
 *
 * Evidence readers resolve the SAME frozen Harbor layout as the trial
 * normalizer: installed-agent evidence under `trialDir/agent/` is preferred,
 * with the trial root as an explicitly documented legacy fallback. When both
 * locations exist for one source and their bytes differ, that is a conflict,
 * not a resolvable preference.
 *
 * A source file that exists but cannot be parsed, or carries a malformed /
 * negative / non-finite value, is corrupt — surfaced as inconsistent rather
 * than silently dropped or treated as missing. Unpriced usage is reported
 * explicitly (never silently zero). The reconciled record is content-addressed
 * so re-parsing the same artifacts yields the same hash.
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
  /** Agreed token counts (null when any present source disagrees). */
  nInputTokens: number | null
  nOutputTokens: number | null
  nCacheTokens: number | null
  /** Agreed USD cost (null when any present source disagrees beyond $0.001). */
  costUsd: number | null
  /** True iff no source was corrupt/conflicting and every field agrees. */
  consistent: boolean
  /** Sources whose usage was successfully read (result / acp-summary / dsh-session). */
  sources: string[]
  /** sha256 of the reconciled record (deterministic). */
  recordHash: string
  /** Human-readable reconciliation note. */
  note: string
}

type ResolvedSource =
  | { kind: 'missing' }
  | { kind: 'corrupt'; label: string; reason: string }
  | { kind: 'conflict'; label: string }
  | { kind: 'present'; label: string; usage: HarborUsage }

async function readOptionalBytes(path: string): Promise<string | null | 'unreadable'> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return 'unreadable'
  }
}

function usageField(value: unknown, label: string, reasons: string[]): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    reasons.push(`${label} is not a finite non-negative number`)
    return null
  }
  return value
}

function parseUsage(bytes: string, label: string): { usage: HarborUsage } | { reason: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes)
  } catch (error) {
    return { reason: `${label} is not valid JSON (${(error as Error).message})` }
  }
  const record =
    parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  // Harbor stores its block under agent_result; ACP and DSH sidecars use usage.
  const raw = record['agent_result'] ?? record['usage']
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return { reason: `${label} carries no usage object` }
  }
  const body = raw as Record<string, unknown>
  const reasons: string[] = []
  const usage: HarborUsage = {
    nInputTokens: usageField(
      body['n_input_tokens'] ?? body['input_tokens'],
      `${label} input tokens`,
      reasons,
    ),
    nOutputTokens: usageField(
      body['n_output_tokens'] ?? body['output_tokens'],
      `${label} output tokens`,
      reasons,
    ),
    nCacheTokens: usageField(
      body['n_cache_tokens'] ?? body['cache_tokens'],
      `${label} cache tokens`,
      reasons,
    ),
    costUsd: usageField(body['cost_usd'], `${label} USD cost`, reasons),
  }
  if (reasons.length > 0) return { reason: reasons.join('; ') }
  return { usage }
}

/**
 * Resolve one usage source with normalizer-compatible layout preference:
 * prefer `agent/<name>` when present; fall back to the legacy trial-root path;
 * both present with differing bytes is a hard conflict.
 */
async function resolveUsageSource(trialDir: string, name: string): Promise<ResolvedSource> {
  const label = name.replace(/\.json$/, '')
  const agentBytes = await readOptionalBytes(join(trialDir, 'agent', name))
  if (agentBytes === 'unreadable') {
    return { kind: 'corrupt', label, reason: `${label} under agent/ cannot be read` }
  }
  const rootBytes = await readOptionalBytes(join(trialDir, name))
  if (rootBytes === 'unreadable') {
    return { kind: 'corrupt', label, reason: `${label} at the trial root cannot be read` }
  }
  if (agentBytes !== null && rootBytes !== null && agentBytes !== rootBytes) {
    return { kind: 'conflict', label }
  }
  const bytes = agentBytes ?? rootBytes
  if (bytes === null) return { kind: 'missing' }
  const result = parseUsage(bytes, label)
  if ('reason' in result) {
    // A structurally valid document that simply carries no usage block
    // contributes nothing (missing), unlike unparseable or malformed values.
    if (/no usage object/.test(result.reason)) return { kind: 'missing' }
    return { kind: 'corrupt', label, reason: result.reason }
  }
  return { kind: 'present', label, usage: result.usage }
}

/**
 * Reconcile cost across Harbor result.json + acp-summary.json + dsh-session.json.
 *
 * Tolerance: token/cache counts must match exactly; USD within $0.001.
 * `consistent` requires EVERY reconciled field — input, output, cache tokens
 * AND USD cost — to agree across all present sources, with no corrupt or
 * conflicting source evidence anywhere.
 */
export async function reconcileCost(trialDir: string): Promise<ReconciledCost> {
  const SOURCE_NAMES = ['harbor', 'acp', 'dsh'] as const
  const resolved: ResolvedSource[] = [
    await resolveUsageSource(trialDir, 'result.json'),
    await resolveUsageSource(trialDir, 'acp-summary.json'),
    await resolveUsageSource(trialDir, 'dsh-session.json'),
  ]

  const usages: HarborUsage[] = []
  const sources: string[] = []
  resolved.forEach((row, index) => {
    if (row.kind === 'present') {
      usages.push(row.usage)
      sources.push(SOURCE_NAMES[index]!)
    }
  })

  const problems: string[] = []
  for (const row of resolved) {
    if (row.kind === 'corrupt') problems.push(row.reason)
    if (row.kind === 'conflict') {
      problems.push(
        `${row.label} exists both under agent/ and at the trial root with different bytes`,
      )
    }
  }

  function reconcileField(get: (u: HarborUsage) => number | null, exact: boolean): number | null {
    const values: number[] = []
    for (const usage of usages) {
      const value = get(usage)
      if (value !== null) values.push(value)
    }
    if (values.length === 0) return null
    const agreed = exact
      ? values.every((value) => value === values[0])
      : values.every((value) => Math.abs(value - values[0]!) < 0.001)
    return agreed ? values[0]! : null
  }

  const nInputTokens = reconcileField((u) => u.nInputTokens, true)
  const nOutputTokens = reconcileField((u) => u.nOutputTokens, true)
  const nCacheTokens = reconcileField((u) => u.nCacheTokens, true)
  const costUsd = reconcileField((u) => u.costUsd, false)

  let consistent = problems.length === 0
  for (const get of [
    (u: HarborUsage) => u.nInputTokens,
    (u: HarborUsage) => u.nOutputTokens,
    (u: HarborUsage) => u.nCacheTokens,
  ]) {
    const values = usages.map(get).filter((value): value is number => value !== null)
    if (new Set(values).size > 1) consistent = false
  }
  const costs = usages.map((u) => u.costUsd).filter((value): value is number => value !== null)
  if (costs.some((value) => Math.abs(value - costs[0]!) >= 0.001)) consistent = false

  const recordBody = JSON.stringify({
    nInputTokens,
    nOutputTokens,
    nCacheTokens,
    costUsd,
    sources,
  })
  const recordHash = createHash('sha256').update(recordBody).digest('hex')
  const unpriced = costUsd === null && (nInputTokens !== null || nOutputTokens !== null)
  const note =
    problems.length > 0
      ? `reconciliation failed: ${problems.join('; ')}`
      : sources.length === 0
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
