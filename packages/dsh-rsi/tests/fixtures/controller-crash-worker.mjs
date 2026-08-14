/** Child process used by the Gate 3 SIGKILL/recovery acceptance test. */
import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { Context } from '@deepseek-ai/cordis'
import { recoverEvaluationAction } from '../../lib/index.js'
import * as RsiBundle from '../../lib/index.js'

const stateDir = process.argv[2]
const crashAt = process.argv[3]
if (stateDir === undefined || crashAt === undefined) {
  throw new Error('usage: controller-crash-worker <state-dir> <boundary|none>')
}

const providerPath = join(stateDir, 'provider.json')

async function readProvider() {
  try {
    return JSON.parse(await readFile(providerPath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function writeProvider(state, exclusive = false) {
  const file = await open(providerPath, exclusive ? 'wx' : 'w', 0o600)
  try {
    await file.writeFile(JSON.stringify(state) + '\n')
    await file.sync()
  } finally {
    await file.close()
  }
}

const provider = {
  async inspect(idempotencyKey) {
    const state = await readProvider()
    if (state === null) return { status: 'absent' }
    if (state.idempotencyKey !== idempotencyKey) {
      throw new Error('provider idempotency key conflict')
    }
    return { status: state.status, externalJobId: state.externalJobId }
  },
  async launch(idempotencyKey) {
    const state = {
      idempotencyKey,
      externalJobId: 'job-process-e2e',
      status: 'terminal',
      launchCount: 1,
      collectCount: 0,
    }
    await writeProvider(state, true)
    return { externalJobId: state.externalJobId }
  },
  async collect(externalJobId) {
    const state = await readProvider()
    if (state === null || state.externalJobId !== externalJobId) {
      throw new Error('provider collect missing job')
    }
    state.collectCount += 1
    await writeProvider(state)
    return {
      candidateId: 'c_process_e2e',
      taskId: 'task-process-e2e',
      attemptIndex: 0,
      status: 'pass',
      reward: 1,
      costUsd: 2,
    }
  },
}

const limits = {
  usd: 10,
  solverTokens: 1_000_000,
  proposerTokens: 1_000_000,
  taskTrials: 10,
  proposalCalls: 10,
  wallClockSec: 3600,
  concurrencySlots: 1,
  storageBytes: 1_000_000,
}

const ctx = new Context()
await ctx.plugin(RsiBundle, {
  stateDir,
  runId: 'run-process-crash-e2e',
  segmentMaxBytes: 1_000_000,
})
await recoverEvaluationAction(
  ctx.rsi,
  {
    actionId: 'action-process-e2e',
    idempotencyKey: 'key-process-e2e',
    reserveUsd: 3,
    budgetLedger: { ledgerPath: join(stateDir, 'budget.jsonl'), limits },
  },
  provider,
  {
    onDurableBoundary(boundary) {
      if (boundary === crashAt) process.kill(process.pid, 'SIGKILL')
    },
  },
)
await ctx.fiber.dispose()
