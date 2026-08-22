import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  IncompleteObjectPublishError,
  exists,
  publishBytes,
  readBytes,
  scrub,
  type DataLabel,
  type ObjectStore,
} from '../src/index.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-object-interrupted-publish-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function store(): ObjectStore {
  return { root: root! }
}

async function reserveMetadataOnly(
  bytes: Uint8Array,
  mediaType: string,
  label: DataLabel,
): Promise<string> {
  const digest = createHash('sha256').update(bytes).digest('hex')
  const body = {
    schemaVersion: 1 as const,
    digest,
    size: bytes.byteLength,
    mediaType,
    label,
  }
  const metadata = {
    ...body,
    metadataHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  }
  const shard = join(root!, 'objects', 'sha256', digest.slice(0, 2))
  await mkdir(shard, { recursive: true })
  await writeFile(join(shard, `${digest}.meta.json`), JSON.stringify(metadata) + '\n')
  return digest
}

describe('interrupted object publication recovery', () => {
  it('classifies a valid metadata-only reservation as retryable, then completes it', async () => {
    const bytes = Buffer.from('recoverable publication')
    const digest = await reserveMetadataOnly(bytes, 'text/plain', 'DEV_OBSERVED')

    await expect(readBytes(store(), digest)).rejects.toMatchObject({
      name: 'IncompleteObjectPublishError',
      code: 'OBJECT_PUBLISH_INCOMPLETE',
      digest,
    } satisfies Partial<IncompleteObjectPublishError>)
    expect(await exists(store(), digest)).toBe(false)
    expect(await scrub(store())).toEqual([])

    const ref = await publishBytes(store(), bytes, 'text/plain', 'DEV_OBSERVED')
    expect(ref.digest).toBe(digest)
    expect(Buffer.from(await readBytes(store(), digest))).toEqual(bytes)
    expect(await exists(store(), digest)).toBe(true)
    expect(await scrub(store())).toEqual([])
  })

  it('does not allow a retry to change the reserved immutable label', async () => {
    const bytes = Buffer.from('fixed label')
    const digest = await reserveMetadataOnly(bytes, 'text/plain', 'PUBLIC_SPEC')

    await expect(publishBytes(store(), bytes, 'text/plain', 'SEALED')).rejects.toThrow(
      /immutable metadata conflict/,
    )
    expect(await exists(store(), digest)).toBe(false)

    const staging = join(root!, 'objects', 'sha256', '.staging')
    expect((await stat(staging)).isDirectory()).toBe(true)
    expect(await readdir(staging)).toEqual([])
  })

  it('still reports malformed metadata-only records as corruption', async () => {
    const bytes = Buffer.from('bad metadata')
    const digest = await reserveMetadataOnly(bytes, 'text/plain', 'DEV_OBSERVED')
    const path = join(root!, 'objects', 'sha256', digest.slice(0, 2), `${digest}.meta.json`)
    await writeFile(path, '{"schemaVersion":1,"metadataHash":"forged"}\n')

    expect(await scrub(store())).toEqual([digest])
  })
})
