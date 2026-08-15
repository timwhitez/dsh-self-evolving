#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lock = JSON.parse(await readFile(join(repoRoot, 'provenance.lock.json'), 'utf8'))

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function verifiedBytes(name, reference) {
  if (
    typeof reference.path !== 'string' ||
    !reference.path.startsWith('.references/') ||
    typeof reference.sourceUrl !== 'string' ||
    !reference.sourceUrl.startsWith('https://') ||
    typeof reference.value !== 'string' ||
    !/^[0-9a-f]{64}$/.test(reference.value)
  ) {
    throw new Error(`reference ${name}: invalid materialization contract`)
  }
  const target = resolve(repoRoot, reference.path)
  const cacheRoot = resolve(repoRoot, '.references')
  if (!target.startsWith(cacheRoot + sep)) throw new Error(`reference ${name}: path escapes cache`)
  const existing = await readFile(target).catch(() => null)
  if (existing !== null) return { target, bytes: existing, source: 'cache' }
  const response = await globalThis.fetch(reference.sourceUrl, { redirect: 'error' })
  if (!response.ok) throw new Error(`reference ${name}: download HTTP ${response.status}`)
  return { target, bytes: Buffer.from(await response.arrayBuffer()), source: 'download' }
}

for (const [name, reference] of Object.entries(lock.references ?? {})) {
  const materialized = await verifiedBytes(name, reference)
  const actual = sha256(materialized.bytes)
  if (actual !== reference.value) {
    throw new Error(`reference ${name}: sha256 ${actual} != locked ${reference.value}`)
  }
  if (materialized.source === 'download') {
    await mkdir(dirname(materialized.target), { recursive: true, mode: 0o700 })
    await writeFile(materialized.target, materialized.bytes, { flag: 'wx', mode: 0o600 })
  }
  process.stdout.write(`${name} sha256:${actual} READY (${materialized.source})\n`)
}
