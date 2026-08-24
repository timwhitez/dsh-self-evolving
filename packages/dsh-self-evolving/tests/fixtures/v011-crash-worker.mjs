import { appendFile, open } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { join } from 'node:path'
import {
  acquireLock,
  appendOnce,
  readAll,
  readControllerStatus,
  recoverV011OutcomeDerivation,
  recoverV011ProposalPublication,
} from '../../lib/index.js'

const [root, action, phase] = process.argv.slice(2)
const commitBoundaries = new Map([
  ['append-segment-write', 'segment-write'],
  ['append-segment-fsync', 'segment-fsync'],
  ['append-segment-directory-fsync', 'segment-directory-fsync'],
  ['append-head-staging-write', 'head-staging-write'],
  ['append-head-staging-fsync', 'head-staging-fsync'],
  ['append-head-rename', 'head-rename'],
  ['append-head-directory-fsync', 'head-directory-fsync'],
])
const phases = new Set([
  'before-entry',
  'during',
  'after-commit',
  'resume',
  'uninterrupted',
  ...commitBoundaries.keys(),
])
if (!root || !action || !phase || !phases.has(phase)) {
  throw new Error('usage: worker <root> <proposal|outcome> <callback or journal commit phase>')
}

const journal = {
  journalDir: join(root, 'journal'),
  runId: 'run-v011-recovery',
  segmentMaxBytes: phase === 'append-segment-directory-fsync' ? 1 : 1_000_000,
}
const lock = await acquireLock(journal, `v011-recovery-${action}-${phase}`)
let reconciliationStatus

await appendOnce(journal, {
  eventId: 'v011-recovery-bootstrap',
  occurredAt: '2026-08-24T00:00:00.000Z',
  type: 'run.preflight',
  causationId: null,
  correlationId: null,
  actor: 'v011-recovery',
  payload: {},
})

async function reconcile(identity) {
  if (phase === 'before-entry') process.kill(process.pid, 'SIGKILL')
  if (phase === 'during') {
    const marker = await open(join(root, 'callback-started.txt'), 'a', 0o600)
    try {
      await marker.writeFile(`${identity.reconciliationId}\n`)
      await marker.sync()
    } finally {
      await marker.close()
    }
    process.kill(process.pid, 'SIGKILL')
  }
  const crashBoundary = commitBoundaries.get(phase)
  const result = await appendOnce(
    journal,
    {
      eventId: identity.reconciliationId,
      occurredAt: '2026-08-24T00:00:00.000Z',
      type: 'v011.artifact.reconciled',
      causationId: identity.actionId,
      correlationId: null,
      actor: 'v011-recovery',
      payload: identity,
    },
    crashBoundary === undefined
      ? undefined
      : {
          afterBoundary(boundary) {
            if (boundary === crashBoundary) process.kill(process.pid, 'SIGKILL')
          },
        },
  )
  reconciliationStatus = result.status
  if (phase === 'after-commit') process.kill(process.pid, 'SIGKILL')
}

function digest(character) {
  return `sha256:${character.repeat(64)}`
}

function proposalBytes(proposalId) {
  const citation = (character) => ({
    objectDigest: digest(character),
    mediaType: 'application/json',
    locator: { kind: 'json-pointer', value: '/result' },
    observation: `observation-${character}`,
  })
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      proposalId,
      canonicalParentDigest: digest('1'),
      evidenceExport: { manifestDigest: digest('2'), merkleRoot: digest('3') },
      donorCandidates: [],
      analysisPath: 'analysis.json',
      hypothesis: 'A bounded change should improve the selected target mechanism.',
      evidenceCitations: [citation('4'), citation('5')],
      declaredOperations: [{ op: 'modify', path: 'src/index.ts' }],
      mechanismAssertions: ['the target mechanism changes'],
      preservationAssertions: ['unrelated behavior remains stable'],
      capabilityRequests: [],
    }) + '\n',
  )
}

try {
  let result
  if (action === 'proposal') {
    const proposalId = 'p_11111111111111111111111111111111'
    const recovered = await recoverV011ProposalPublication({
      path: join(root, 'proposal.json'),
      expectedProposalId: proposalId,
      async produce() {
        await appendFile(join(root, 'model-calls.txt'), 'call\n')
        return proposalBytes(proposalId)
      },
      afterDurablePublish: reconcile,
    })
    result = { status: recovered.status, digest: recovered.digest }
  } else if (action === 'outcome') {
    const recovered = await recoverV011OutcomeDerivation({
      path: join(root, 'outcome.json'),
      proposalDigest: digest('1'),
      hypothesis: 'One bounded retry changes the target observable after a transient failure.',
      candidateDigest: digest('2'),
      targetClusterSlug: 'transient-tool-stop',
      targetTaskHandle: 'opaque-1',
      trials: [
        {
          ref: digest('3'),
          role: 'target-baseline',
          status: 'fail',
          reward: 0,
          taskId: 'opaque-1',
          attemptIndex: 0,
        },
        {
          ref: digest('4'),
          role: 'target-child',
          status: 'pass',
          reward: 1,
          taskId: 'opaque-1',
          attemptIndex: 0,
        },
      ],
      afterDurablePublish: reconcile,
    })
    result = { status: recovered.status, record: recovered.record }
  } else {
    throw new Error(`unknown action ${action}`)
  }

  const events = await readAll(journal)
  const status = await readControllerStatus({ stateDir: root, runId: journal.runId })
  process.stdout.write(
    JSON.stringify({
      result,
      reconciliationStatus,
      events,
      controller: {
        eventCount: status.eventCount,
        stateHash: status.stateHash,
        head: status.head,
      },
    }) + '\n',
  )
} finally {
  await lock.release()
}
