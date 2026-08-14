/**
 * Proposal sandbox + export + protocol tests (spec 05 §5.2, spec 06 §11, spec 03 §10).
 *
 * These are the information-flow security tests. They prove:
 *  - the proposer can ONLY read inputs and write to childrenRoot;
 *  - host-sensitive paths are always denied;
 *  - the model firewall rejects route overrides;
 *  - label-filtered export NEVER includes GUARDED/SEALED in a proposer view,
 *    and a canary absence receipt is produced;
 *  - a canary token that leaked into a transcript is detected;
 *  - the proposal validator rejects no-change / test-only / duplicate hypotheses.
 *
 * Crucially, the policy decisions are pure functions — a prompt-injected trace
 * cannot change them.
 */
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  decideFsAccess,
  decideNetwork,
  enforceModelFirewall,
  canary,
  buildExport,
  buildArchiveCatalog,
  materializeProposerExport,
  publishBytes,
  verifyExport,
  scanForCanaryLeaks,
  validateProposalBatch,
  type SandboxPaths,
  type ModelRoute,
} from '../src/index.js'
import type { ObjectRef } from '../src/index.js'

const paths: SandboxPaths = {
  parent: '/input/parent',
  archive: '/input/archive',
  evidence: '/input/evidence',
  contracts: '/input/contracts',
  childrenRoot: '/work/children',
}

describe('proposal sandbox filesystem policy', () => {
  it('allows read of parent/archive/evidence/contracts', () => {
    expect(decideFsAccess(paths, '/input/parent/src/index.ts', 'read')).toBe('allow-read')
    expect(decideFsAccess(paths, '/input/archive/catalog.jsonl', 'read')).toBe('allow-read')
  })

  it('denies write to read-only inputs', () => {
    expect(decideFsAccess(paths, '/input/parent/src/index.ts', 'write')).toBe('deny')
    expect(decideFsAccess(paths, '/input/evidence/trajectories.json', 'write')).toBe('deny')
  })

  it('allows read+write only under childrenRoot', () => {
    expect(decideFsAccess(paths, '/work/children/prop-1/src/index.ts', 'write')).toBe('allow-write')
    expect(decideFsAccess(paths, '/work/children/prop-1/src/index.ts', 'read')).toBe('allow-write')
  })

  it('denies host-sensitive paths (home, SSH, docker socket, controller IPC)', () => {
    expect(decideFsAccess(paths, '/home/user/.ssh/id_rsa', 'read')).toBe('deny')
    expect(decideFsAccess(paths, '/var/run/docker.sock', 'read')).toBe('deny')
    expect(decideFsAccess(paths, '/root/.config/controller.sock', 'read')).toBe('deny')
    expect(decideFsAccess(paths, '/home/user/.aws/credentials', 'read')).toBe('deny')
  })

  it('denies traversal escapes', () => {
    expect(decideFsAccess(paths, '/input/parent/../../../etc/shadow', 'read')).toBe('deny')
    expect(decideFsAccess(paths, '/work/children/../../controller.sock', 'write')).toBe('deny')
  })

  it('is a pure function: the same inputs always yield the same decision', () => {
    // This is the anti-prompt-injection guarantee: a trace cannot mutate policy.
    for (let i = 0; i < 5; i++) {
      expect(decideFsAccess(paths, '/root/.ssh/id_rsa', 'read')).toBe('deny')
    }
  })
})

describe('proposal sandbox network policy', () => {
  it('proposal phase allows only proposer-gateway + docs-mirror', () => {
    expect(decideNetwork('proposal', 'proposer-gateway')).toBe(true)
    expect(decideNetwork('proposal', 'docs-mirror')).toBe(true)
    expect(decideNetwork('proposal', 'evil.example.com')).toBe(false)
  })

  it('build phase denies ALL network', () => {
    expect(decideNetwork('build', 'anything')).toBe(false)
    expect(decideNetwork('build', 'proposer-gateway')).toBe(false)
  })
})

describe('model firewall', () => {
  const route: ModelRoute = {
    provider: 'rsi-provider',
    endpoint: 'https://llm-gateway/v1',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'max',
    maxTokens: 4096,
  }

  it('accepts a request matching the locked route', () => {
    expect(enforceModelFirewall(route, { model: 'deepseek-v4-flash' })).toEqual(route)
  })

  it('rejects a candidate-attempted model override', () => {
    expect(() => enforceModelFirewall(route, { model: 'gpt-other' })).toThrow(/locked to/)
  })

  it('rejects a candidate-attempted endpoint override', () => {
    expect(() =>
      enforceModelFirewall(route, { model: 'deepseek-v4-flash', endpoint: 'https://evil/v1' }),
    ).toThrow(/endpoint/)
  })

  it('rejects custom billing tags', () => {
    expect(() =>
      enforceModelFirewall(route, {
        model: 'deepseek-v4-flash',
        customBillingTags: { steal: true },
      }),
    ).toThrow(/billing tags/)
  })
})

describe('label-filtered evidence export', () => {
  const objects: ObjectRef[] = [
    { algorithm: 'sha256', digest: 'a'.repeat(64), size: 10, mediaType: 'x', label: 'PUBLIC_SPEC' },
    {
      algorithm: 'sha256',
      digest: 'b'.repeat(64),
      size: 10,
      mediaType: 'x',
      label: 'DEV_OBSERVED',
    },
    { algorithm: 'sha256', digest: 'c'.repeat(64), size: 10, mediaType: 'x', label: 'GUARDED' },
    { algorithm: 'sha256', digest: 'd'.repeat(64), size: 10, mediaType: 'x', label: 'SEALED' },
  ]

  it('a proposer export (PUBLIC_SPEC+DEV_OBSERVED) excludes GUARDED/SEALED', () => {
    const manifest = buildExport({
      exportId: 'exp1',
      principal: 'proposer:act1',
      purpose: 'candidate-expansion',
      allowedLabels: ['PUBLIC_SPEC', 'DEV_OBSERVED'],
      objects,
      createdFromStateHash: 'sha256:state',
    })
    const labels = manifest.objects.map((o) => o.label)
    expect(labels).not.toContain('GUARDED')
    expect(labels).not.toContain('SEALED')
    expect(manifest.canaryAbsenceReceipt.excluded).toBe(2)
    expect(manifest.canaryAbsenceReceipt.checked).toBe(4)
  })

  it('the merkle root is tamper-evident', () => {
    const manifest = buildExport({
      exportId: 'exp2',
      principal: 'proposer:act1',
      purpose: 'candidate-expansion',
      allowedLabels: ['DEV_OBSERVED'],
      objects,
      createdFromStateHash: null,
    })
    expect(verifyExport(manifest)).toBe(true)
    // Tamper: add an object after the fact.
    manifest.objects.push({ digest: 'e'.repeat(64), label: 'DEV_OBSERVED', mediaType: 'x' })
    expect(verifyExport(manifest)).toBe(false)
  })

  it('detects a sealed canary token leaked into a transcript', () => {
    const sealedCanary = canary('sealed-task-identity')
    const guardCanary = canary('guard-aggregate')
    const cleanTranscript = 'proposer explored parent source and evidence'
    const leakedTranscript = `proposer saw the sealed task: ${sealedCanary.token}`
    expect(scanForCanaryLeaks(cleanTranscript, [sealedCanary, guardCanary])).toEqual([])
    expect(scanForCanaryLeaks(leakedTranscript, [sealedCanary, guardCanary])).toEqual([
      'sealed-task-identity',
    ])
  })

  it('materializes an atomic read-only proposer view with only allowed object bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rsi-export-'))
    try {
      const store = { root: join(root, 'store') }
      const publicRef = await publishBytes(
        store,
        new TextEncoder().encode('public-bytes'),
        'text/plain',
        'PUBLIC_SPEC',
      )
      const devRef = await publishBytes(
        store,
        new TextEncoder().encode('dev-bytes'),
        'text/plain',
        'DEV_OBSERVED',
      )
      const sealedRef = await publishBytes(
        store,
        new TextEncoder().encode('sealed-canary-bytes'),
        'text/plain',
        'SEALED',
      )
      const outDir = join(root, 'exports', 'action-1')
      const manifest = await materializeProposerExport({
        store,
        outDir,
        exportId: 'export-action-1',
        principal: 'proposer:action-1',
        objects: [sealedRef, devRef, publicRef],
        createdFromStateHash: 'sha256:state',
      })
      expect((await readdir(join(outDir, 'objects'))).sort()).toEqual(
        [devRef.digest, publicRef.digest].sort(),
      )
      expect(JSON.stringify(manifest)).not.toContain(sealedRef.digest)
      expect(await readFile(join(outDir, 'objects', devRef.digest), 'utf8')).toBe('dev-bytes')
      expect((await stat(outDir)).mode & 0o222).toBe(0)
      expect((await stat(join(outDir, 'manifest.json'))).mode & 0o222).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('DEV_OBSERVED-only archive catalog', () => {
  const candidates = [
    {
      candidateId: 'c_parent',
      canonicalParent: null,
      donorCandidates: [],
      status: 'DEV_OBSERVED' as const,
    },
  ]
  const development = [
    {
      label: 'DEV_OBSERVED' as const,
      candidateId: 'c_parent',
      taskId: 'dev-task',
      attemptIndex: 0,
      reward: 0,
      evidenceDigest: '1'.repeat(64),
    },
  ]

  it('is noninterfering with guarded/sealed observations and exposes only dev raw refs', () => {
    const clean = buildArchiveCatalog({ candidates, observations: development })
    const contaminatedInput = buildArchiveCatalog({
      candidates,
      observations: [
        ...development,
        {
          label: 'GUARDED',
          candidateId: 'c_parent',
          taskId: 'guard-canary-task',
          attemptIndex: 0,
          reward: 1,
          evidenceDigest: '2'.repeat(64),
        },
        {
          label: 'SEALED',
          candidateId: 'c_parent',
          taskId: 'sealed-canary-task',
          attemptIndex: 0,
          reward: 1,
          evidenceDigest: '3'.repeat(64),
        },
      ],
    })
    expect(contaminatedInput).toEqual(clean)
    expect(JSON.stringify(clean)).not.toContain('guard-canary')
    expect(JSON.stringify(clean)).not.toContain('sealed-canary')
    expect(clean.candidates[0]!.rawEvidenceDigests).toEqual(['1'.repeat(64)])
    expect(clean.candidates[0]!.successes).toBe(0)
    expect(clean.candidates[0]!.failures).toBe(1)
  })
})

describe('proposal output protocol validator', () => {
  const parentDigest = 'sha256:' + 'a'.repeat(64)

  function goodChild(
    overrides: Partial<Parameters<typeof validateProposalBatch>[0]['children'][number]> = {},
  ) {
    return {
      proposalId: 'p1',
      canonicalParentDigest: parentDigest,
      donorCandidates: [],
      hypothesis: 'Add a retry wrapper around tool failures to improve recovery',
      evidenceRefs: ['evidence://dev/trace1'],
      mechanismTests: ['retries on transient failure'],
      preservationTests: ['no extra call on success'],
      sourceDiff: '+export function withRetry() { ... }',
      ...overrides,
    }
  }

  it('accepts a well-formed child', () => {
    const res = validateProposalBatch({ parentDigest, children: [goodChild()] })
    expect(res.accepted.length).toBe(1)
    expect(res.rejected).toEqual([])
  })

  it('rejects a no-change proposal (empty diff)', () => {
    const res = validateProposalBatch({ parentDigest, children: [goodChild({ sourceDiff: '' })] })
    expect(res.accepted.length).toBe(0)
    expect(res.rejected[0]!.reason).toMatch(/no-change/)
  })

  it('rejects a test-only proposal', () => {
    const res = validateProposalBatch({
      parentDigest,
      children: [goodChild({ sourceDiff: '+// tests/ only change\n+expect(true).toBe(true)' })],
    })
    expect(res.rejected[0]!.reason).toMatch(/test-only/)
  })

  it('rejects a short/empty hypothesis', () => {
    const res = validateProposalBatch({
      parentDigest,
      children: [goodChild({ hypothesis: 'fix' })],
    })
    expect(res.rejected[0]!.reason).toMatch(/hypothesis/)
  })

  it('rejects missing mechanism/preservation tests', () => {
    const res = validateProposalBatch({
      parentDigest,
      children: [goodChild({ mechanismTests: [] })],
    })
    expect(res.rejected[0]!.reason).toMatch(/tests/)
  })

  it('rejects duplicate hypotheses within a batch', () => {
    const c1 = goodChild({ proposalId: 'p1' })
    const c2 = goodChild({ proposalId: 'p2' }) // same hypothesis
    const res = validateProposalBatch({ parentDigest, children: [c1, c2] })
    expect(res.accepted.length).toBe(1)
    expect(res.rejected.some((r) => r.reason.includes('duplicate'))).toBe(true)
  })

  it('rejects proposals exceeding proposalWidth', () => {
    const children = Array.from({ length: 5 }, (_, i) =>
      goodChild({ proposalId: `p${i}`, hypothesis: `hypothesis number ${i} distinct` }),
    )
    const res = validateProposalBatch({ parentDigest, children }, 3)
    expect(res.accepted.length).toBe(3)
    expect(res.rejected.length).toBe(2)
    expect(res.rejected.every((r) => r.reason.includes('exceeds'))).toBe(true)
  })

  it('rejects a malformed donor digest', () => {
    const res = validateProposalBatch({
      parentDigest,
      children: [goodChild({ donorCandidates: ['not-a-digest'] })],
    })
    expect(res.rejected[0]!.reason).toMatch(/donor/)
  })
})
