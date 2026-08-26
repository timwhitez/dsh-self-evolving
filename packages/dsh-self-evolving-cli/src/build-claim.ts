/**
 * Crash-safe staging claims for candidate builders (issue #71).
 *
 * Deterministic staging paths that merely fail when they already exist let a
 * single crash permanently poison every retry. A staging directory is now
 * CLAIMED atomically (exclusive mkdir) and stamped with a durable owner
 * intent (pid + process start ticks + build identity):
 *
 *  - a live, verified owner means another builder is genuinely running: BUSY;
 *  - a dead or foreign owner is quarantined aside (never deleted) and the
 *    caller retries the claim;
 *  - a claim-less directory is pre-intent crash residue with no complete
 *    result possible (publication is an atomic rename of a fully written
 *    tree), so it is likewise quarantined.
 */
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface BuildClaimIntent {
  pid: number
  processStartTicks: string
  generation?: number | undefined
  attempt?: number | undefined
  identity?: string | undefined
}

const INTENT_NAME = 'build-intent.json'

function currentStartTicks(): string | null {
  try {
    const raw = readFileSync(`/proc/${process.pid}/stat`, 'utf8')
    const suffix = raw
      .slice(raw.lastIndexOf(') ') + 2)
      .trim()
      .split(/\s+/)
    return suffix[19] ?? null
  } catch {
    return null
  }
}

async function processStartTicks(pid: number): Promise<string | null | 'ambiguous'> {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8')
    const suffix = raw
      .slice(raw.lastIndexOf(') ') + 2)
      .trim()
      .split(/\s+/)
    return suffix[19] ?? 'ambiguous'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ESRCH') return null
    return 'ambiguous'
  }
}

export async function claimStagingDir(
  stagingRoot: string,
  intentExtras: { generation?: number; attempt?: number; identity?: string } = {},
  quarantineParent?: () => Promise<string>,
): Promise<void> {
  const myTicks = currentStartTicks()
  if (myTicks === null) throw new Error('builder claim: cannot verify process identity')
  for (;;) {
    try {
      await mkdir(stagingRoot, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error(`builder claim: cannot claim ${stagingRoot}`, { cause: error })
      }
      // Someone claimed it first: BUSY only if provably alive.
      const owner = await readOwner(stagingRoot)
      if (owner !== null && (await ownerIsAlive(owner))) {
        throw new Error(`builder claim: another builder owns ${stagingRoot}`, { cause: error })
      }
      const quarantineRoot =
        quarantineParent !== undefined
          ? join(await quarantineParent(), `reclaimed-${randomUUID()}`)
          : `${stagingRoot}.reclaimed-${Date.now()}-${randomUUID()}`
      try {
        await rename(stagingRoot, quarantineRoot)
      } catch (renameError) {
        const code = (renameError as NodeJS.ErrnoException | null)?.code
        if (code !== 'ENOENT') {
          throw new Error(`builder claim: failed to quarantine ${stagingRoot}`, {
            cause: renameError,
          })
        }
      }
      continue
    }
    break
  }
  const intentRecord: {
    pid: number
    processStartTicks: string
    generation?: number
    attempt?: number
    identity?: string
  } = {
    pid: process.pid,
    processStartTicks: myTicks,
    ...(intentExtras.generation === undefined ? {} : { generation: intentExtras.generation }),
    ...(intentExtras.attempt === undefined ? {} : { attempt: intentExtras.attempt }),
    ...(intentExtras.identity === undefined ? {} : { identity: intentExtras.identity }),
  }
  const intent = JSON.stringify(
    intentRecord as {
      pid: number
      processStartTicks: string
      generation?: number | undefined
      attempt?: number | undefined
      identity?: string | undefined
    },
    null,
    2,
  )
  const file = await open(join(stagingRoot, INTENT_NAME), 'wx', 0o600)
  try {
    await file.writeFile(intent + '\n')
    await file.sync()
  } finally {
    await file.close()
  }
}

async function readOwner(stagingRoot: string): Promise<BuildClaimIntent | null> {
  try {
    const parsed = JSON.parse(await readFile(join(stagingRoot, INTENT_NAME), 'utf8')) as Record<
      string,
      unknown
    >
    if (typeof parsed['pid'] !== 'number' || typeof parsed['processStartTicks'] !== 'string') {
      return null
    }
    return {
      pid: parsed['pid'],
      processStartTicks: parsed['processStartTicks'],
      generation: typeof parsed['generation'] === 'number' ? parsed['generation'] : undefined,
      attempt: typeof parsed['attempt'] === 'number' ? parsed['attempt'] : undefined,
      identity: typeof parsed['identity'] === 'string' ? parsed['identity'] : undefined,
    }
  } catch {
    return null
  }
}

async function ownerIsAlive(owner: BuildClaimIntent): Promise<boolean> {
  const actual = await processStartTicks(owner.pid)
  if (actual === 'ambiguous') return true
  return actual === owner.processStartTicks
}

/** Remove our own claim marker once the staged tree is finalized or discarded. */
export async function clearBuildIntent(stagingRoot: string): Promise<void> {
  await rm(join(stagingRoot, INTENT_NAME), { force: true })
}
