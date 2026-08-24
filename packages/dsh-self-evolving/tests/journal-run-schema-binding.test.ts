import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  append,
  canonicalJson,
  computeEventHash,
  readAll,
  readHead,
  type Journal,
  type JournalEvent,
  type JournalHead,
} from '../src/index.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-journal-run-schema-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function journal(runId = 'run-a', name = 'journal'): Journal {
  return {
    journalDir: join(root!, name),
    runId,
    segmentMaxBytes: 1_000_000,
  }
}

function appendInput(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'event-1',
    occurredAt: '2026-08-23T00:00:00.000Z',
    type: 'test.event',
    causationId: null,
    correlationId: null,
    actor: 'test',
    payload: { value: 1 },
    ...overrides,
  }
}

async function appendFixture(j: Journal) {
  return append(j, appendInput())
}

function headFor(j: Journal, eventHash: string): JournalHead {
  return {
    schemaVersion: 1,
    runId: j.runId,
    seq: 1,
    eventHash,
    segment: 'events-000001.jsonl',
  }
}

async function writeHead(j: Journal, head: Record<string, unknown>): Promise<void> {
  await writeFile(join(j.journalDir, 'HEAD'), canonicalJson(head) + '\n')
}

async function forgeSingleEvent(
  j: Journal,
  mutate: (event: Record<string, unknown>) => void,
  recomputeHash = true,
): Promise<void> {
  const original = await appendFixture(j)
  const segmentPath = join(j.journalDir, 'events-000001.jsonl')
  const event = JSON.parse(await readFile(segmentPath, 'utf8')) as Record<string, unknown>
  mutate(event)
  if (recomputeHash) {
    event['eventHash'] = computeEventHash(event as unknown as Omit<JournalEvent, 'eventHash'>)
  }
  await writeFile(segmentPath, canonicalJson(event) + '\n')
  const headHash =
    typeof event['eventHash'] === 'string' && /^sha256:[0-9a-f]{64}$/.test(event['eventHash'])
      ? event['eventHash']
      : original.eventHash
  await writeHead(j, headFor(j, headHash))
}

describe('journal run and complete envelope binding', () => {
  it('rejects a valid hash chain when opened under a different run id', async () => {
    const original = journal('run-a')
    await appendFixture(original)

    await expect(readHead(journal('run-b'))).rejects.toThrow(/HEAD runId.*configured run/)
    await expect(readAll(journal('run-b'))).rejects.toThrow(/HEAD runId.*configured run/)
  })

  const malformedEvents: Array<{
    label: string
    mutate: (event: Record<string, unknown>) => void
    recomputeHash?: boolean
    pattern: RegExp
  }> = [
    {
      label: 'schema version',
      mutate: (event) => {
        event['schemaVersion'] = 2
      },
      pattern: /unsupported schema/,
    },
    {
      label: 'foreign run',
      mutate: (event) => {
        event['runId'] = 'run-b'
      },
      pattern: /runId.*configured run/,
    },
    {
      label: 'unsafe sequence',
      mutate: (event) => {
        event['seq'] = Number.MAX_SAFE_INTEGER + 1
      },
      pattern: /invalid sequence/,
    },
    {
      label: 'empty event id',
      mutate: (event) => {
        event['eventId'] = ''
      },
      pattern: /invalid eventId/,
    },
    {
      label: 'non-canonical timestamp',
      mutate: (event) => {
        event['occurredAt'] = '2026-08-23T00:00:00Z'
      },
      pattern: /invalid occurredAt/,
    },
    {
      label: 'empty event type',
      mutate: (event) => {
        event['type'] = ' '
      },
      pattern: /invalid type/,
    },
    {
      label: 'numeric causation id',
      mutate: (event) => {
        event['causationId'] = 7
      },
      pattern: /invalid causationId/,
    },
    {
      label: 'empty correlation id',
      mutate: (event) => {
        event['correlationId'] = ''
      },
      pattern: /invalid correlationId/,
    },
    {
      label: 'empty actor',
      mutate: (event) => {
        event['actor'] = ''
      },
      pattern: /invalid actor/,
    },
    {
      label: 'null payload',
      mutate: (event) => {
        event['payload'] = null
      },
      pattern: /payload must be a JSON object/,
    },
    {
      label: 'array payload',
      mutate: (event) => {
        event['payload'] = []
      },
      pattern: /payload must be a JSON object/,
    },
    {
      label: 'invalid previous hash',
      mutate: (event) => {
        event['previousHash'] = 'sha256:short'
      },
      pattern: /invalid previousHash/,
    },
    {
      label: 'invalid event hash',
      mutate: (event) => {
        event['eventHash'] = 'sha256:short'
      },
      recomputeHash: false,
      pattern: /invalid eventHash/,
    },
    {
      label: 'unknown field',
      mutate: (event) => {
        event['unexpected'] = true
      },
      pattern: /invalid schema/,
    },
    {
      label: 'missing field',
      mutate: (event) => {
        delete event['actor']
      },
      pattern: /invalid schema/,
    },
  ]

  for (const { label, mutate, recomputeHash = true, pattern } of malformedEvents) {
    it(`rejects a hash-consistent event with ${label}`, async () => {
      const j = journal('run-a', `event-${label.replaceAll(' ', '-')}`)
      await forgeSingleEvent(j, mutate, recomputeHash)

      await expect(readAll(j)).rejects.toThrow(pattern)
    })
  }

  it('rejects non-canonical and duplicate-key event encodings', async () => {
    const j = journal()
    await appendFixture(j)
    const segmentPath = join(j.journalDir, 'events-000001.jsonl')
    const canonical = (await readFile(segmentPath, 'utf8')).trimEnd()

    await writeFile(
      segmentPath,
      canonical.replace('"actor":"test"', '"actor":"other","actor":"test"') + '\n',
    )
    await expect(readAll(j)).rejects.toThrow(/not canonically encoded/)

    await writeFile(segmentPath, JSON.stringify(JSON.parse(canonical), null, 2) + '\n')
    await expect(readAll(j)).rejects.toThrow(/not valid JSON|not canonically encoded/)
  })

  it('ignores uncommitted suffixes but rejects committed damage and malformed names', async () => {
    const blank = journal('run-a', 'blank')
    await appendFixture(blank)
    const blankPath = join(blank.journalDir, 'events-000001.jsonl')
    await writeFile(blankPath, (await readFile(blankPath, 'utf8')) + '\n')
    expect(await readAll(blank)).toHaveLength(1)
    await append(blank, appendInput({ eventId: 'event-2' }))
    expect(await readAll(blank)).toHaveLength(2)

    const empty = journal('run-a', 'empty')
    const emptyEvent = await appendFixture(empty)
    await writeFile(join(empty.journalDir, 'events-000001.jsonl'), '')
    await writeHead(empty, headFor(empty, emptyEvent.eventHash))
    await expect(readAll(empty)).rejects.toThrow(/segment.*empty/)

    for (const [index, invalidName] of [
      'events-invalid.jsonl',
      'events-000000.jsonl',
      'events-1.jsonl',
      'events-0000001.jsonl',
      'events-9007199254740992.jsonl',
    ].entries()) {
      const malformed = journal('run-a', `malformed-segment-${index}`)
      await appendFixture(malformed)
      await writeFile(join(malformed.journalDir, invalidName), '{}\n')
      await expect(readAll(malformed), invalidName).rejects.toThrow(/invalid segment filename/)
    }

    const unterminated = journal('run-a', 'unterminated')
    await appendFixture(unterminated)
    const unterminatedPath = join(unterminated.journalDir, 'events-000001.jsonl')
    await writeFile(unterminatedPath, (await readFile(unterminatedPath, 'utf8')).trimEnd())
    await expect(readAll(unterminated)).rejects.toThrow(/missing a committed record terminator/)
  })

  const malformedHeads: Array<{
    label: string
    mutate: (head: Record<string, unknown>) => void
    pattern: RegExp
  }> = [
    {
      label: 'schema version',
      mutate: (head) => {
        head['schemaVersion'] = 2
      },
      pattern: /unsupported schema/,
    },
    {
      label: 'foreign run',
      mutate: (head) => {
        head['runId'] = 'run-b'
      },
      pattern: /runId.*configured run/,
    },
    {
      label: 'invalid sequence',
      mutate: (head) => {
        head['seq'] = 0
      },
      pattern: /invalid sequence/,
    },
    {
      label: 'invalid hash',
      mutate: (head) => {
        head['eventHash'] = 'sha256:short'
      },
      pattern: /invalid event hash/,
    },
    {
      label: 'invalid segment',
      mutate: (head) => {
        head['segment'] = '../events-000001.jsonl'
      },
      pattern: /invalid segment name/,
    },
    {
      label: 'zero segment index',
      mutate: (head) => {
        head['segment'] = 'events-000000.jsonl'
      },
      pattern: /invalid segment name/,
    },
    {
      label: 'non-canonical segment alias',
      mutate: (head) => {
        head['segment'] = 'events-0000001.jsonl'
      },
      pattern: /invalid segment name/,
    },
    {
      label: 'unknown field',
      mutate: (head) => {
        head['unexpected'] = true
      },
      pattern: /invalid schema/,
    },
    {
      label: 'missing field',
      mutate: (head) => {
        delete head['runId']
      },
      pattern: /invalid schema/,
    },
  ]

  for (const { label, mutate, pattern } of malformedHeads) {
    it(`rejects a HEAD with ${label}`, async () => {
      const j = journal('run-a', `head-${label.replaceAll(' ', '-')}`)
      const event = await appendFixture(j)
      const head = headFor(j, event.eventHash) as unknown as Record<string, unknown>
      mutate(head)
      await writeHead(j, head)

      await expect(readHead(j)).rejects.toThrow(pattern)
      await expect(readAll(j)).rejects.toThrow(pattern)
    })
  }

  it('rejects a non-canonical HEAD encoding', async () => {
    const j = journal()
    await appendFixture(j)
    const headPath = join(j.journalDir, 'HEAD')
    const head = JSON.parse(await readFile(headPath, 'utf8')) as JournalHead
    await writeFile(headPath, JSON.stringify(head, null, 2) + '\n')

    await expect(readHead(j)).rejects.toThrow(/HEAD does not use canonical JSON/)
  })

  it('rejects invalid append envelopes and payloads before touching disk', async () => {
    const invalidInputs: Array<{ label: string; input: Record<string, unknown> }> = [
      { label: 'empty event id', input: appendInput({ eventId: '' }) },
      { label: 'control event id', input: appendInput({ eventId: 'line\nbreak' }) },
      { label: 'timestamp', input: appendInput({ occurredAt: '2026-08-23T00:00:00Z' }) },
      { label: 'type', input: appendInput({ type: '' }) },
      { label: 'causation', input: appendInput({ causationId: '' }) },
      { label: 'correlation', input: appendInput({ correlationId: 1 }) },
      { label: 'actor', input: appendInput({ actor: ' ' }) },
      { label: 'null payload', input: appendInput({ payload: null }) },
      { label: 'array payload', input: appendInput({ payload: [] }) },
      { label: 'NaN payload', input: appendInput({ payload: { value: Number.NaN } }) },
      { label: 'negative-zero payload', input: appendInput({ payload: { value: -0 } }) },
      { label: 'undefined payload', input: appendInput({ payload: { value: undefined } }) },
      {
        label: 'sparse payload array',
        input: appendInput({ payload: { values: Array(2) } }),
      },
      { label: 'unknown envelope field', input: { ...appendInput(), unexpected: true } },
    ]

    for (const { label, input } of invalidInputs) {
      const j = journal('run-a', `append-${label.replaceAll(' ', '-')}`)
      await expect(append(j, input as never), label).rejects.toThrow(/journal: append/)
      expect(await stat(j.journalDir).catch(() => null)).toBeNull()
    }
  })

  it('rejects cyclic, accessor-backed, and Proxy append inputs before touching disk', async () => {
    const cyclicPayload: Record<string, unknown> = {}
    cyclicPayload['self'] = cyclicPayload

    const accessorInput = appendInput()
    Object.defineProperty(accessorInput, 'eventId', {
      enumerable: true,
      get: () => 'event-from-getter',
    })
    const cases: Array<{ name: string; input: unknown }> = [
      { name: 'cycle', input: appendInput({ payload: cyclicPayload }) },
      { name: 'accessor', input: accessorInput },
      { name: 'proxy', input: new Proxy(appendInput(), {}) },
    ]

    for (const { name, input } of cases) {
      const j = journal('run-a', `append-${name}`)
      await expect(append(j, input as never)).rejects.toThrow(/journal: append/)
      expect(await stat(j.journalDir).catch(() => null)).toBeNull()
    }
  })

  it('snapshots mutable append input and journal identity before the first await', async () => {
    const original = journal()
    const originalDir = original.journalDir
    const input = appendInput({ payload: { value: 1 } })
    const mutation = append(original, input)

    original.journalDir = join(root!, 'redirected')
    original.runId = 'redirected-run'
    input.eventId = 'mutated-event'
    ;(input.payload as { value: number }).value = Number.NaN

    const event = await mutation
    const [replayed] = await readAll({
      ...original,
      journalDir: originalDir,
      runId: 'run-a',
    })
    expect(event.eventId).toBe('event-1')
    expect(event.payload).toEqual({ value: 1 })
    expect(replayed).toEqual(event)
    expect(await stat(original.journalDir).catch(() => null)).toBeNull()
  })

  it('preserves JSON __proto__ payload keys without prototype mutation', async () => {
    const j = journal()
    const payload = JSON.parse('{"__proto__":{"polluted":true},"value":1}') as Record<
      string,
      unknown
    >
    await append(j, appendInput({ payload }))

    const [event] = await readAll(j)
    expect(Object.prototype).not.toHaveProperty('polluted')
    expect(event!.payload).toHaveProperty('__proto__')
  })
})
