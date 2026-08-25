import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  exists,
  publishBytes,
  readBytes,
  scrub,
  type DataLabel,
  type ObjectStore,
} from '../src/index.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-object-bytes-first-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function store(): ObjectStore {
  return { root: root! }
}

function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function shardPath(digest: string): string {
  return join(root!, 'objects', 'sha256', digest.slice(0, 2))
}

async function writeBytesOnly(bytes: Uint8Array): Promise<string> {
  const digest = digestOf(bytes)
  const shard = shardPath(digest)
  await mkdir(shard, { recursive: true })
  await writeFile(join(shard, digest), bytes)
  return digest
}

async function writeMetadataOnly(
  bytes: Uint8Array,
  mediaType: string,
  label: DataLabel,
): Promise<string> {
  const digest = digestOf(bytes)
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
  const shard = shardPath(digest)
  await mkdir(shard, { recursive: true })
  await writeFile(join(shard, `${digest}.meta.json`), JSON.stringify(metadata) + '\n')
  return digest
}

describe('bytes-first object publication', () => {
  it('recovers an interrupted bytes-only commit using the exact immutable reference', async () => {
    const bytes = Buffer.from('durable bytes before metadata')
    const digest = await writeBytesOnly(bytes)

    expect(await exists(store(), digest)).toBe(false)
    await expect(readBytes(store(), digest)).rejects.toMatchObject({
      name: 'IncompleteObjectPublishError',
      code: 'OBJECT_PUBLISH_INCOMPLETE',
      digest,
    })

    const ref = await publishBytes(store(), bytes, 'text/plain', 'DEV_OBSERVED')
    expect(ref.digest).toBe(digest)
    expect(await exists(store(), digest)).toBe(true)
    expect(Buffer.from(await readBytes(store(), digest))).toEqual(bytes)
    expect(await scrub(store())).toEqual([])
  })

  it('never treats a legacy metadata-only record as healthy', async () => {
    const bytes = Buffer.from('legacy metadata-first state')
    const digest = await writeMetadataOnly(bytes, 'text/plain', 'PUBLIC_SPEC')

    expect(await exists(store(), digest)).toBe(false)
    expect(await scrub(store())).toEqual([digest])

    const ref = await publishBytes(store(), bytes, 'text/plain', 'PUBLIC_SPEC')
    expect(ref.digest).toBe(digest)
    expect(Buffer.from(await readBytes(store(), digest))).toEqual(bytes)
    expect(await scrub(store())).toEqual([])
  })

  it('fails closed when the same bytes are already bound to different metadata', async () => {
    const bytes = Buffer.from('immutable label binding')
    await publishBytes(store(), bytes, 'text/plain', 'PUBLIC_SPEC')
    await expect(publishBytes(store(), bytes, 'text/plain', 'SEALED')).rejects.toThrow(
      /immutable metadata conflict/,
    )
  })

  it('leaves no staging artifacts after a completed publication', async () => {
    await publishBytes(store(), Buffer.from('clean staging'), 'text/plain', 'PUBLIC_SPEC')
    const staging = join(root!, 'objects', 'sha256', '.staging')
    expect(await readdir(staging)).toEqual([])
  })
})
