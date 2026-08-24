import { copyFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  genesisState,
  loadLatestSnapshot,
  writeSnapshot,
  type ControllerState,
} from '../src/index.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-snapshot-order-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function stateAt(seq: number): ControllerState {
  return {
    ...genesisState(),
    lastSeq: seq,
    lastEventHash: `sha256:${String(seq).padStart(64, '0')}`,
  }
}

describe('snapshot ordering and filename binding', () => {
  it('selects sequence 10 over sequence 9 regardless of lexicographic filename order', async () => {
    await writeSnapshot(root!, stateAt(10))
    await writeSnapshot(root!, stateAt(9))

    expect((await loadLatestSnapshot(root!))?.state.lastSeq).toBe(10)
  })

  it('selects the greatest numeric sequence across different digit widths', async () => {
    for (const seq of [1, 99, 10, 1_000, 100]) await writeSnapshot(root!, stateAt(seq))

    expect((await loadLatestSnapshot(root!))?.state.lastSeq).toBe(1_000)
  })

  it('rejects a valid record renamed to a false hash suffix', async () => {
    const original = await writeSnapshot(root!, stateAt(7))
    const renamed = join(root!, basename(original).replace(/[0-9a-f]{16}\.json$/, '0'.repeat(16) + '.json'))
    await rename(original, renamed)

    expect(await loadLatestSnapshot(root!)).toBeNull()
  })

  it('rejects conflicting files that claim the same numeric sequence', async () => {
    const original = await writeSnapshot(root!, stateAt(11))
    const conflict = join(
      root!,
      basename(original).replace(/[0-9a-f]{16}\.json$/, 'f'.repeat(16) + '.json'),
    )
    await copyFile(original, conflict)

    expect(await loadLatestSnapshot(root!)).toBeNull()
  })

  it('ignores filenames outside the immutable snapshot naming scheme', async () => {
    await writeSnapshot(root!, stateAt(7))
    await writeFile(join(root!, 'state-999-not-a-digest.json'), '{}\n')
    await writeFile(join(root!, 'state-9007199254740992-0000000000000000.json'), '{}\n')

    expect((await loadLatestSnapshot(root!))?.state.lastSeq).toBe(7)
  })
})
