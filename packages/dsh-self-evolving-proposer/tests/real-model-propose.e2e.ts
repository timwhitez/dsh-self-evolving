/**
 * Gate 4 — real-model proposal E2E (spec 07 §6 Accept).
 *
 * "baseline parent 从两条 synthetic failure trace 生成 ≥1 个 nontrivial admitted
 * child，preservation tests 通过，transcript/cost 完整".
 *
 * This test boots the REAL DSH Loader with a model-backed composition
 * (llm-responses → agent-spine-demo → agent-default-model), drives
 * ctx.agents.create with the locked deepseek-v4-flash provider, and asserts
 * the model produces ≥1 nontrivial proposal that passes the protocol validator.
 *
 * Requires: DEEPSEEK_API_KEY env + the verified provider endpoint. Skips
 * gracefully if the key is absent (CI without secrets).
 *
 * The parent is the @dsh-self-evolving/candidate-baseline (the stable baseline). Evidence
 * is two synthetic DEV_OBSERVED failure traces (no guard/sealed data).
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import { runProposalTurn, parseAndValidate, parentDigestOf, type ModelRoute } from '../src/index.js'
import { declareFiles } from '@dsh-self-evolving/candidate-sdk'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const baselineRoot = resolve(repoRoot, 'packages', 'candidate-baseline')
const dshRoot = resolve(repoRoot, 'deepseek-harness')

const ROUTE: ModelRoute = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  maxTokens: 32_768,
}
const API_KEY = process.env['DEEPSEEK_API_KEY'] ?? ''

let scratch: string | undefined

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-propose-'))
})

afterEach(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
  scratch = undefined
})

async function linkPkg(scope: string, name: string, source: string): Promise<void> {
  const scopeDir = join(scratch!, 'node_modules', scope)
  await mkdir(scopeDir, { recursive: true })
  await symlink(source, join(scopeDir, name), 'dir')
}

/**
 * Boot the real DSH Loader with a minimal model-backed composition. Only the
 * deepseek-official adapter is registered, so the proposer's model route is
 * locked by composition.
 */
async function bootModelComposition(): Promise<Context> {
  // Link the built DSH packages + candidate baseline into the fixture root.
  await linkPkg('@deepseek-ai', 'cordis', join(dshRoot, 'vendor', 'cordis'))
  await linkPkg('@deepseek-ai', 'schemastery', join(dshRoot, 'vendor', 'schemastery'))
  await linkPkg('@deepseek-ai', 'cosmokit', join(dshRoot, 'vendor', 'cosmokit'))
  await linkPkg('@deepseek-ai', 'cordis-plugin-loader', join(dshRoot, 'vendor', 'loader'))
  await linkPkg('@deepseek-ai', 'cordis-plugin-include', join(dshRoot, 'vendor', 'include'))
  await linkPkg('@deepseek-ai', 'cordis-plugin-group', join(dshRoot, 'vendor', 'group'))
  await linkPkg('@deepseek-ai', 'dsh-llm', join(dshRoot, 'packages', 'llm', 'llm'))
  await linkPkg(
    '@dsh-self-evolving',
    'llm-responses',
    join(repoRoot, 'packages', 'dsh-self-evolving-llm-responses'),
  )
  await linkPkg(
    '@dsh-self-evolving',
    'proposer',
    join(repoRoot, 'packages', 'dsh-self-evolving-proposer'),
  )
  await linkPkg('@deepseek-ai', 'dsh-session', join(dshRoot, 'packages', 'core', 'session'))
  await linkPkg('@deepseek-ai', 'dsh-agent', join(dshRoot, 'packages', 'core', 'agent'))
  await linkPkg(
    '@deepseek-ai',
    'dsh-agent-default-model',
    join(dshRoot, 'packages', 'core', 'agent-default-model'),
  )
  await linkPkg(
    '@deepseek-ai',
    'dsh-agent-spine-demo',
    join(dshRoot, 'packages', 'examples', 'agent-spine-demo'),
  )
  // The spine pulls in many sub-packages; link the ones it imports.
  for (const [n, p] of [
    ['dsh-system-prompt', join('packages', 'core', 'system-prompt')],
    ['dsh-tools', join('packages', 'core', 'tools')],
    ['dsh-agent-loop', join('packages', 'core', 'agent-loop')],
    ['dsh-llm-retry', join('packages', 'llm', 'llm-retry')],
    ['dsh-skill', join('packages', 'core', 'skill')],
    ['dsh-agent-instructions', join('packages', 'core', 'agent-instructions')],
    ['dsh-invariants', join('packages', 'core', 'invariants')],
    ['dsh-tool-bash', join('packages', 'tools', 'tool-bash')],
    ['dsh-subprocess', join('packages', 'subprocess', 'subprocess')],
    ['dsh-goals', join('packages', 'core', 'goals')],
  ] as const) {
    await linkPkg('@deepseek-ai', n, join(dshRoot, p)).catch(() => {})
  }

  // cordis.yml: minimal model-backed composition.
  await writeFile(
    join(scratch!, 'cordis.yml'),
    [
      '- id: llm',
      "  name: '@deepseek-ai/dsh-llm'",
      '  config: {}',
      '- id: llm-responses',
      "  name: '@dsh-self-evolving/llm-responses'",
      '  config:',
      '    apiKeyEnv: DEEPSEEK_API_KEY',
      '    reasoningEffort: high',
      '    contextWindow: 1048576',
      '    maxTokens: 32768',
      '- id: agent-default-model',
      "  name: '@deepseek-ai/dsh-agent-default-model'",
      '  config:',
      '    provider: deepseek-official',
      '    model: deepseek-v4-flash',
      '- id: agent-spine',
      "  name: '@deepseek-ai/dsh-agent-spine-demo'",
      '  config:',
      '    workspaceContext: false',
      "    persona: 'You are a precise proposer agent. Follow output protocols exactly.'",
      '',
    ].join('\n'),
  )

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(join(scratch!, 'cordis.yml')).href
  await ctx.plugin(Loader)
  const c = ctx as unknown as Context & {
    loader: {
      internal?: { version: string; import: (s: string) => Promise<unknown> }
      builtins: { include: unknown; group: unknown }
      create: (opts: { id: string; name: string; config: unknown }) => Promise<string>
      await: () => Promise<void>
    }
  }
  const fixtureRequire = createRequire(join(scratch!, 'package.json'))
  c.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      return await import(pathToFileURL(fixtureRequire.resolve(specifier)).href)
    },
  }
  c.loader.builtins.include = Include
  c.loader.builtins.group = Group
  await c.loader.create({
    id: 'include',
    name: 'cordis:include',
    config: { path: pathToFileURL(join(scratch!, 'cordis.yml')).href },
  })
  await c.loader.await()
  return ctx
}

const MODEL_TIMEOUT = { timeout: 180_000 }

describe.skipIf(!API_KEY)('Gate 4 — real-model proposal (deepseek-v4-flash)', () => {
  it(
    'generates >=1 nontrivial admitted child from the baseline parent + synthetic evidence',
    MODEL_TIMEOUT,
    async () => {
      const ctx = await bootModelComposition()
      try {
        // Parent = the baseline candidate source. Compute its canonical digest.
        const parentDigest = await parentDigestOf(
          declareFiles(baselineRoot, ['src/index.ts', 'package.json', 'candidate.json']),
        )
        const parentSource = `
export const name = 'self-evolving-candidate'
export const inject = ['systemPrompt']
export function apply(ctx, config) {
  ctx.systemPrompt.section({ name: 'candidate:baseline', order: 100, text: 'You are solving a Terminal-Bench task.' })
}`.trim()

        // Two synthetic DEV_OBSERVED failure traces (no guard/sealed).
        const evidenceSummary = [
          '## Observed DEV failures (2 trials)',
          '1. Task "build-pipeline": candidate produced correct files but timed out on a slow tool call (transient).',
          '2. Task "config-parse": candidate re-ran an expensive tool after a recoverable error, wasting budget.',
          'Hypothesis space: retry/recovery policy, tool-result caching, prompt-level step budgeting.',
        ].join('\n')

        const transcript = await runProposalTurn(ctx, ROUTE, {
          parentDigest,
          parentSource,
          evidenceSummary,
          width: 3,
        })

        // The model MUST have produced some assistant text.
        if (transcript.assistantText.length === 0) {
          // Surface the event types for diagnosis when the model produced no text.
          throw new Error(
            `model produced no assistant text (eventCount=${transcript.eventCount}). ` +
              `Raw: ${JSON.stringify(transcript).slice(0, 800)}`,
          )
        }
        expect(transcript.assistantText.length).toBeGreaterThan(0)
        expect(transcript.eventCount).toBeGreaterThan(0)
        expect(transcript.modelRoute.model).toBe('deepseek-v4-flash')

        // Parse + validate: >=1 nontrivial admitted child.
        const parsed = parseAndValidate(transcript.assistantText, parentDigest, 3)
        expect(
          parsed.accepted.length,
          `expected >=1 admitted child; got ${parsed.accepted.length} accepted, ${parsed.rejected.length} rejected. Raw: ${transcript.assistantText.slice(0, 500)}`,
        ).toBeGreaterThanOrEqual(1)

        // The admitted child must have a real hypothesis + a production diff.
        const child = parsed.accepted[0]!
        expect(child.canonicalParentDigest).toBe(parentDigest)
        expect(child.hypothesis.length).toBeGreaterThanOrEqual(20)
        expect(child.sourceDiff.trim().length).toBeGreaterThan(0)
        expect(child.mechanismTests.length).toBeGreaterThan(0)
        expect(child.preservationTests.length).toBeGreaterThan(0)
      } finally {
        await ctx.fiber.dispose()
      }
    },
  )
})
