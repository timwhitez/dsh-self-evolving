import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { publishBytes, type ObjectRef, type ObjectStore } from '../src/index.js'
import {
  buildExport,
  materializeProposerExport,
  reconcileExportObjectRefs,
} from '../src/proposal/export.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-export-ref-conflict-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function store(): ObjectStore {
  return { root: join(root!, 'store') }
}

function relabel(ref: ObjectRef, label: ObjectRef['label']): ObjectRef {
  return { ...ref, label }
}

describe('proposal export object reference reconciliation', () => {
  it('rejects one digest presented under both public and sealed labels', async () => {
    const sealed = await publishBytes(store(), Buffer.from('sealed bytes'), 'text/plain', 'SEALED')
    const forgedPublic = relabel(sealed, 'PUBLIC_SPEC')

    expect(() => reconcileExportObjectRefs([forgedPublic, sealed])).toThrow(
      /conflicting immutable refs/,
    )
    expect(() => reconcileExportObjectRefs([sealed, forgedPublic])).toThrow(
      /conflicting immutable refs/,
    )
  })

  it('rejects the relabel before a proposer export directory is created', async () => {
    const sealed = await publishBytes(store(), Buffer.from('sealed bytes'), 'text/plain', 'SEALED')
    const output = join(root!, 'exports', 'proposal-1')

    await expect(
      materializeProposerExport({
        store: store(),
        outDir: output,
        exportId: 'export-1',
        principal: 'proposer:proposal-1',
        objects: [sealed, relabel(sealed, 'PUBLIC_SPEC')],
        createdFromStateHash: null,
      }),
    ).rejects.toThrow(/conflicting immutable refs/)
    expect(await stat(output).catch(() => null)).toBeNull()
  })

  it('also rejects conflicting size and media metadata for one digest', () => {
    const base: ObjectRef = {
      algorithm: 'sha256',
      digest: 'a'.repeat(64),
      size: 10,
      mediaType: 'text/plain',
      label: 'DEV_OBSERVED',
    }

    expect(() => reconcileExportObjectRefs([base, { ...base, size: 11 }])).toThrow(
      /conflicting immutable refs/,
    )
    expect(() =>
      reconcileExportObjectRefs([base, { ...base, mediaType: 'application/json' }]),
    ).toThrow(/conflicting immutable refs/)
  })

  it('collapses exact duplicates before filtering and receipt accounting', () => {
    const ref: ObjectRef = {
      algorithm: 'sha256',
      digest: 'b'.repeat(64),
      size: 10,
      mediaType: 'application/json',
      label: 'DEV_OBSERVED',
    }
    const manifest = buildExport({
      exportId: 'export-1',
      principal: 'proposer:proposal-1',
      purpose: 'candidate-expansion',
      allowedLabels: ['PUBLIC_SPEC', 'DEV_OBSERVED'],
      objects: [ref, { ...ref }],
      createdFromStateHash: null,
    })

    expect(manifest.objects).toEqual([
      { digest: ref.digest, label: ref.label, mediaType: ref.mediaType },
    ])
    expect(manifest.canaryAbsenceReceipt.checked).toBe(1)
  })
})
