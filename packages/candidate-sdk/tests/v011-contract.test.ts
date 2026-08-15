import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertDeclaredOperations,
  assertV011,
  deriveV011Operations,
  freezeCapabilityCatalog,
  materializeV011ChildSlot,
  reserveProposalId,
  snapshotV011Tree,
  validateV011,
  V011_PROTOCOL,
  type CapabilityCatalog,
} from '../src/index.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-v011-tree-'))
  roots.push(root)
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'tests'), { recursive: true })
  await Promise.all([
    writeFile(join(root, 'src/index.ts'), "export const value = 'parent'\n"),
    writeFile(join(root, 'tests/base.spec.ts'), 'export const preservation = true\n'),
    writeFile(join(root, 'package.json'), '{"name":"trusted-template"}\n'),
    writeFile(join(root, 'cordis.patch.yml'), '- insert: []\n'),
    writeFile(join(root, 'tsconfig.json'), '{}\n'),
    writeFile(
      join(root, 'candidate.json'),
      JSON.stringify({
        schemaVersion: 2,
        proposal: {
          hypothesis: 'The parent behavior remains a neutral migration baseline.',
          targetFailureModes: ['none'],
          expectedBehaviorChange: 'No change in the migration baseline.',
          regressionRisks: ['none'],
          touchedSurfaces: ['systemPrompt'],
        },
        runtime: {
          requiredServices: ['systemPrompt'],
          optionalServices: [],
          newToolNames: [],
          supportsModes: ['solve', 'propose'],
        },
        tests: {
          mechanismAssertions: ['loader activates'],
          preservationAssertions: ['loader unloads'],
        },
      }) + '\n',
    ),
  ])
  return root
}

describe('v0.1.1 contract and containment', () => {
  it('compiles every successor schema and rejects unknown identity fields', async () => {
    const root = await fixture()
    const intent = JSON.parse(await readFile(join(root, 'candidate.json'), 'utf8')) as Record<
      string,
      unknown
    >
    await expect(assertV011('candidate-intent', intent)).resolves.toBeUndefined()
    intent['candidateId'] = 'model-authored-identity'
    const rejected = await validateV011('candidate-intent', intent)
    expect(rejected.valid).toBe(false)

    await expect(
      assertV011('migration-receipt', {
        schemaVersion: 1,
        protocol: V011_PROTOCOL,
        v01ReleaseCommit: '7'.repeat(40),
        v01SourceDigest: `sha256:${'1'.repeat(64)}`,
        v011SourceDigest: `sha256:${'2'.repeat(64)}`,
        mapping: 'BEHAVIOR_BYTES_PRESERVED_IDENTITY_FIELDS_REMOVED',
        inheritedResultsPolicy: 'none',
      }),
    ).resolves.toBeUndefined()
  })

  it('reserves deterministic IDs without clock or random fallback', () => {
    const input = {
      runId: 'v011-test',
      generation: 2,
      attempt: 1,
      parentDigest: `sha256:${'a'.repeat(64)}`,
      exportManifestDigest: `sha256:${'b'.repeat(64)}`,
      capabilityCatalogDigest: `sha256:${'c'.repeat(64)}`,
    }
    expect(reserveProposalId(input)).toBe(reserveProposalId(input))
    expect(reserveProposalId(input)).toMatch(/^p_[0-9a-f]{32}$/)
  })

  it('derives nested add, modify, and remove exactly', async () => {
    const parentRoot = await fixture()
    const slot = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-v011-slot-'))
    roots.push(slot)
    const childRoot = join(slot, 'tree')
    await materializeV011ChildSlot(parentRoot, childRoot)
    await mkdir(join(childRoot, 'src', 'retry'), { recursive: true })
    await writeFile(join(childRoot, 'src', 'retry', 'bounded.ts'), 'export const retries = 1\n')
    await writeFile(
      join(childRoot, 'src', 'index.ts'),
      "export { retries } from './retry/bounded.js'\n",
    )
    await rm(join(childRoot, 'tests', 'base.spec.ts'))
    const diff = await deriveV011Operations(
      await snapshotV011Tree(parentRoot),
      await snapshotV011Tree(childRoot),
    )
    expect(diff.operations).toEqual([
      { op: 'modify', path: 'src/index.ts' },
      { op: 'add', path: 'src/retry/bounded.ts' },
      { op: 'remove', path: 'tests/base.spec.ts' },
    ])
    expect(() => assertDeclaredOperations(diff.operations, diff.operations)).not.toThrow()
    expect(() => assertDeclaredOperations(diff.operations, diff.operations.slice(0, 2))).toThrow(
      /do not exactly match/,
    )
  })

  it('rejects template changes, traversal links, and identity self-reference', async () => {
    const parentRoot = await fixture()
    const slot = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-v011-negative-'))
    roots.push(slot)
    const childRoot = join(slot, 'tree')
    await materializeV011ChildSlot(parentRoot, childRoot)
    await writeFile(join(childRoot, 'package.json'), '{"name":"proposer-overwrite"}\n')
    await expect(
      deriveV011Operations(await snapshotV011Tree(parentRoot), await snapshotV011Tree(childRoot)),
    ).rejects.toThrow(/trusted template changed/)

    const linkRoot = await fixture()
    await symlink('/etc/passwd', join(linkRoot, 'src', 'escape.ts'))
    await expect(snapshotV011Tree(linkRoot)).rejects.toThrow(/symlink rejected/)
  })

  it('freezes exact capabilities and a request cannot widen the current catalog', async () => {
    const catalog: CapabilityCatalog = {
      schemaVersion: 1,
      protocol: V011_PROTOCOL,
      dshCommit: '4'.repeat(40),
      capabilities: [
        {
          id: 'systemPrompt',
          tier: 'T0',
          kind: 'service',
          signature: 'systemPrompt.section(input): disposer',
          enabled: true,
          fixtureDigest: `sha256:${'1'.repeat(64)}`,
        },
        {
          id: 'agent/request',
          tier: 'T3',
          kind: 'event',
          signature: 'privileged waterfall',
          enabled: false,
          fixtureDigest: null,
        },
      ],
    }
    const frozen = await freezeCapabilityCatalog(catalog)
    expect(frozen.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    await expect(
      freezeCapabilityCatalog({
        ...catalog,
        capabilities: [
          { ...catalog.capabilities[1]!, enabled: true, fixtureDigest: `sha256:${'2'.repeat(64)}` },
        ],
      }),
    ).rejects.toThrow(/privileged capability/)
  })
})
